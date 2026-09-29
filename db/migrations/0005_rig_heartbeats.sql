-- Oasis Race Control - every rig heartbeat, kept for the monitor.
--
-- Until now a RIG_HEARTBEAT only moved rigs.last_seen_at and agent_version, so
-- the one thing the server ever knew about a rig was "it answered recently".
-- The v2 heartbeat (heartbeatEvent in apps/web/src/lib/events.ts) says what
-- the agent can see - iRacing connected or not, the assignment its laps are
-- being stamped with, laps queued and refused, sign-in failures, its own CPU
-- and memory - and the rig monitor judges a rig from that, over time. So each
-- heartbeat is now a row.
--
-- Additive: one table, one index, one view. Nothing existing changes, and
-- rigs.last_seen_at keeps being updated, so v_rig_status and /staff read
-- exactly what they read before. A database ahead of the code is harmless (the
-- previous deployment never touches this table); a database behind it fails
-- every heartbeat with 500 until migrated, which the build gate refuses to
-- deploy (docs/deploy.md). No lock on any existing table is taken beyond the
-- foreign key's brief SHARE ROW EXCLUSIVE on rigs, which only a rigs update
-- waits on.
--
-- Nothing prunes this table yet. The monitor keeps seven days and prunes it
-- itself; until that lands, a rig heartbeating every minute adds about 1,440
-- rows a day, which Neon's free tier holds for a long time.

create table rig_heartbeats (
  id bigint generated always as identity primary key,
  rig_id uuid not null references rigs (id),
  -- The server's clock, and the only time the monitor judges freshness by.
  received_at timestamptz not null default now(),
  -- The rig's clock, as the agent read it when it sent the heartbeat.
  sent_at timestamptz,
  -- received_at - sent_at, computed by the ingestion route in the same
  -- statement that sets received_at. Positive means the rig's clock is behind.
  -- bigint, not int: a rig whose CMOS battery died boots into a year long gone,
  -- and that skew - the one most worth seeing - overflows an int past 24 days.
  clock_skew_ms bigint,
  agent_version text,
  process_started_at timestamptz,
  start_count int,
  sim_connected boolean,
  telemetry_faulted boolean,
  session_track text,
  session_config text,
  session_car text,
  -- The assignment the agent is stamping laps with right now, as the agent
  -- says it. Deliberately no foreign key: the agent can be wrong (a stale
  -- outbox against a rebuilt database), and a heartbeat saying so is exactly
  -- what the monitor wants stored, not refused.
  assignment_id uuid,
  pending_laps int,
  rejected_laps int,
  checkout text,
  sign_in_failures int,
  -- The goodbye an agent sends as it exits, so a clean shutdown and a power
  -- cut do not read the same.
  shutting_down boolean not null default false,
  -- Every other v2 field, as validated. Empty for a v1 heartbeat, which sends
  -- nothing but its version.
  payload jsonb not null default '{}'
);

-- id breaks a tie in received_at, so "latest" always names exactly one row.
create index rig_heartbeats_rig_recent
  on rig_heartbeats (rig_id, received_at desc, id desc);

-- One indexed lookup per rig, not `distinct on (rig_id)` over the whole table:
-- that walks every retained row and throws all but one per rig away, which at
-- 25 rigs and seven days of minute heartbeats is ~250,000 rows read (with their
-- heap pages) on every evaluation to return 25. This form reads one index entry
-- and one row per rig however much history is kept. A rig that has never sent
-- a heartbeat has no row here, not a row of nulls.
create view v_rig_latest_heartbeat as
select latest.*
from rigs r
cross join lateral (
  select h.*
  from rig_heartbeats h
  where h.rig_id = r.id
  order by h.received_at desc, h.id desc
  limit 1
) latest;
