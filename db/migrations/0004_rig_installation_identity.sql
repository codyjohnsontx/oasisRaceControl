-- Oasis Race Control - which computer is claiming a rig (Phase 1).
--
-- A rig's bearer token is its whole identity: the backend looks the token up,
-- finds one rig, and credits every lap that arrives with it to whoever is
-- checked in there. Installing twenty-plus simulators by copying one machine's
-- folder to the next is how that stops being true - copy agent.config.json
-- along with the executable and two rigs share a token. Nothing errors. Both
-- machines heartbeat, both look healthy on the dashboard, and half the laps on
-- the leaderboard are the other customer's.
--
-- The agent now says which computer each heartbeat came from. These columns are
-- where that lands, and what lets the events API refuse to attribute a lap for
-- a rig two live installations are claiming (it holds the laps in the rig's own
-- outbox instead, so nothing is lost and they deliver themselves once each rig
-- has its own token).
--
-- ADDITIVE ONLY apart from replacing v_rig_status, which gains three columns and
-- changes no existing one. Safe to apply to a live venue database.

-- One owner for "recently enough to still count". Heartbeats are every 30s, so
-- three minutes is six missed ones: long enough that a rig restarting, or a
-- flush that ran long, is never mistaken for a second computer, and short
-- enough that a rig PC swapped out mid-shift is taken over before the next
-- customer sits down. Used by the takeover rule, by the events API, and by the
-- staff dashboard's view, so there is nowhere for the three to drift apart.
create function rig_installation_window() returns interval
  language sql immutable as $$ select interval '3 minutes' $$;

create function rig_installation_live(seen_at timestamptz) returns boolean
  language sql stable as
  $$ select seen_at is not null and seen_at > now() - rig_installation_window() $$;

alter table rigs
  -- The installation the backend currently considers this rig's, and when it
  -- was last heard from. A machine that has been quiet longer than the fleet's
  -- liveness window is not competing with anything, so the next installation to
  -- heartbeat simply takes the rig over: replacing or re-imaging a rig PC is
  -- ordinary venue maintenance and must not need a database edit.
  add column agent_installation_id text,
  add column agent_machine_name text,
  add column agent_installation_seen_at timestamptz,
  -- When a DIFFERENT installation was last seen claiming this rig while the
  -- recorded one was still live, and the names of the two computers. Read with
  -- a freshness window rather than cleared: once the second machine is given
  -- its own token and stops heartbeating here, the conflict ages out by itself.
  add column installation_conflict_at timestamptz,
  add column installation_conflict_detail text;

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
  r.agent_machine_name,
  -- Evaluated here, against the database's clock, so the dashboard never has to
  -- judge freshness from a browser's idea of the time.
  rig_installation_live(r.installation_conflict_at) as installation_conflict,
  r.installation_conflict_detail,
  ra.id as assignment_id,
  ra.started_at as assignment_started_at,
  d.id as driver_id,
  d.display_name as driver_name
from rigs r
left join rig_assignments ra on ra.rig_id = r.id and ra.ended_at is null
left join drivers d on d.id = ra.driver_id
order by r.rig_number;
