-- Read-only proof that db/migrations/0008_race_status.sql is applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0008 is in schema_migrations" does not prove the objects match the file. This
-- fingerprints every definition the migration creates and compares it with the
-- fingerprint of a database built from the file itself. Run it against the
-- hosted database after applying (docs/deploy.md); every row must say ok = t.
--
-- It is ONE statement on purpose: Neon's SQL Editor shows only the last
-- statement's result, so there is no transaction wrapper around it - nothing
-- would show after a trailing COMMIT. It is read-only without one: a single
-- SELECT over catalogs, writing nothing. A missing table or constraint reads
-- as ok = f with an empty `actual`.
--
-- The expected values are pinned by an integration test
-- (src/app/api/race/live/route.integration.test.ts runs this file against a
-- freshly migrated database), so editing the migration without updating them
-- fails the suite.
--
-- The column row hashes each column's name, type, nullability, default and
-- identity generator, as db/verify/0007_board_heartbeats.sql does. On a
-- mismatch, compare `\d rig_race_status` (or information_schema.columns) with
-- the migration by eye.
--
-- It fingerprints only what 0008 created, so a later migration that adds to
-- the table (0009 adds rig_assignment_id and its foreign key) does not fail
-- it: the column row names 0008's columns, and the foreign key row is the one
-- on rig_id.

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0008_race_status.sql',
      (select version from schema_migrations where version = '0008_race_status.sql')
    ),
    (
      'race status columns',
      '787772ba583adc5e4212b368b65d03a3',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, ''),
                          is_identity, coalesce(identity_generation, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'rig_race_status'
         and column_name in (
           'rig_id', 'received_at', 'sampled_at', 'session_unique_id', 'session_num',
           'session_type', 'session_state', 'session_flags', 'session_time_remain_s',
           'session_laps_remain', 'car_idx', 'position', 'class_position', 'lap',
           'laps_completed', 'lap_dist_pct', 'gap_to_leader_s', 'last_lap_ms',
           'best_lap_ms', 'on_pit_road', 'incidents'))
    ),
    (
      'race status primary key',
      'PRIMARY KEY (rig_id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.rig_race_status') and contype = 'p')
    ),
    (
      'race status rig foreign key',
      'FOREIGN KEY (rig_id) REFERENCES rigs(id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = to_regclass('public.rig_race_status') and contype = 'f'
         and conname = 'rig_race_status_rig_id_fkey')
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;
