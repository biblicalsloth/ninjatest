-- Performance hardening (advisor-driven).
--
-- 1) RLS initplan: wrap auth.uid() in (select auth.uid()) so Postgres
--    evaluates it ONCE per query instead of once per row. Identical
--    semantics; large win on any table scan that touches these policies.
--    (Supabase linter 0003_auth_rls_initplan.)
--
-- 2) Covering indexes for foreign keys. Two of these are on hot read paths:
--      - match_answers(user_id): get_section_stats joins on it; without the
--        index it seq-scans the largest table (~9 rows/match/user).
--      - matches(player_b): get_recent_matches / get_profile_matches join with
--        `player_a = x OR player_b = x`; the existing (player_a, player_b)
--        composite cannot serve player_b alone, forcing a seq scan.
--    The rest clear advisor 0001 and speed up FK cascade/lookup at scale.

-- ── 1. RLS policy rewrites ───────────────────────────────────────────────

-- challenges
drop policy if exists challenge_host_insert on public.challenges;
create policy challenge_host_insert on public.challenges
  for insert to public
  with check ((select auth.uid()) = host_id);

drop policy if exists challenge_host_read on public.challenges;
create policy challenge_host_read on public.challenges
  for select to public
  using (
    ((select auth.uid()) = host_id)
    or ((select auth.uid()) = guest_id)
    or ((guest_id is null) and (expires_at > now()))
  );

-- match_answers
drop policy if exists answers_read on public.match_answers;
create policy answers_read on public.match_answers
  for select to public
  using (
    exists (
      select 1 from matches m
      where m.id = match_answers.match_id
        and ((select auth.uid()) = m.player_a or (select auth.uid()) = m.player_b)
    )
  );

-- matches
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches
  for select to public
  using ((select auth.uid()) = player_a or (select auth.uid()) = player_b);

-- matchmaking_queue
drop policy if exists queue_self on public.matchmaking_queue;
create policy queue_self on public.matchmaking_queue
  for all to public
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- profiles
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to public
  with check (id = (select auth.uid()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (
    (id = (select auth.uid()))
    and (elo            = (select p.elo            from profiles p where p.id = (select auth.uid())))
    and (peak_elo       = (select p.peak_elo       from profiles p where p.id = (select auth.uid())))
    and (wins           = (select p.wins           from profiles p where p.id = (select auth.uid())))
    and (losses         = (select p.losses         from profiles p where p.id = (select auth.uid())))
    and (draws          = (select p.draws          from profiles p where p.id = (select auth.uid())))
    and (matches_played = (select p.matches_played from profiles p where p.id = (select auth.uid())))
  );

-- rating_history
drop policy if exists rating_self_read on public.rating_history;
create policy rating_self_read on public.rating_history
  for select to public
  using (user_id = (select auth.uid()));

-- ── 2. Covering indexes for foreign keys ─────────────────────────────────
create index if not exists match_answers_user_id_idx     on public.match_answers (user_id);      -- hot: get_section_stats
create index if not exists matches_player_b_idx           on public.matches (player_b);            -- hot: recent/profile matches OR-join
create index if not exists match_answers_question_id_idx  on public.match_answers (question_id);
create index if not exists matches_winner_id_idx          on public.matches (winner_id);
create index if not exists challenges_host_id_idx         on public.challenges (host_id);
create index if not exists challenges_guest_id_idx        on public.challenges (guest_id);
create index if not exists challenges_match_id_idx        on public.challenges (match_id);
create index if not exists matchmaking_queue_match_id_idx on public.matchmaking_queue (match_id);
create index if not exists rating_history_match_id_idx    on public.rating_history (match_id);
