-- Two changes that both touch the question read/scoring path, applied together:
--
-- 1. OPTION-ORDER RANDOMIZATION (anti-cheat). Options are shown to each player in
--    a deterministic per-(match,player,question) shuffle, so answer keys can't be
--    shared as "the answer is C". Fully server-side — the client renders whatever
--    order it receives and submits the displayed index; the server maps it back to
--    the canonical index for scoring. The DB stays canonical (match_answers stores
--    canonical selected_index). get_answer_reveal returns the correct option's
--    DISPLAY position so the reveal highlight lines up with the shuffled options.
--
-- 2. PER-QUESTION ELO / ADAPTIVE DIFFICULTY. Question selection biases toward
--    questions near the players' average ELO (still a fixed 3/3/3 section mix);
--    each answered question's ELO is nudged after every answer.

-- Deterministic permutation of [0..n-1] for a given (match, player, question).
-- perm[k] = canonical option index shown at display position k. IMMUTABLE: same
-- inputs always yield the same order, so read/submit/reveal agree without storing
-- the permutation anywhere.
create or replace function option_perm(
  p_match_id uuid, p_user_id uuid, p_q_index integer, p_n integer
) returns integer[]
language sql immutable
set search_path = pg_catalog, public as $$
  select array_agg(i order by
    md5(p_match_id::text || ':' || p_user_id::text || ':' || p_q_index::text || ':' || i::text))
  from generate_series(0, p_n - 1) g(i);
$$;
revoke execute on function option_perm(uuid, uuid, integer, integer) from public;

-- Pick match questions biased toward p_target_elo. random()*300 of jitter keeps
-- variety so the same nearest questions aren't drained every match.
create or replace function pick_questions(
  p_target_elo integer, p_section_mode cat_section default null
) returns uuid[]
language sql volatile
set search_path = pg_catalog, public as $$
  select case when p_section_mode is null then
    (select array_agg(id) from (
      (select id from questions where section = 'VARC'  and is_active
         order by abs(elo - p_target_elo) + random() * 300 limit 3)
      union all
      (select id from questions where section = 'DILR'  and is_active
         order by abs(elo - p_target_elo) + random() * 300 limit 3)
      union all
      (select id from questions where section = 'QUANT' and is_active
         order by abs(elo - p_target_elo) + random() * 300 limit 3)
    ) s)
  else
    (select array_agg(id) from (
      select id from questions where section = p_section_mode and is_active
        order by abs(elo - p_target_elo) + random() * 300 limit 9
    ) s)
  end;
$$;
revoke execute on function pick_questions(integer, cat_section) from public;

-- ── Read: serve options in the player's shuffled order ──
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table(question_id uuid, section cat_section, body text, options jsonb,
              cap_ms integer, started_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m        matches%rowtype;
  q        questions%rowtype;
  cfg      section_config%rowtype;
  perm     integer[];
  shuffled jsonb;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select jsonb_agg(q.options -> p order by ord) into shuffled
  from unnest(perm) with ordinality as u(p, ord);

  return query select
    q.id, q.section, q.body, shuffled,
    coalesce(q.duration_ms, cfg.cap_ms), m.question_started_at;
end; $$;

-- ── Reveal: translate the canonical correct index to this player's display pos ──
create or replace function get_answer_reveal(p_match_id uuid, p_index smallint)
returns table(correct_index smallint, explanation text,
              points_awarded integer, is_correct boolean)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  m            matches%rowtype;
  q            questions%rowtype;
  perm         integer[];
  disp_correct smallint;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select (ord - 1)::smallint into disp_correct
  from unnest(perm) with ordinality as u(p, ord)
  where p = q.correct_index;

  return query
    select disp_correct, q.explanation,
      coalesce(a.points_awarded, 0)::integer, coalesce(a.is_correct, false)
    from (select 1) _d
    left join match_answers a
      on a.match_id = p_match_id and a.user_id = auth.uid() and a.question_index = p_index;
end; $$;

-- ── Submit: un-shuffle to canonical, score, nudge question ELO, flag fast answers ──
create or replace function submit_answer(
  p_match_id uuid, p_question_index smallint, p_selected_index smallint
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m          matches%rowtype;
  q          questions%rowtype;
  cfg        section_config%rowtype;
  uid        uuid := auth.uid();
  is_a       boolean;
  cap        integer;
  taken_ms   integer;
  correct    boolean;
  grace      integer;
  pts        integer;
  n_opts     integer;
  perm       integer[];
  canonical  smallint;
  player_elo integer;
  exp_q      numeric;
  res_q      numeric;
begin
  perform check_rate_limit('submit_answer', 20, 5);

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
  cap    := coalesce(q.duration_ms, cfg.cap_ms);
  n_opts := jsonb_array_length(q.options);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  -- Map the client's displayed option index back to the canonical index.
  -- Reject out-of-range indices so a crafted index can't dodge the wrong-penalty.
  if p_selected_index is null then
    canonical := null;
  elsif p_selected_index < 0 or p_selected_index >= n_opts then
    raise exception 'invalid option';
  else
    perm      := option_perm(p_match_id, uid, p_question_index, n_opts);
    canonical := perm[p_selected_index + 1];
  end if;

  correct := (canonical is not null and canonical = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when correct            then cfg.base_points + grace
    when canonical is null  then 0
    else                         -cfg.wrong_penalty
  end;

  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    canonical, correct, pts, taken_ms
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

  -- Per-question ELO nudge. Only a real answer is signal; a timeout skip isn't.
  -- Question "wins" when the player gets it wrong. K = 16.
  if canonical is not null then
    select elo into player_elo from profiles where id = uid;
    exp_q := 1.0 / (1.0 + power(10.0, (player_elo - q.elo) / 400.0));
    res_q := case when correct then 0.0 else 1.0 end;
    update questions
      set elo = round(elo + 16 * (res_q - exp_q))::int,
          times_seen = times_seen + 1
      where id = q.id;
  else
    update questions set times_seen = times_seen + 1 where id = q.id;
  end if;

  -- Telemetry: flag implausibly-fast correct answers (< 2s). Capture only.
  -- ponytail: flat 2s threshold; per-section thresholds if false positives matter.
  if correct and taken_ms < 2000 then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  perform maybe_advance(p_match_id, p_question_index);
  perform broadcast_spectator_update(p_match_id);
end; $$;

-- ── Adaptive question selection wired into matchmaking + challenge accept ──
create or replace function try_match_internal(p_user_id uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  select * into me from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;
  if not found then return null; end if;

  my_band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20))
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;
  if not found then return null; end if;

  q_ids := pick_questions(((me.elo + opp.elo) / 2)::int, null);

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids, me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id in (me.id, opp.id);

  return new_match_id;
end; $$;

create or replace function accept_challenge(p_code text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ch       challenges%rowtype;
  q_ids    uuid[];
  new_id   uuid;
  host_elo int;
  me_elo   int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();

  q_ids := pick_questions(((host_elo + me_elo) / 2)::int, ch.section_mode);

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end; $$;
