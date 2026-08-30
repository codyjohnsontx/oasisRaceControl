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
-- check constraint, a backfill for the rows that predate it, and a before-insert
-- trigger that keeps the previous deployment's ingestion working between
-- migrate and deploy.
--
-- Lock window, measured. ADD COLUMN takes ACCESS EXCLUSIVE on laps, and the
-- runner applies each file in one transaction (apps/web/scripts/migrate.ts), so
-- that lock is held through the backfill and the constraint's scan until this
-- file commits. Measured on two machines against a 252,500-lap table (2,500
-- ownerless, ~150 MB, Postgres 17) - roughly twice the venue's table today -
-- once with a single concurrent inserter and once with eight: the file applied
-- in roughly 0.12-0.33 s, and lap inserts running against it throughout waited
-- roughly 0.08-0.32 s at worst and then succeeded. Those figures are
-- machine-dependent and widen with the number of writers, so read them as an
-- envelope rather than a budget. What did not vary: across roughly 8,000
-- concurrent ownerless inserts nothing failed - an insert queues on the lock
-- rather than erroring, because the app pool sets no statement or query timeout
-- (apps/web/src/lib/db.ts) - and every row landing after the commit was filled
-- with not_recorded by the trigger below. Apply before deploying the code
-- (docs/deploy.md), while the rigs are quiet if you can.
--
-- Do not split this file to shorten that window. Bounded transactions per step,
-- or a NOT VALID constraint validated afterwards, are not a gentler version of
-- it - they are a broken one. The previous deployment is still writing
-- ownerless laps with no cause (the reason the trigger below exists), so
-- outside one transaction those rows land between the backfill and the
-- constraint, and the constraint is then rejected against its own table.
-- Reproduced by running these same statements under that load with the
-- transaction removed.

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
  -- The writer recorded no cause: laps from before this column existed (the
  -- backfill below), and laps a deployment older than this column writes
  -- between migrate and deploy (the trigger below). The current ingestion
  -- never writes this label.
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

-- The deploy order is migrate first, then deploy (docs/deploy.md), and a
-- database ahead of the code must stay harmless. The previous deployment's
-- ingestion inserts an ownerless lap with no cause, which the constraint above
-- would reject: every unclaimed lap would bounce back to the rig's outbox until
-- the new code landed, and a rollback would reopen that hole indefinitely. So a
-- missing cause on an ownerless INSERT is filled with not_recorded, which is
-- exactly what it is - the writer recorded none. Insert only, deliberately: an
-- update that nulls a cause is a mistake the constraint still catches, and an
-- owned lap given a cause is a contradiction that is never papered over.
create function laps_default_unattributed_cause() returns trigger
language plpgsql as $$
begin
  if new.driver_id is null and new.unattributed_cause is null then
    new.unattributed_cause := 'not_recorded';
  end if;
  return new;
end
$$;

create trigger laps_default_unattributed_cause
  before insert on laps
  for each row execute function laps_default_unattributed_cause();
