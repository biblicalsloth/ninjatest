-- Security hardening: pin search_path on every SECURITY DEFINER function.
--
-- SECURITY DEFINER functions run as their owner (the table owner, which bypasses
-- RLS). If their search_path is mutable, a role able to create objects in an
-- earlier schema could shadow an unqualified reference and run code as the owner.
-- This is the Supabase linter's `function_search_path_mutable` warning.
--
-- We set `search_path = pg_catalog, public` (rather than '') so the existing
-- function bodies, which reference public tables/types unqualified, keep working
-- while built-in functions/operators always resolve from pg_catalog first.
--
-- Done generically so it covers all current functions and is safe to re-run.
do $$
declare
  r record;
begin
  for r in
    select p.oid,
           n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef            -- SECURITY DEFINER only
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = pg_catalog, public',
      r.nspname, r.proname, r.args
    );
  end loop;
end $$;
