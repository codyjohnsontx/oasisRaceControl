-- Oasis Race Control - league night (Phase 2).
--
-- Wednesday league: a season is a run of weekly rounds; each round pins one
-- track/car combo for the night; the round's results roll up into season
-- standings.
--
-- ADDITIVE ONLY. This migration creates new types, tables, indexes and views.
-- It does not alter, drop, or reinterpret any existing table, so it is safe to
-- apply to a live venue database that already holds real laps.
--
-- ATTRIBUTION MODEL (the one design decision worth reading):
-- laps are NOT stamped with a round id. A round owns every lap that landed
-- inside its open window on its own combo - see v_league_round_laps, which is
-- the single source of that rule. Consequences, all of them wanted:
--   * the ingestion hot path (api/agent/events) keeps its existing shape;
--     `laps` stays the one source of truth for lap data.
--   * staff invalidating a lap immediately changes the round result and the
--     season standings, with no backfill.
--   * a closed round's window is frozen, so its results stop moving when the
--     next round starts.

create table leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table league_seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues (id) on delete cascade,
  name text not null,
  started_on date not null default venue_today(),
  ended_on date,
  created_at timestamptz not null default now(),
  constraint season_dates_ordered check (ended_on is null or ended_on >= started_on)
);

-- A league runs one season at a time; the open one is where new rounds land.
create unique index one_open_season_per_league
  on league_seasons (league_id) where ended_on is null;

create table league_rounds (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references league_seasons (id) on delete cascade,
  round_number int not null check (round_number > 0),
  name text,
  round_date date not null default venue_today(),
  -- The night's combo. Same identity rule as leaderboards and check-in
  -- validity: a null track_config compares equal to ''.
  track_name text not null,
  track_config text,
  car_name text not null,
  incident_limit int not null default 0 check (incident_limit >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (season_id, round_number),
  constraint round_window_ordered check (closed_at is null or closed_at > opened_at)
);

-- One round is open at a time venue-wide. That is what makes "the lap that
-- just landed belongs to tonight's round" unambiguous, and it matches how the
-- floor actually runs: one league night, ~20 rigs, one combo.
create unique index one_open_round_venue_wide
  on league_rounds ((closed_at is null)) where closed_at is null;
create index league_rounds_season_idx on league_rounds (season_id, round_number);

-- Who took part. Written by the ingestion path when a lap lands during an open
-- round, so a driver who showed up and binned every lap still appears in the
-- field (and still scores the participation point) instead of vanishing.
create table league_round_entries (
  round_id uuid not null references league_rounds (id) on delete cascade,
  driver_id uuid not null references drivers (id),
  joined_at timestamptz not null default now(),
  primary key (round_id, driver_id)
);
create index league_round_entries_driver_idx on league_round_entries (driver_id);

-- ---------------------------------------------------------------------------
-- The attribution rule, in one place. Every league query joins through this
-- view rather than re-deriving the window/combo predicate.
create view v_league_round_laps as
select
  r.id           as round_id,
  l.id           as lap_id,
  l.driver_id,
  l.rig_id,
  l.lap_number,
  l.lap_time_ms,
  l.incident_delta,
  l.is_valid,
  l.invalid_reason,
  l.completed_at
from league_rounds r
join laps l
  on l.completed_at >= r.opened_at
 and l.completed_at < coalesce(r.closed_at, 'infinity'::timestamptz)
 and l.track_name = r.track_name
 and coalesce(l.track_config, '') = coalesce(r.track_config, '')
 and l.car_name = r.car_name;
