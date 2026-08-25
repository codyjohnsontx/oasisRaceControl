-- Oasis Race Control - why a lap went unclaimed.
--
-- 0003 made a lap nobody can be credited with representable: no driver, no
-- assignment, invalid with reason UNATTRIBUTED. Ingestion (attributeLap in
-- apps/web/src/app/api/agent/events/route.ts) reaches that state for four
-- different reasons and, until now, stored all four identically. The reason
-- survived only as a server log line, and the ordinary one was not logged at
-- all. At the counter the four are not interchangeable: "drove before
-- scanning" is the customer's explanation and there is nothing to fix, while a
-- lap driven outside the assignment it names means a rig's clock has drifted or
-- the rig was offline while the seat changed hands, and that rig needs
-- attention. Nobody could tell those apart from the row, so /staff hedged
-- across all four.
--
-- The cause now lives on the lap. Additive: one enum, one nullable column, one
-- check constraint, and a backfill for the rows that predate it.

-- Lowercase labels, matching assignment_end_reason and the names ingestion
-- already uses in code, so the route writes the value it decided verbatim. A
-- new type rather than more invalid_reason labels: every one of these laps is
-- invalid for the same reason, UNATTRIBUTED, and the cause answers a different
-- question. Unlike 0003's ADD VALUE, a type created in this transaction can be
-- used as a literal in it, so the backfill below is safe under the migration
-- runner's per-file transaction.
create type unattributed_cause as enum (
  -- The agent said nobody was checked in. Ordinary venue life.
  'nobody_checked_in',
  -- The agent predates the rigAssignmentId field and cannot say who was.
  'agent_sends_no_assignment_id',
  -- The stamp names an assignment this rig has never held.
  'unknown_assignment',
  -- A real assignment of this rig, but the lap's completedAt falls outside its
  -- window: a drifted rig clock, or a rig offline while the seat changed hands.
  'outside_assignment_window',
  -- Stored before this column existed. Ingestion never writes this label;
  -- only the backfill below does.
  'not_recorded'
);

alter table laps add column unattributed_cause unattributed_cause;

-- Laps stored under 0003 had a cause nobody kept. Backfilled explicitly rather
-- than exempted (a NOT VALID constraint would hold for new rows only): after
-- this every unattributed row says why, and "it was not recorded" is the honest
-- answer for these. Attributed rows stay null, which is what the constraint
-- below demands of them.
update laps set unattributed_cause = 'not_recorded' where driver_id is null;

-- Same discipline as laps_unattributed_is_invalid: the database, not the
-- ingestion route, says an unattributed lap always carries a cause and an
-- attributed lap never does. A lap with a driver and a cause, or with neither,
-- is unrepresentable.
alter table laps add constraint laps_unattributed_has_cause
  check ((driver_id is null) = (unattributed_cause is not null));
