-- ============================================================================
-- Lock the data tables to the backend (service_role) only.
-- Run in: Supabase dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- BEFORE RUNNING: confirm Railway's SUPABASE_SERVICE_KEY is the service_role
-- key (see step 1). If Railway is using the anon key, this WILL break the app.
-- ============================================================================

-- 1. Revoke the public-facing roles from every data table.
revoke all on table public.profiles                from anon, authenticated;
revoke all on table public.reminders                from anon, authenticated;
revoke all on table public.user_profiles            from anon, authenticated;
revoke all on table public.google_tokens            from anon, authenticated;
revoke all on table public.pending_profile_changes  from anon, authenticated;

-- Also revoke on the schema itself, so nothing new is reachable by default.
revoke all on schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- 2. Drop the permissive policies. RLS with NO policy denies every role that
--    does not bypass it; service_role bypasses RLS, so the backend is unaffected.
drop policy if exists "Allow all" on public.profiles;
drop policy if exists "Allow all" on public.reminders;
drop policy if exists "Allow all" on public.user_profiles;
drop policy if exists "Allow all" on public.google_tokens;
drop policy if exists "Allow all" on public.pending_profile_changes;

-- 3. Make sure the backend keeps full access.
grant all on table public.profiles                to service_role;
grant all on table public.reminders                to service_role;
grant all on table public.user_profiles            to service_role;
grant all on table public.google_tokens            to service_role;
grant all on table public.pending_profile_changes  to service_role;

-- 4. RLS stays on everywhere.
alter table public.profiles                enable row level security;
alter table public.reminders                enable row level security;
alter table public.user_profiles            enable row level security;
alter table public.google_tokens            enable row level security;
alter table public.pending_profile_changes  enable row level security;

-- 5. Verify. Expect relrowsecurity = true on all five, and zero policies.
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       count(p.polname)     as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('profiles','reminders','user_profiles','google_tokens','pending_profile_changes')
group by c.relname, c.relrowsecurity
order by c.relname;

-- 6. Verify no grants remain for anon/authenticated. Expect ZERO rows.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon','authenticated')
  and table_name in ('profiles','reminders','user_profiles','google_tokens','pending_profile_changes')
order by table_name, grantee;
