-- Read-only proof that db/migrations/0009_race_results.sql is applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0009 is in schema_migrations" does not prove the objects match the file. This
-- fingerprints every definition the migration creates and compares it with the
-- fingerprint of a database built from the file itself. Run it against the
-- hosted database after applying (docs/deploy.md); every row must say ok = t.
--
-- It is ONE statement on purpose: Neon's SQL Editor shows only the last
-- statement's result, so there is no transaction wrapper around it - nothing
-- would show after a trailing COMMIT. It is read-only without one: a single
-- SELECT over catalogs, writing nothing. A missing table, constraint or view
-- reads as ok = f with an empty `actual`.
--
-- The expected values are pinned by an integration test
-- (src/lib/race-results.integration.test.ts runs this file against a freshly
-- migrated database), so editing the migration without updating them fails
-- the suite.
--
-- Column rows hash each column's name, type, nullability and default; the
-- constraint rows hash every constraint's definition by name; the column 0009
-- adds to rig_race_status and its foreign key are compared as plain text,
-- since they are one line each; the view rows
-- hash pg_get_viewdef with runs of whitespace collapsed, so a server version
-- that re-indents it does not read as drift. On a mismatch, compare `\d
-- league_race_results`, `\d league_race_starts` and
-- `select pg_get_viewdef('v_league_race_results')` with the migration by eye.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0009_race_results.sql',
      (select version from schema_migrations where version = '0009_race_results.sql')
    ),
    (
      'race results columns',
      'da8f0e910dd7c0e09f4b4d6c5e17e904',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'league_race_results')
    ),
    (
      'race results constraints',
      '06f5a4bb2e16ecb34c9dafee3d291dff',
      (select md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' order by conname))
       from pg_constraint
       where conrelid = to_regclass('public.league_race_results'))
    ),
    (
      'race starts columns',
      '3a138788efe181001c44672fc497e462',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'league_race_starts')
    ),
    (
      'race starts constraints',
      '5877c17aeeded93e758442f213e7a455',
      (select md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' order by conname))
       from pg_constraint
       where conrelid = to_regclass('public.league_race_starts'))
    ),
    (
      'race status assignment column',
      'rig_assignment_id|uuid|YES|',
      (select concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'rig_race_status'
         and column_name = 'rig_assignment_id')
    ),
    (
      'race status assignment foreign key',
      'FOREIGN KEY (rig_assignment_id) REFERENCES rig_assignments(id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.rig_race_status')
         and conname = 'rig_race_status_rig_assignment_id_fkey')
    ),
    (
      'race session view',
      'b0f9d18fab984972cbc224c07ceb5da1',
      (select md5(regexp_replace(pg_get_viewdef(to_regclass('public.v_league_race_session')), '\s+', ' ', 'g')))
    ),
    (
      'race results view',
      '86028a3397483938bcd79ecf5bc5063b',
      (select md5(regexp_replace(pg_get_viewdef(to_regclass('public.v_league_race_results')), '\s+', ' ', 'g')))
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
