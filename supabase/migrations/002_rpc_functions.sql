-- =========================================================
-- NINJATEST: All Server-Authoritative RPC Functions
-- =========================================================

-- =========================================================
-- MATCHMAKING: join_queue / leave_queue / try_match
-- =========================================================
create or replace function join_queue()
returns void language plpgsql security definer as $$
declare my_elo int;
begin
  select elo into my_elo from profiles where id = auth.uid();
  insert into matchmaking_queue(user_id, elo)
  values (auth.uid(), my_elo)
  on conflict (user_id) where status='waiting' do nothing;
  perform try_match(auth.uid());
end;
$$;

create or replace function leave_queue()
returns void language plpgsql security definer as $$
begin
  update matchmaking_queue set status='cancelled'
  where user_id = auth.uid() and status='waiting';
end;
$$;

create or replace function try_match(p_user_id uuid)
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
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= band
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

-- =========================================================
-- FRIEND CHALLENGES: create / accept
-- =========================================================
create or replace function create_challenge(p_is_rated boolean default true)
returns text language plpgsql security definer as $$
declare c text := encode(gen_random_bytes(4), 'hex');
begin
  insert into challenges(code, host_id, is_rated) values (c, auth.uid(), p_is_rated);
  return c;
end;
$$;

create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

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
-- MATCH START: flip pending → active, set first question timer
-- =========================================================
create or replace function start_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or m.status <> 'pending' then return; end if;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  update matches
  set status = 'active', started_at = now(), question_started_at = now()
  where id = p_match_id;
end;
$$;

-- =========================================================
-- GET QUESTION (strips correct_index / explanation)
-- =========================================================
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id uuid,
  section     cat_section,
  body        text,
  options     jsonb,
  cap_ms      integer,
  started_at  timestamptz
)
language plpgsql security definer as $$
declare
  m   matches%rowtype;
  q   questions%rowtype;
  cfg section_config%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config where section = q.section;

  return query select
    q.id,
    q.section,
    q.body,
    q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at;
end;
$$;

-- =========================================================
-- SUBMIT ANSWER (authoritative scoring)
-- =========================================================
create or replace function submit_answer(
  p_match_id       uuid,
  p_question_index smallint,
  p_selected_index smallint
)
returns void language plpgsql security definer as $$
declare
  m        matches%rowtype;
  q        questions%rowtype;
  cfg      section_config%rowtype;
  uid      uuid := auth.uid();
  is_a     boolean;
  cap      integer;
  taken_ms integer;
  correct  boolean;
  grace    integer;
  pts      integer;
begin
  select * into m from matches where id = p_match_id for update;

  if not found or m.status <> 'active' then raise exception 'match not active'; end if;
  if uid not in (m.player_a, m.player_b) then raise exception 'not a participant'; end if;
  if p_question_index <> m.current_index then raise exception 'stale question'; end if;
  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = uid and question_index = p_question_index
  ) then raise exception 'already answered'; end if;

  select * into q   from questions where id = m.question_ids[p_question_index + 1];
  select * into cfg from section_config where section = q.section;
  cap := coalesce(q.duration_ms, cfg.cap_ms);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  correct := (p_selected_index is not null and p_selected_index = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when correct                  then cfg.base_points + grace
    when p_selected_index is null then 0
    else                               -cfg.wrong_penalty
  end;

  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    p_selected_index, correct, pts, taken_ms
  );

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  perform maybe_advance(p_match_id, p_question_index);
end;
$$;

-- =========================================================
-- ADVANCE LOGIC
-- =========================================================
create or replace function maybe_advance(p_match_id uuid, p_index smallint)
returns void language plpgsql security definer as $$
declare
  m            matches%rowtype;
  all_answered boolean;
begin
  select count(distinct user_id) = 2 into all_answered
  from match_answers where match_id = p_match_id and question_index = p_index;

  if not all_answered then return; end if;

  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' or m.current_index <> p_index then return; end if;

  if p_index >= 8 then
    perform finalize_match(p_match_id);
  else
    update matches
    set current_index = p_index + 1, question_started_at = now()
    where id = p_match_id;
  end if;
end;
$$;

-- =========================================================
-- CRON SWEEP: force-advance timed-out questions (~every 1s)
-- =========================================================
create or replace function advance_timed_out()
returns void language plpgsql security definer as $$
declare
  r   record;
  cap integer;
begin
  for r in
    select m.*, q.section, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;

-- =========================================================
-- FINALIZE MATCH (outcome → ELO)
-- =========================================================
create or replace function finalize_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m          matches%rowtype;
  winner     uuid;
  loser      uuid;
  r_win      int;
  r_lose     int;
  e_win      numeric;
  base       numeric;
  factor     numeric;
  margin     int;
  k          int;
  d_win      int;
  win_games  int;
  F_MIN      constant numeric := 0.3;
  FULL_MARGIN constant numeric := 300;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status = 'completed' or m.status = 'abandoned' then return; end if;

  margin := abs(m.score_a - m.score_b);

  if not m.is_rated then
    update matches set status='completed', ended_at=now(),
      winner_id = case
        when m.score_a > m.score_b then m.player_a
        when m.score_b > m.score_a then m.player_b
        else null end
    where id = p_match_id;
    return;
  end if;

  if m.score_a = m.score_b then
    perform apply_draw(p_match_id);
    return;
  end if;

  if m.score_a > m.score_b then
    winner := m.player_a; loser := m.player_b;
    r_win  := m.elo_a_before; r_lose := m.elo_b_before;
  else
    winner := m.player_b; loser := m.player_a;
    r_win  := m.elo_b_before; r_lose := m.elo_a_before;
  end if;

  select matches_played into win_games from profiles where id = winner;
  k := case when win_games < 30 then 40 when r_win < 2000 then 24 else 16 end;

  e_win  := 1.0 / (1.0 + power(10, (r_lose - r_win)::numeric / 400.0));
  base   := k * (1.0 - e_win);
  factor := F_MIN + (1.0 - F_MIN) * least(margin::numeric / FULL_MARGIN, 1.0);
  d_win  := greatest(1, round(base * factor))::int;

  perform apply_rated_result(p_match_id, winner, loser, d_win);
end;
$$;

-- =========================================================
-- APPLY DRAW
-- =========================================================
create or replace function apply_draw(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m        matches%rowtype;
  k_a      int;
  k_b      int;
  e_a      numeric;
  e_b      numeric;
  d_a      int;
  d_b      int;
  a_after  int;
  b_after  int;
begin
  select * into m from matches where id = p_match_id for update;

  select case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into k_a from profiles where id = m.player_a;
  select case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into k_b from profiles where id = m.player_b;

  e_a := 1.0 / (1.0 + power(10, (m.elo_b_before - m.elo_a_before)::numeric / 400.0));
  e_b := 1.0 - e_a;

  d_a := round(k_a * (0.5 - e_a))::int;
  d_b := round(k_b * (0.5 - e_b))::int;

  a_after := greatest(100, m.elo_a_before + d_a);
  b_after := greatest(100, m.elo_b_before + d_b);

  update matches set status='completed', ended_at=now(), winner_id=null,
    elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set elo=a_after, peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1, draws=draws+1
  where id = m.player_a;

  update profiles set elo=b_after, peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1, draws=draws+1
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, m.elo_a_before, a_after, a_after - m.elo_a_before),
    (m.player_b, p_match_id, m.elo_b_before, b_after, b_after - m.elo_b_before);
end;
$$;

-- =========================================================
-- APPLY RATED RESULT (zero-sum, floor 100, stats + history)
-- =========================================================
create or replace function apply_rated_result(
  p_match_id uuid,
  p_winner   uuid,
  p_loser    uuid,
  p_delta    int
)
returns void language plpgsql security definer as $$
declare
  m       matches%rowtype;
  a_after int;
  b_after int;
begin
  select * into m from matches where id = p_match_id for update;

  if p_winner = m.player_a then
    a_after := m.elo_a_before + p_delta;
    b_after := greatest(100, m.elo_b_before - p_delta);
  else
    b_after := m.elo_b_before + p_delta;
    a_after := greatest(100, m.elo_a_before - p_delta);
  end if;

  update matches set status='completed', ended_at=now(), winner_id=p_winner,
    elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set
    elo=a_after,
    peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end)
  where id = m.player_a;

  update profiles set
    elo=b_after,
    peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end)
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, m.elo_a_before, a_after, a_after - m.elo_a_before),
    (m.player_b, p_match_id, m.elo_b_before, b_after, b_after - m.elo_b_before);
end;
$$;

-- =========================================================
-- FORFEIT (disconnect > grace → present player wins full margin)
-- =========================================================
create or replace function forfeit_match(p_match_id uuid, p_present_player uuid)
returns void language plpgsql security definer as $$
declare
  m       matches%rowtype;
  quitter uuid;
  r_win   int;
  r_lose  int;
  e_win   numeric;
  k       int;
  d_win   int;
  win_games int;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if p_present_player = m.player_a then
    quitter := m.player_b; r_win := m.elo_a_before; r_lose := m.elo_b_before;
  else
    quitter := m.player_a; r_win := m.elo_b_before; r_lose := m.elo_a_before;
  end if;

  if not m.is_rated then
    update matches set status='abandoned', ended_at=now(), winner_id=p_present_player
    where id = p_match_id;
    return;
  end if;

  select matches_played into win_games from profiles where id = p_present_player;
  k := case when win_games < 30 then 40 when r_win < 2000 then 24 else 16 end;
  e_win := 1.0 / (1.0 + power(10, (r_lose - r_win)::numeric / 400.0));
  d_win := greatest(1, round(k * (1.0 - e_win) * 1.0))::int;  -- factor=1.0 full margin

  perform apply_rated_result(p_match_id, p_present_player, quitter, d_win);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- =========================================================
-- LEADERBOARD + PROFILE READS
-- =========================================================
create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (
  rank       bigint,
  username   text,
  elo        int,
  wins       int,
  losses     int,
  avatar_url text
)
language sql stable security definer as $$
  select
    rank() over (order by elo desc)::bigint,
    username, elo, wins, losses, avatar_url
  from profiles
  order by elo desc
  limit p_limit offset p_offset;
$$;

create or replace function get_profile(p_username text)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'profile', to_jsonb(p) - 'id',
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
-- RECENT MATCHES FOR LOBBY
-- =========================================================
create or replace function get_recent_matches(p_limit int default 5)
returns table (
  match_id  uuid,
  opponent  text,
  opponent_avatar text,
  my_score  int,
  opp_score int,
  result    text,
  elo_delta int,
  played_at timestamptz
)
language plpgsql stable security definer as $$
declare uid uuid := auth.uid();
begin
  return query
  select
    m.id,
    case when m.player_a = uid then pb.username else pa.username end,
    case when m.player_a = uid then pb.avatar_url else pa.avatar_url end,
    case when m.player_a = uid then m.score_a else m.score_b end,
    case when m.player_a = uid then m.score_b else m.score_a end,
    case
      when m.winner_id = uid then 'win'
      when m.winner_id is null then 'draw'
      else 'loss'
    end,
    case
      when m.player_a = uid then coalesce(m.elo_a_after - m.elo_a_before, 0)
      else coalesce(m.elo_b_after - m.elo_b_before, 0)
    end,
    m.ended_at
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where uid in (m.player_a, m.player_b)
    and m.status in ('completed', 'abandoned')
  order by m.ended_at desc
  limit p_limit;
end;
$$;
