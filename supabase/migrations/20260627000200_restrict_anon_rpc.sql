-- Reduce RPC attack surface: remove anon EXECUTE on functions that require a
-- logged-in participant. These already reject anon internally via auth.uid()
-- checks, but anon has no legitimate reason to call them.
--
-- IMPORTANT: these functions are granted EXECUTE to PUBLIC, and every role
-- (incl. anon) inherits from PUBLIC. Revoking "from anon" alone is a no-op while
-- the PUBLIC grant stands, so we revoke from PUBLIC and re-grant to the roles
-- that legitimately need it (authenticated + service_role).
--
-- anon EXECUTE is intentionally LEFT in place (via PUBLIC) on the public-read
-- RPCs that power the logged-out leaderboard / profile pages:
--   get_leaderboard, get_profile, get_profile_matches, get_recent_matches,
--   get_section_stats.

do $$
declare
  sig text;
  sigs text[] := array[
    'public.join_queue()',
    'public.leave_queue()',
    'public.start_match(uuid)',
    'public.submit_answer(uuid, smallint, smallint)',
    'public.forfeit_match(uuid)',
    'public.forfeit_match(uuid, uuid)',
    'public.accept_challenge(text)',
    'public.create_challenge(boolean)',
    'public.get_match_question(uuid, smallint)',
    'public.get_answer_reveal(uuid, smallint)'
  ];
begin
  foreach sig in array sigs loop
    execute format('revoke execute on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated, service_role', sig);
  end loop;
end $$;
