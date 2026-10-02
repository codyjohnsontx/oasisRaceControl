-- Read-only proof that db/migrations/0010_race_unsigned_places.sql is applied
-- exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0010 is in schema_migrations" does not prove the table matches the file.
-- This fingerprints the one table the migration creates and compares it with
-- the fingerprint of a database built from the file itself. Run it against
-- the hosted database after applying (docs/deploy.md); every row must say
-- ok = t.
--
-- It is ONE statement on purpose, like 0009's: Neon's SQL Editor shows only
-- the last statement's result, so there is no transaction wrapper around it.
-- It is read-only without one: a single SELECT over catalogs. A missing table
-- reads as ok = f with an empty `actual`.
--
-- The expected values are pinned by an integration test
-- (src/lib/race-results.integration.test.ts runs this file against a freshly
-- migrated database), so editing the migration without updating them fails
-- the suite. The column row hashes each column's name, type, nullability and
-- default; the constraint row hashes every constraint's definition by name,
-- leaving out Postgres 18's NOT NULL rows (contype 'n'), as 0009's does. On a
-- mismatch, compare `\d league_race_unsigned_places` with the migration by eye.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0010_race_unsigned_places.sql',
      (select version from schema_migrations where version = '0010_race_unsigned_places.sql')
    ),
    (
      'unsigned places columns',
      'b2e4efbcbe66df30ab1abba829672c1f',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'league_race_unsigned_places')
    ),
    (
      'unsigned places constraints',
      '14013b8d4fa21f785d3ac3e9482c4fcc',
      (select md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' order by conname))
       from pg_constraint
       where conrelid = to_regclass('public.league_race_unsigned_places') and contype <> 'n')
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
