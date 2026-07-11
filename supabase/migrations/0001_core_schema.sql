-- Oasis Race Control — core schema (Phase 2).
-- Tables marked PROVISIONAL may be reshaped by a follow-up migration once the
-- Phase 1 iRacing spike findings land (docs/spike-findings.md). Everything else
-- is expected to be stable.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- The venue's local timezone; "tonight" on every leaderboard means this zone.
-- Single-venue product, so a constant is fine for now.
create or replace function venue_today() returns date
language sql stable as $$
  select (now() at time zone 'America/Chicago')::date
$$;

create type driver_status as enum ('active', 'banned', 'name_flagged');

create type assignment_end_reason as enum (
  'driver_ended', 'switched', 'takeover', 'staff_cleared', 'idle_timeout', 'moved'
);

create type invalid_reason as enum (
  'OFF_TRACK', 'INCIDENT_LIMIT_EXCEEDED', 'PIT_LANE_LAP', 'INCOMPLETE_LAP',
  'SESSION_RESET', 'WRONG_TRACK_CONFIGURATION', 'WRONG_CAR', 'WRONG_CAR_CLASS',
  'WRONG_SETUP_MODE', 'WRONG_CHALLENGE_CONFIGURATION', 'DUPLICATE_EVENT',
  'MANUALLY_INVALIDATED'
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  display_name citext not null unique,
  pin_hash text,
  is_guest boolean not null default false,
  status driver_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_has_no_pin check (not is_guest or pin_hash is null)
);

create table rigs (
  id uuid primary key default gen_random_uuid(),
  rig_number int not null unique check (rig_number > 0),
  display_name text not null,
  -- sha256 hex of the full bearer token; deterministic so lookup is by exact match
  agent_token_hash text unique,
  agent_version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- The printed QR encodes /r/<token>. Random slug, replaceable per rig without
-- reprinting every station.
create table rig_qr_tokens (
  token text primary key,
  rig_id uuid not null references rigs (id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table rig_assignments (
  id uuid primary key default gen_random_uuid(),
  rig_id uuid not null references rigs (id),
  driver_id uuid not null references drivers (id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason assignment_end_reason,
  constraint ended_has_reason check ((ended_at is null) = (end_reason is null))
);

-- The attribution invariant: at most one open assignment per rig and per driver.
create unique index one_open_assignment_per_rig
  on rig_assignments (rig_id) where ended_at is null;
create unique index one_open_assignment_per_driver
  on rig_assignments (driver_id) where ended_at is null;
create index rig_assignments_driver_idx on rig_assignments (driver_id, started_at desc);

-- PROVISIONAL: real iRacing session identity fields come from the spike.
create table sim_sessions (
  id uuid primary key default gen_random_uuid(),
  rig_id uuid not null references rigs (id),
  external_session_key text,
  track_name text,
  track_config text,
  car_name text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- PROVISIONAL: column details (session identity, validity signals) may change
-- with spike findings. event_id is the idempotency key — the unique index is
-- what makes retried submissions harmless.
create table laps (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  rig_id uuid not null references rigs (id),
  rig_assignment_id uuid not null references rig_assignments (id),
  driver_id uuid not null references drivers (id),
  sim_session_id uuid references sim_sessions (id),
  track_name text not null,
  track_config text,
  car_name text not null,
  lap_number int,
  lap_time_ms int not null check (lap_time_ms > 0),
  incident_delta int,
  is_valid boolean not null,
  invalid_reason invalid_reason,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint invalid_has_reason check (is_valid = (invalid_reason is null))
);

create index laps_driver_idx on laps (driver_id, completed_at desc);
create index laps_tonight_idx on laps (is_valid, completed_at desc);
create index laps_combo_idx on laps (track_name, car_name, is_valid, lap_time_ms);

create table staff_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  staff_user_id uuid references staff_users (user_id),
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Tonight's featured combo — what "Fastest Tonight" ranks. Staff set one per date.
create table featured_combos (
  combo_date date primary key,
  track_name text not null,
  track_config text,
  car_name text not null,
  incident_limit int not null default 0
);

create table pin_attempts (
  driver_id uuid primary key references drivers (id) on delete cascade,
  fail_count int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Atomic check-in. Closing the driver's old assignment, taking over the rig's
-- current one, and opening the new one must happen in one transaction, with
-- row locks so two phones scanning at once can't both win. Laps are never
-- touched — closed assignments keep their history.

create or replace function checkin_driver(
  p_driver_id uuid,
  p_rig_id uuid,
  p_confirm_move boolean default false,
  p_confirm_takeover boolean default false
) returns jsonb
language plpgsql
as $$
declare
  v_current record;   -- this driver's open assignment (possibly on another rig)
  v_occupant record;  -- the target rig's open assignment (possibly another driver)
  v_needs jsonb := '{}'::jsonb;
  v_assignment_id uuid;
begin
  select ra.id, ra.rig_id, r.rig_number
    into v_current
    from rig_assignments ra
    join rigs r on r.id = ra.rig_id
    where ra.driver_id = p_driver_id and ra.ended_at is null
    for update of ra;

  select ra.id, ra.driver_id, d.display_name as driver_name
    into v_occupant
    from rig_assignments ra
    join drivers d on d.id = ra.driver_id
    where ra.rig_id = p_rig_id and ra.ended_at is null
    for update of ra;

  if v_occupant.id is not null and v_occupant.driver_id = p_driver_id then
    return jsonb_build_object('status', 'already_checked_in', 'assignmentId', v_occupant.id);
  end if;

  if v_current.id is not null and v_current.rig_id <> p_rig_id and not p_confirm_move then
    v_needs := v_needs
      || jsonb_build_object('move', jsonb_build_object('fromRigNumber', v_current.rig_number));
  end if;
  if v_occupant.id is not null and not p_confirm_takeover then
    v_needs := v_needs
      || jsonb_build_object('takeover', jsonb_build_object('currentDriverName', v_occupant.driver_name));
  end if;
  if v_needs <> '{}'::jsonb then
    return jsonb_build_object('status', 'needs_confirmation', 'needs', v_needs);
  end if;

  if v_current.id is not null and v_current.rig_id <> p_rig_id then
    update rig_assignments set ended_at = now(), end_reason = 'moved' where id = v_current.id;
  end if;
  if v_occupant.id is not null then
    update rig_assignments set ended_at = now(), end_reason = 'takeover' where id = v_occupant.id;
  end if;

  insert into rig_assignments (rig_id, driver_id)
  values (p_rig_id, p_driver_id)
  returning id into v_assignment_id;

  return jsonb_build_object('status', 'checked_in', 'assignmentId', v_assignment_id);
end;
$$;

revoke execute on function checkin_driver(uuid, uuid, boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Views (owned by postgres, run with owner privileges — they are the only
-- surface the anon key can read besides laps/rig_assignments realtime rows).

-- Best valid lap per active driver tonight. If staff set a featured combo for
-- today, only matching laps rank; otherwise all of tonight's valid laps do.
create view v_fastest_tonight as
select distinct on (l.driver_id)
  l.driver_id,
  d.display_name,
  l.lap_time_ms,
  l.track_name,
  l.track_config,
  l.car_name,
  l.completed_at
from laps l
join drivers d on d.id = l.driver_id
where l.is_valid
  and d.status = 'active'
  and (l.completed_at at time zone 'America/Chicago')::date = venue_today()
  and (
    not exists (select 1 from featured_combos fc where fc.combo_date = venue_today())
    or exists (
      select 1 from featured_combos fc
      where fc.combo_date = venue_today()
        and fc.track_name = l.track_name
        and coalesce(fc.track_config, '') = coalesce(l.track_config, '')
        and fc.car_name = l.car_name
    )
  )
order by l.driver_id, l.lap_time_ms asc;

create view v_rig_status as
select
  r.id as rig_id,
  r.rig_number,
  r.display_name,
  r.agent_version,
  r.last_seen_at,
  ra.id as assignment_id,
  ra.started_at as assignment_started_at,
  d.id as driver_id,
  d.display_name as driver_name
from rigs r
left join rig_assignments ra on ra.rig_id = r.id and ra.ended_at is null
left join drivers d on d.id = ra.driver_id
order by r.rig_number;

-- ---------------------------------------------------------------------------
-- Row-level security. Service role (API routes) bypasses RLS; the anon key can
-- only read what is explicitly opened up here.

alter table drivers enable row level security;
alter table rigs enable row level security;
alter table rig_qr_tokens enable row level security;
alter table rig_assignments enable row level security;
alter table sim_sessions enable row level security;
alter table laps enable row level security;
alter table staff_users enable row level security;
alter table audit_log enable row level security;
alter table featured_combos enable row level security;
alter table pin_attempts enable row level security;

-- Laps and assignments carry no personal data (display names live in drivers,
-- which stays closed). Anon read enables Realtime change feeds on the TV,
-- portal, and check-in pages.
create policy laps_public_read on laps for select to anon, authenticated using (true);
create policy assignments_public_read on rig_assignments for select to anon, authenticated using (true);
create policy featured_combos_public_read on featured_combos for select to anon, authenticated using (true);

grant select on v_fastest_tonight to anon, authenticated;
grant select on v_rig_status to anon, authenticated;

-- Realtime change feeds for live UI updates.
alter publication supabase_realtime add table laps;
alter publication supabase_realtime add table rig_assignments;
