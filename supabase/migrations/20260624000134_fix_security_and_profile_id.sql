-- =========================================================
-- 1. Fix get_profile: restore id field so isOwn works
-- =========================================================
create or replace function get_profile(p_username text)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'curve', (
      select coalesce(jsonb_agg(
        jsonb_build_object('elo', rh.elo_after, 'at', rh.created_at, 'delta', rh.delta)
        order by rh.created_at
      ), '[]')
      from rating_history rh where rh.user_id = p.id
    )
  )
  from profiles p where p.username = p_username;
$$;

-- =========================================================
-- 2. Fix profiles_update RLS: block client writes to elo/stats
-- =========================================================
drop policy if exists profiles_update on profiles;

create policy profiles_update on profiles for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and elo            = (select elo            from profiles where id = auth.uid())
    and peak_elo       = (select peak_elo       from profiles where id = auth.uid())
    and wins           = (select wins           from profiles where id = auth.uid())
    and losses         = (select losses         from profiles where id = auth.uid())
    and draws          = (select draws          from profiles where id = auth.uid())
    and matches_played = (select matches_played from profiles where id = auth.uid())
  );

-- =========================================================
-- 3. Fix challenge_host_read RLS: close coalesce bypass
--    Open challenges (unclaimed, unexpired) readable by anyone with the code.
--    Claimed challenges readable only by host + guest.
-- =========================================================
drop policy if exists challenge_host_read on challenges;

create policy challenge_host_read on challenges for select
  using (
    auth.uid() = host_id
    or auth.uid() = guest_id
    or (guest_id is null and expires_at > now())
  );
