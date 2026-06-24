-- =========================================================
-- 1. Schedule advance_timed_out as pg_cron job (Bug 1)
-- =========================================================
select cron.unschedule('advance-timed-out')
where exists (select 1 from cron.job where jobname = 'advance-timed-out');

select cron.schedule(
  'advance-timed-out',
  '* * * * *',
  'select advance_timed_out()'
);

-- =========================================================
-- 2. forfeit_match: 20s server-side grace guard (Bug 2)
--    Blocks instant-forfeit on momentary disconnects.
-- =========================================================
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  r_win           int;
  r_lose          int;
  e_win           numeric;
  k               int;
  d_win           int;
  win_games       int;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  -- Require ≥20s since current question started to prevent
  -- instant-forfeit on brief disconnects.
  if m.question_started_at is not null
     and now() < m.question_started_at + interval '20 seconds' then
    raise exception 'too early to forfeit — grace period not elapsed';
  end if;

  if present_player = m.player_a then
    quitter := m.player_b; r_win := m.elo_a_before; r_lose := m.elo_b_before;
  else
    quitter := m.player_a; r_win := m.elo_b_before; r_lose := m.elo_a_before;
  end if;

  if not m.is_rated then
    update matches set status='abandoned', ended_at=now(), winner_id=present_player
    where id = p_match_id;
    return;
  end if;

  select matches_played into win_games from profiles where id = present_player;
  k     := case when win_games < 30 then 40 when r_win < 2000 then 24 else 16 end;
  e_win := 1.0 / (1.0 + power(10, (r_lose - r_win)::numeric / 400.0));
  d_win := greatest(1, round(k * (1.0 - e_win) * 1.0))::int;

  perform apply_rated_result(p_match_id, present_player, quitter, d_win);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- =========================================================
-- 3. ELO boosting guard: cap rated matches to 3/pair/day
--    Applied in try_match + accept_challenge (Logic 3)
-- =========================================================
create or replace function rated_pair_count_today(a uuid, b uuid)
returns int language sql stable security definer as $$
  select count(*)::int
  from matches
  where ((player_a = a and player_b = b) or (player_b = a and player_a = b))
    and is_rated = true
    and created_at > now() - interval '24 hours';
$$;

-- Revoke from clients — internal helper only
revoke execute on function rated_pair_count_today(uuid, uuid) from public, anon, authenticated;

create or replace function try_match()
returns uuid language plpgsql security definer as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  band         integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  select * into me
  from matchmaking_queue
  where user_id = auth.uid() and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= band
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  select array_agg(id) into q_ids from (
    (select id from questions where section='VARC'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='DILR'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='QUANT' and is_active order by random() limit 3)
  ) s;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids,
          me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
    set status='matched', match_id=new_match_id
    where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer as $$
declare
  ch       challenges%rowtype;
  q_ids    uuid[];
  new_id   uuid;
  host_elo int;
  me_elo   int;
begin
  select * into ch from challenges where code = p_code for update;
  if not found or ch.guest_id is not null or now() > ch.expires_at
     then raise exception 'challenge unavailable'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  select array_agg(id) into q_ids from (
    (select id from questions where section='VARC'  and is_active order by random() limit 3)
    union all (select id from questions where section='DILR'  and is_active order by random() limit 3)
    union all (select id from questions where section='QUANT' and is_active order by random() limit 3)
  ) s;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;

-- =========================================================
-- 4. get_leaderboard: add draws column (Bug 4)
-- =========================================================
drop function if exists get_leaderboard(int, int);

create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (
  rank         bigint,
  username     text,
  display_name text,
  elo          int,
  wins         int,
  losses       int,
  draws        int,
  avatar_url   text
)
language sql stable security definer as $$
  select
    rank() over (order by elo desc),
    username,
    display_name,
    elo,
    wins,
    losses,
    draws,
    avatar_url
  from profiles
  order by elo desc
  limit p_limit offset p_offset;
$$;

-- =========================================================
-- 5. Avatars storage bucket + policies (Bug 3)
-- =========================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "avatars_user_upload" on storage.objects;
drop policy if exists "avatars_user_update" on storage.objects;
drop policy if exists "avatars_user_delete" on storage.objects;

create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatars_user_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_user_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_user_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
