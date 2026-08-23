-- Oasis Race Control - rig telemetry health on the staff dashboard (Phase 1).
--
-- A rig that cannot read its simulator looks exactly like a rig between
-- customers: the agent heartbeats, the machine is online, and no lap arrives.
-- Across twenty-plus rigs that is the failure nobody notices until the
-- leaderboard is visibly missing a night. The agent already works this out per
-- attach (apps/rig-agent .. TelemetryChannels) and says so on the rig's own
-- screen; these columns are what carry it to whoever is on shift.
--
-- ADDITIVE ONLY apart from replacing v_rig_status, which gains two columns and
-- changes no existing one. Safe to apply to a live venue database.
--
-- sim_health is a LIVE READING, not a fact about the rig. It is replaced by
-- every heartbeat and set to null by an agent that does not report it, so an
-- older agent reads as "unknown" rather than leaving a stale verdict on the
-- board. Freshness is last_seen_at's job - a rig that stopped heartbeating is
-- already shown as offline.

create type rig_sim_health as enum (
  -- iRacing is running and every channel a lap's validity turns on is readable.
  'scoring',
  -- iRacing is running but this rig cannot judge a lap from it, so it is
  -- keeping laps back rather than publishing times it cannot vouch for.
  -- sim_health_detail names the channels.
  'unreadable',
  -- No simulator to read: iRacing is closed, loading, or sitting in a menu.
  -- The normal state of an idle rig, not a fault.
  'no_sim'
);

alter table rigs
  add column sim_health rig_sim_health,
  add column sim_health_detail text;

drop view v_rig_status;

create view v_rig_status as
select
  r.id as rig_id,
  r.rig_number,
  r.display_name,
  r.agent_version,
  r.last_seen_at,
  r.sim_health,
  r.sim_health_detail,
  ra.id as assignment_id,
  ra.started_at as assignment_started_at,
  d.id as driver_id,
  d.display_name as driver_name
from rigs r
left join rig_assignments ra on ra.rig_id = r.id and ra.ended_at is null
left join drivers d on d.id = ra.driver_id
order by r.rig_number;
