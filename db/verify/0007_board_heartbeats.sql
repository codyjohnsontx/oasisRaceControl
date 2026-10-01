-- Read-only proof that db/migrations/0007_board_heartbeats.sql is applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0007 is in schema_migrations" does not prove the objects match the file. This
-- fingerprints every definition the migration creates and compares it with the
-- fingerprint of a database built from the file itself. Run it against the
-- hosted database after applying (docs/deploy.md); every row must say ok = t.
--
-- It is ONE statement on purpose: Neon's SQL Editor shows only the last
-- statement's result, so there is no transaction wrapper around it - nothing
-- would show after a trailing COMMIT. It is read-only without one: a single
-- SELECT over catalogs, writing nothing. A missing table, index or constraint
-- reads as ok = f with an empty `actual`.
--
-- The expected values are pinned by an integration test
-- (src/lib/monitor/monitor.integration.test.ts runs this file against a
-- freshly migrated database), so editing the migration without updating them
-- fails the suite.
--
-- The column rows hash each column's name, type, nullability, default and
-- identity generator, as db/verify/0006_monitor.sql does.
--
-- On a mismatch, `actual` shows what the database holds; for the hashed
-- column rows, compare `\d board_heartbeats` / `\d monitor_state` (or
-- information_schema.columns) with the migration by eye.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0007_board_heartbeats.sql',
      (select version from schema_migrations where version = '0007_board_heartbeats.sql')
    ),
    (
      'board columns',
      '776d833c8ae6b6c969e1df63e1ab4906',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''),
                          is_identity, coalesce(identity_generation, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'board_heartbeats')
    ),
    (
      'board primary key',
      'PRIMARY KEY (board_id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.board_heartbeats') and contype = 'p')
    ),
    (
      'board mode check',
      'CHECK ((mode = ANY (ARRAY[''rotation''::text, ''event''::text])))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.board_heartbeats') and conname = 'board_heartbeats_mode_check')
    ),
    (
      'board feed failures check',
      'CHECK ((feed_failures >= 0))',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.board_heartbeats')
         and conname = 'board_heartbeats_feed_failures_check')
    ),
    (
      'board recent index',
      'CREATE INDEX board_heartbeats_recent ON public.board_heartbeats USING btree (last_seen_at DESC)',
      (select pg_get_indexdef(to_regclass('public.board_heartbeats_recent')))
    ),
    (
      'state event mode columns',
      'fdb5e09116761b7bbf111484d54f4bae',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''),
                          is_identity, coalesce(identity_generation, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'monitor_state'
         and column_name in ('event_mode', 'event_mode_changed_at'))
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
