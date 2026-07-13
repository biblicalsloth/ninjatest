-- =========================================================
-- Portability bootstrap. On the hosted project these objects already exist
-- (pg_cron enabled via the dashboard; rls_auto_enable is a platform-created
-- function), so later migrations reference them without creating them — which
-- makes a clean `supabase db reset` / `db push` fail on a fresh (local) DB.
--
-- Both statements are prod-SAFE: idempotent and non-destructive. Versioned
-- 20260622000000 so it runs after the initial schema (001-003) but BEFORE the
-- first `cron.*` call (20260623065814) and the `rls_auto_enable` revoke
-- (20260627000100).
-- =========================================================

-- pg_cron: hosted has it; `if not exists` is a no-op there. Locally the
-- supabase/postgres image preloads it via shared_preload_libraries, so the
-- extension can be created.
create extension if not exists pg_cron;

-- rls_auto_enable(): a dashboard-created function on the hosted project. Create
-- a no-op stub ONLY when absent, so the real prod function is never overwritten
-- (a plain `create or replace` would clobber it). The only consumer is the
-- grant-hardening revoke in 20260627000100.
do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'rls_auto_enable'
      and pronamespace = 'public'::regnamespace
  ) then
    create function public.rls_auto_enable() returns void language sql as 'select';
  end if;
end $$;
