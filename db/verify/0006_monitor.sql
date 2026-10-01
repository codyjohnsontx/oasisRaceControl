-- Read-only proof that db/migrations/0006_monitor.sql is applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0006 is in schema_migrations" does not prove the objects match the file. This
-- fingerprints every definition the migration creates and compares it with the
-- fingerprint of a database built from the file itself. Run it against the
-- hosted database after applying (docs/deploy.md); every row must say ok = t.
--
-- It is ONE statement on purpose: Neon's SQL Editor shows only the last
-- statement's result, so there is no transaction wrapper around it - nothing
-- would show after a trailing COMMIT. It is read-only without one: a single
-- SELECT over catalogs and one seed row, writing nothing. A missing index or
-- constraint reads as ok = f with an empty `actual`; a missing monitor_state
-- table stops the query with "relation does not exist" - the migration is not
-- applied at all.
--
-- The expected values are pinned by an integration test
-- (src/lib/monitor/monitor.integration.test.ts runs this file against a
-- freshly migrated database), so editing the migration without updating them
-- fails the suite.
--
-- The column rows hash each column's name, type, nullability, default and
-- identity generator: a plain bigint id where the migration says `generated
-- always as identity` would pass every other check and then fail the first
-- alert insert.
--
-- On a mismatch, `actual` shows what the database holds; for the hashed
-- column rows, compare `\d monitor_alerts` / `\d monitor_state` (or
-- information_schema.columns) with the migration by eye.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0006_monitor.sql',
      (select version from schema_migrations where version = '0006_monitor.sql')
    ),
    (
      'alerts columns',
      '2683ff0947a3ceca9d8da13c075fa279',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''),
                          is_identity, coalesce(identity_generation, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'monitor_alerts')
    ),
    (
      'alerts primary key',
      'PRIMARY KEY (id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_alerts') and contype = 'p')
    ),
    (
      'alerts severity check',
      'CHECK ((severity = ANY (ARRAY[''urgent''::text, ''warning''::text])))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_alerts') and conname = 'monitor_alerts_severity_check')
    ),
    (
      'one open alert index',
      'CREATE UNIQUE INDEX monitor_alerts_one_open ON public.monitor_alerts USING btree (rule, subject) WHERE (resolved_at IS NULL)',
      (select pg_get_indexdef(to_regclass('public.monitor_alerts_one_open')))
    ),
    (
      'state columns',
      '01a58fe96f9204260caf27485218205e',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''),
                          is_identity, coalesce(identity_generation, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'monitor_state'
         -- The columns this migration creates: 0007 adds two more, which
         -- db/verify/0007_board_heartbeats.sql checks.
         and column_name in ('id', 'last_evaluated_at', 'last_routine_update_at',
                             'last_pruned_at', 'event_mode_override', 'override_set_by',
                             'override_expires_at', 'long_stint_minutes'))
    ),
    (
      'state primary key',
      'PRIMARY KEY (id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_state') and contype = 'p')
    ),
    (
      'state single row check',
      'CHECK ((id = 1))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_state') and conname = 'monitor_state_id_check')
    ),
    (
      'state override check',
      'CHECK ((event_mode_override = ANY (ARRAY[''on''::text, ''off''::text])))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_state') and conname = 'monitor_state_event_mode_override_check')
    ),
    (
      'state long stint check',
      'CHECK ((long_stint_minutes > 0))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_state') and conname = 'monitor_state_long_stint_minutes_check')
    ),
    (
      'state staff foreign key',
      'FOREIGN KEY (override_set_by) REFERENCES staff_users(id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.monitor_state') and contype = 'f')
    ),
    (
      'state row',
      '1',
      (select count(*)::text from monitor_state where id = 1)
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
