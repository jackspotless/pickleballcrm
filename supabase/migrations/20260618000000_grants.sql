-- Table-level privileges for the API roles.
--
-- RLS (enabled on every table) gates which ROWS each role may see/write; these
-- GRANTs are the table-level prerequisite without which EVERY policy-gated query
-- fails with "permission denied for table" before RLS is even evaluated. Issued
-- explicitly rather than relying on implicit Supabase default privileges (which
-- are not present for our migration-created tables in this setup).

grant usage on schema public to anon, authenticated;

-- anon: read-only. RLS still restricts anon to the public view-layer tables and
-- the public_* views; anon has no write capability at all.
grant select on all tables in schema public to anon;

-- authenticated: full DML. RLS policies + FK-value triggers gate which rows and
-- values each authenticated member may actually write.
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Future tables inherit the same grants (migrations run as this role).
alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
