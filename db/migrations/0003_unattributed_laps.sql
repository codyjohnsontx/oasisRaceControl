-- Oasis Race Control - laps nobody can be credited with.
--
-- A lap captured while the rig had no open assignment has no owner and never
-- will: the agent stamps each lap with the assignment it held at capture time
-- (docs/plan.md, event model), so there is no later moment at which the system
-- learns who drove it. Before this migration such a lap was refused and sat in
-- the rig's outbox forever, which on an unattended rig grows without bound.
--
-- It is now STORED, unattributed and invalid. The lap is real and the venue
-- keeps it; it simply belongs to nobody until a person says otherwise. Staff
-- attribution is a later piece of work - this migration only makes the state
-- representable and, more importantly, makes it impossible to rank.
--
-- SAFETY NOTE for whoever builds staff attribution: laps_attribution_all_or_none
-- below says a lap has a driver and an assignment or has neither. Attributing an
-- orphan therefore needs an assignment row to point at, or a deliberate
-- migration relaxing that constraint to allow a driver with no assignment. That
-- is a design decision, not an oversight - decide it there, not here.

-- Postgres allows ADD VALUE inside a transaction, but the new label cannot be
-- used as an enum literal until it commits. The constraint below therefore
-- compares invalid_reason::text, which never materialises the literal.
alter type invalid_reason add value if not exists 'UNATTRIBUTED';

alter table laps alter column driver_id drop not null;
alter table laps alter column rig_assignment_id drop not null;

-- Attribution is all or nothing. A lap with a driver but no assignment (or the
-- reverse) is a half-written attribution, and no code path should produce one.
alter table laps add constraint laps_attribution_all_or_none
  check ((driver_id is null) = (rig_assignment_id is null));

-- The teeth. An unattributed lap is invalid, and the database says so - not the
-- ingestion route, not a leaderboard's where-clause, not an inner join that a
-- future query might forget. Staff "restore" (api/staff/lap-validity) cannot
-- flip one of these to valid, because this constraint would reject the update.
alter table laps add constraint laps_unattributed_is_invalid
  check (
    driver_id is not null
    or (is_valid = false and invalid_reason::text = 'UNATTRIBUTED')
  );

-- The staff list of laps waiting to be attributed reads exactly this predicate.
create index laps_unattributed_idx on laps (completed_at desc) where driver_id is null;

-- ---------------------------------------------------------------------------
-- League attribution excludes unattributed laps at the source.
--
-- Every current consumer of this view inner-joins drivers, so a null driver_id
-- already falls out. That is a property of today's callers, not of the rule -
-- and this view is the one place the project says owns "which laps belong to a
-- round" (AGENTS.md). Encoding it here means a future consumer that forgets the
-- join still cannot pull an ownerless lap into a round.
create or replace view v_league_round_laps as
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
 and l.car_name = r.car_name
 and l.driver_id is not null;
