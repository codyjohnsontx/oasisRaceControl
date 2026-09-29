-- Read-only proof that db/migrations/0005_rig_heartbeats.sql is applied exactly.
--
-- The migration runner and the build gate compare filenames, never content, so
-- "0005 is in schema_migrations" does not prove the objects match the file. This
-- fingerprints every definition the migration creates and compares it with the
-- fingerprint of a database built from the file itself. Run it against the
-- hosted database after applying (docs/deploy.md); every row must say ok = t.
-- It cannot write: the transaction is read only, and it only reads catalogs.
--
-- The expected values are pinned by an integration test
-- (route.integration.test.ts runs this file against a freshly migrated
-- database), so editing the migration without updating them fails the suite.
--
-- On a mismatch, `actual` shows what the database holds; for the hashed rows,
-- compare `select pg_get_viewdef('v_rig_latest_heartbeat')` or `\d
-- rig_heartbeats` with the migration by eye. The view definition is
-- whitespace-normalised before hashing so a Postgres upgrade that only
-- re-indents pg_get_viewdef output does not read as drift.

begin transaction read only;

with fingerprints (check_name, expected, actual) as (
  values
    (
      'bookkeeping',
      '0005_rig_heartbeats.sql',
      (select version from schema_migrations where version = '0005_rig_heartbeats.sql')
    ),
    (
      'table columns',
      'a13f625d842781cddd11fd6af26311a8',
      (select md5(string_agg(
                concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, '')),
                ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'rig_heartbeats')
    ),
    (
      'primary key',
      'PRIMARY KEY (id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.rig_heartbeats'::regclass and contype = 'p')
    ),
    (
      'rig foreign key',
      'FOREIGN KEY (rig_id) REFERENCES rigs(id)',
      (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.rig_heartbeats'::regclass and contype = 'f')
    ),
    (
      'latest index',
      'CREATE INDEX rig_heartbeats_rig_recent ON public.rig_heartbeats USING btree (rig_id, received_at DESC, id DESC)',
      (select pg_get_indexdef('public.rig_heartbeats_rig_recent'::regclass))
    ),
    (
      'latest view',
      '222d322f45f8240817d396a8ca71f0cf',
      (select md5(regexp_replace(pg_get_viewdef('public.v_rig_latest_heartbeat'::regclass), '\s+', ' ', 'g')))
    ),
    (
      'latest view columns',
      'c6b362e936667c4008ad052fdedd5255',
      (select md5(string_agg(concat_ws('|', column_name, data_type), ',' order by ordinal_position))
       from information_schema.columns
       where table_schema = 'public' and table_name = 'v_rig_latest_heartbeat')
    )
)
select check_name, actual is not distinct from expected as ok, expected, actual
from fingerprints;

commit;
