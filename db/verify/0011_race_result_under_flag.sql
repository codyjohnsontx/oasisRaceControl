-- Read-only proof that db/migrations/0011_race_result_under_flag.sql is
-- applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0011 is in schema_migrations" does not prove the objects match the file.
-- This fingerprints the column the migration adds and the view it redefines,
-- and compares them with a database built from the file itself. Run it
-- against the hosted database after applying (docs/deploy.md); every row
-- must say ok = t.
--
-- It is ONE statement on purpose, like 0009's and 0010's: Neon's SQL Editor
-- shows only the last statement's result, so there is no transaction wrapper
-- around it. It is read-only without one: a single SELECT over catalogs. A
-- missing column or view reads as ok = f with an empty `actual`.
--
-- The expected values are pinned by an integration test
-- (src/lib/race-results.integration.test.ts runs this file against a freshly
-- migrated database), so editing the migration without updating them fails
-- the suite. The column row compares the column's name, type, nullability
-- and default as plain text, since it is one line; the view row hashes
-- pg_get_viewdef with runs of whitespace collapsed, so a server version that
-- re-indents it does not read as drift. v_league_race_session was created by
-- 0009 and is pinned here rather than there from this migration on. On a
-- mismatch, compare `\d league_race_results` and
-- `select pg_get_viewdef('v_league_race_session')` with the migration by eye.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0011_race_result_under_flag.sql',
      (select version from schema_migrations where version = '0011_race_result_under_flag.sql')
    ),
    (
      'race results final column',
      'final|boolean|NO|true',
      (select concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'league_race_results'
         and column_name = 'final')
    ),
    (
      'race session view',
      '5b70ef6e17947c3133ad6e63332fda5f',
      (select md5(regexp_replace(pg_get_viewdef(to_regclass('public.v_league_race_session')), '\s+', ' ', 'g')))
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
