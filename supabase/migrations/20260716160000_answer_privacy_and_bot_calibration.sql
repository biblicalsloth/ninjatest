-- =========================================================
-- Four fixes, in severity order.
--
-- 1. SECURITY — match_answers.answer_text leaked the answer to the opponent,
--    live, on rated matches. The `answers_read` policy (20260627000300) is
--    match-scoped, not row-scoped: any participant could select EVERY row of
--    the match, including the opponent's, while the question was still open.
--    For MCQ that leaked is_correct (which the `opponent_answered` broadcast
--    deliberately withholds) but not the option — selected_index is canonical
--    and option_perm is revoked from clients. TITA (20260716130000) stores the
--    typed answer in PLAINTEXT, so whoever answered first handed the other
--    player the answer. Against the bot it was total: bot_act answers at
--    30-80% of cap (i.e. first, nearly always) and its wrong answers are
--    `answer_value || '.5'` — subtract 0.5 and you have the answer either way.
--    Narrowed to own-rows. Safe: the only client read already filters to self
--    (app/result/[matchId]/page.tsx), and every opponent-facing read path
--    (get_answer_reveal, get_debrief_data, the spectator RPCs) is SECURITY
--    DEFINER and bypasses RLS.
--
-- 2. bot matches now calibrate the question bank. submit_answer's nudge was
--    gated on m.is_rated, and match_with_bot hardcodes is_rated=false — so the
--    cold-start tool produced zero signal for the bank it reads its own skill
--    from. Circular: bot difficulty is a pure function of q.elo, and q.elo
--    could only ever move once real rated matches existed.
--
-- 3. the bot never skipped, which made it free money on MCQ: a human who skips
--    what they don't know beats a bot that eats the wrong-answer penalty every
--    time. Per-question EV was ~+8 for the bot vs ~+35 for a skip-disciplined
--    human — no math required to farm it.
--
-- 4. the bot displayed a fixed 1200 rating while actually playing at the
--    human's rating (bot_act derives correct-probability from it).
--
-- Recreated from their LATEST definitions:
--   submit_answer, bot_act, get_debrief_data <- 20260716130000_tita_question_type
--   match_with_bot                           <- 20260715070000_ninja_bot
-- All four keep their existing signatures, so CREATE OR REPLACE retains the
-- grant matrix (no DROP -> no PUBLIC EXECUTE reset).
-- =========================================================

-- ─────────────────────────────────────────────────────────
-- 1. Answer privacy. Own rows only.
-- ─────────────────────────────────────────────────────────
drop policy if exists answers_read on public.match_answers;
create policy answers_read on public.match_answers
  for select to public
  using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────
-- 2. submit_answer — bot matches calibrate too.
-- Recreated from 20260716130000; ONE gate changed (v_calibrates).
-- ─────────────────────────────────────────────────────────
create or replace function submit_answer(
  p_match_id uuid, p_question_index smallint, p_selected_index smallint,
  p_answer_text text default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m            matches%rowtype;
  q            questions%rowtype;
  cfg          section_config%rowtype;
  uid          uuid := auth.uid();
  is_a         boolean;
  cap          integer;
  cap_base     integer;
  taken_ms     integer;
  correct      boolean;
  grace        integer;
  pts          integer;
  n_opts       integer;
  perm         integer[];
  canonical    smallint;
  v_answer     text;
  answered     boolean;
  player_elo   integer;
  res_q        numeric;
  suspect      boolean;
  late         boolean;
  inserted     int;
  v_calibrates boolean;
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
  cap_base := coalesce(q.duration_ms, cfg.cap_ms);
  cap      := question_cap_ms(m.question_ids, p_question_index::int);
  n_opts   := jsonb_array_length(q.options);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  -- A submission arriving after the deadline (+3s network slack) scores nothing,
  -- regardless of correctness — taken_ms alone is clamped to cap and would
  -- otherwise still award base_points to a submit up to a cron-cycle late.
  late := (extract(epoch from (now() - m.question_started_at)) * 1000) > cap + 3000;

  -- Bonus time is capped at the BASE cap: answering anywhere inside a passage
  -- reading window earns the same max bonus an instant answer earns on a
  -- plain question — reading time extends the clock, never the reward.
  grace := round(cfg.speed_mult * floor(least(cap - taken_ms, cap_base)::numeric / cfg.grace_block_ms))::int;

  if q.qtype = 'tita' then
    -- No options, no shuffle, no correct_index. A blank/whitespace-only entry
    -- is a skip, exactly like a null option pick.
    canonical := null;
    if late or tita_norm(p_answer_text) is null then
      v_answer := null;
    else
      v_answer := btrim(p_answer_text);
    end if;
    correct := (v_answer is not null and tita_matches(v_answer, q.answer_value));
    -- NO negative marking on TITA.
    pts := case
      when late or v_answer is null then 0
      when correct                  then cfg.base_points + grace
      else                               0
    end;
  else
    v_answer := null;
    -- Map the client's displayed option index back to the canonical index.
    if p_selected_index is null or late then
      canonical := null;
    elsif p_selected_index < 0 or p_selected_index >= n_opts then
      raise exception 'invalid option';
    else
      perm      := option_perm(p_match_id, uid, p_question_index, n_opts);
      canonical := perm[p_selected_index + 1];
    end if;

    correct := (canonical is not null and canonical = q.correct_index);
    -- Wrong penalty rides the same speed curve as the reward, divided by the
    -- number of wrong options: a random guess is exactly EV-neutral at every t.
    pts := case
      when late               then 0
      when correct            then cfg.base_points + grace
      when canonical is null  then 0
      else                         -round((cfg.base_points + grace)::numeric
                                          / greatest(n_opts - 1, 1))::int
    end;
  end if;

  answered := (canonical is not null or v_answer is not null);

  -- The cron's skip-row insert doesn't hold this match's row lock, so an
  -- in-slack submit can lose the unique-key race; resolve it as the skip the
  -- cron already recorded instead of aborting the whole call.
  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, answer_text, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    canonical, v_answer, correct, pts, taken_ms
  )
  on conflict (match_id, user_id, question_index) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return; end if;

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  -- Any implausibly-fast (<2s) real answer is excluded from the question-ELO
  -- nudge — fast-wrong deflation is as manipulable as fast-correct inflation.
  -- Telemetry keeps its original meaning: fast CORRECT answers only.
  suspect := (answered and taken_ms < 2000);
  if correct and suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Rated matches calibrate the bank. So do BOT matches, which are always
  -- unrated: the no-unrated-nudge rule exists because player-vs-player
  -- challenges are uncapped per pair (a collusion channel into the bank) —
  -- you cannot collude with the bot. One side is server-controlled, and
  -- match_with_bot is rate-limited 5/60 while bot_act gates every question
  -- behind >=30% of its cap, so a single user tops out around a dozen bot
  -- matches an hour.
  -- ponytail: only the HUMAN's submission nudges — bot_act deliberately has no
  -- nudge of its own, because the bot's answer is derived FROM q.elo and
  -- feeding it back would be a self-reinforcing loop.
  v_calibrates := m.is_rated or exists (
    select 1 from profiles p
    where p.id in (m.player_a, m.player_b) and p.is_bot
  );

  -- Per-question ELO nudge, ATOMIC. A late/skip answer never nudges — only
  -- bumps times_seen.
  if answered and not suspect and v_calibrates then
    select elo into player_elo from profiles where id = uid;
    res_q := case when correct
                  then 0.35 * (taken_ms::numeric / greatest(cap, 1))
                  else 1.0 end;
    update questions
      set elo = greatest(400, least(2800, round(elo
                  + (case when times_seen < 20 then 32 else 16 end)
                  * (res_q - 1.0 / (1.0 + power(10.0, (player_elo - elo) / 400.0))))::int)),
          times_seen = times_seen + 1
      where id = q.id;
  else
    update questions set times_seen = times_seen + 1 where id = q.id;
  end if;

  perform maybe_advance(p_match_id, p_question_index);
  perform broadcast_spectator_update(p_match_id);
end; $$;

-- ─────────────────────────────────────────────────────────
-- 3. bot_act — skip discipline.
-- Recreated from 20260716130000; changes: v_skip + BOT_SKIP_WHEN_WRONG, the
-- skip branch inside the MCQ path.
-- ─────────────────────────────────────────────────────────
create or replace function bot_act(p_match_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid      uuid := (select auth.uid());
  m        matches%rowtype;
  bot_id   uuid;
  q        questions%rowtype;
  sc       section_config%rowtype;
  idx      int;
  seed     text;
  cap      int;
  cap_base int;
  t_ans_ms int;
  deadline timestamptz;
  human_elo int;
  expectation float8;
  v_correct boolean;
  v_skip    boolean;
  n_opts   int;
  sel      int;
  v_answer text;
  bonus    int;
  pts      int;
  -- Share of would-be-wrong MCQ answers the bot walks away from instead of
  -- guessing. 0 = the old never-skip bot (EV ~+8/question, farmable by any
  -- human with skip discipline); 1.0 = a bot that never eats a penalty, i.e.
  -- strictly optimal and stronger than the humans it exists to warm up.
  -- 0.7 puts it just under a skip-disciplined human (~+27 vs ~+35).
  -- ponytail: a constant, not a section_config column — it's one game-balance
  -- dial with no per-section meaning. Promote it if it ever needs to differ.
  BOT_SKIP_WHEN_WRONG constant float8 := 0.7;
begin
  perform check_rate_limit('bot_act', 30, 10);

  select * into m from matches where id = p_match_id for update;
  if not found or uid not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status <> 'active' then
    return jsonb_build_object('acted', false, 'reason', 'not active');
  end if;

  -- Identify the bot side; reject non-bot matches.
  if (select p.is_bot from profiles p where p.id = m.player_b) then
    bot_id := m.player_b;
  elsif (select p.is_bot from profiles p where p.id = m.player_a) then
    bot_id := m.player_a;
  else
    raise exception 'not a bot match';
  end if;

  idx := m.current_index;
  if m.question_started_at is null then
    return jsonb_build_object('acted', false, 'reason', 'not started');
  end if;
  if exists (select 1 from match_answers a
             where a.match_id = p_match_id and a.user_id = bot_id and a.question_index = idx) then
    return jsonb_build_object('acted', false, 'answered', true);
  end if;

  select * into q from questions where id = m.question_ids[idx + 1];
  select * into sc from section_config where section = q.section;
  cap_base := coalesce(q.duration_ms, sc.cap_ms);
  cap      := question_cap_ms(m.question_ids, idx);
  n_opts := jsonb_array_length(q.options);

  -- Deterministic plan for this (match, question). The four hash offsets
  -- (1, 9, 17, 25) are non-overlapping 8-char windows of the same md5.
  seed := p_match_id::text || ':' || idx;
  t_ans_ms := (cap * (0.30 + 0.50 * bot_hash_unit(seed, 1)))::int;
  deadline := m.question_started_at + make_interval(secs => t_ans_ms / 1000.0);
  if now() < deadline then
    return jsonb_build_object('acted', false,
      'eta_ms', (extract(epoch from (deadline - now())) * 1000)::int);
  end if;

  -- Bot skill = the human's current rating vs the question's ELO.
  select p.elo into human_elo from profiles p
  where p.id = case when bot_id = m.player_a then m.player_b else m.player_a end;
  expectation := 1.0 / (1.0 + power(10.0, (q.elo - human_elo) / 400.0));
  v_correct := bot_hash_unit(seed, 9) < expectation;

  -- Skip discipline: when the bot would answer wrong, it usually walks away
  -- rather than eating the penalty — which is how the humans who beat the
  -- never-skip bot were beating it. TITA is NEVER skipped: it carries no
  -- negative marking, so attempting is strictly better (and is exactly how a
  -- real candidate plays it).
  v_skip := (not v_correct)
            and q.qtype <> 'tita'
            and bot_hash_unit(seed, 25) < BOT_SKIP_WHEN_WRONG;

  -- Same scoring curve as submit_answer (derived EV-neutral wrong penalty;
  -- bonus time capped at the BASE cap — the reading window mints no points).
  bonus := round(sc.speed_mult * floor(least(cap - least(t_ans_ms, cap), cap_base)::numeric / sc.grace_block_ms))::int;

  if q.qtype = 'tita' then
    sel := null;
    if v_correct then
      v_answer := q.answer_value;
      pts      := sc.base_points + bonus;
    else
      -- A wrong answer has to look like a wrong ANSWER — a number a candidate
      -- could plausibly have arrived at. Borrow another active TITA's answer
      -- from the same section, picked deterministically off the same seed.
      -- (The old `answer_value || '.5'` was both implausible — every answer in
      -- the bank is a small integer — and a pure function of the correct
      -- answer, so anything that ever exposed it exposed the answer too.)
      select t.answer_value into v_answer
      from questions t
      where t.qtype = 'tita' and t.is_active and t.section = q.section
        and t.id <> q.id
        and t.answer_value is not null
        and not tita_matches(t.answer_value, q.answer_value)
      order by md5(t.id::text || seed)
      limit 1;
      -- Bank too thin to borrow from: fall back to a value that cannot collide.
      if v_answer is null then
        v_answer := coalesce(q.answer_value, '0') || '.5';
      end if;
      pts := 0;   -- no negative marking on TITA
    end if;
  elsif v_skip then
    -- A skip is a null selection with 0 points — and, critically, a NON-NULL
    -- time_taken_ms: null time is the cron's skip marker, which forfeit_match
    -- reads as proof of absence.
    sel      := null;
    v_answer := null;
    pts      := 0;
  else
    v_answer := null;
    if v_correct then
      sel := q.correct_index;
    else
      -- floor, NOT ::int (which rounds): the offset must stay in [1, n-1] so a
      -- "wrong" pick can never wrap onto the correct option.
      sel := (q.correct_index + 1 + floor(bot_hash_unit(seed, 17) * (n_opts - 1))::int) % n_opts;
    end if;
    if v_correct then
      pts := sc.base_points + bonus;
    else
      pts := -round((sc.base_points + bonus)::numeric / greatest(n_opts - 1, 1))::int;
    end if;
  end if;

  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, answer_text, is_correct, points_awarded, time_taken_ms)
  values (p_match_id, bot_id, q.id, idx, sel, v_answer, v_correct, pts, t_ans_ms)
  on conflict (match_id, user_id, question_index) do nothing;
  -- Lost the race against the cron's null-skip insert (it doesn't hold this
  -- match's row lock): the skip stands; adding points without a row would
  -- drift the score.
  if not found then
    return jsonb_build_object('acted', false, 'answered', true);
  end if;

  if bot_id = m.player_b then
    update matches set
      score_b   = score_b + pts,
      correct_b = correct_b + v_correct::int
    where id = p_match_id;
  else
    update matches set
      score_a   = score_a + pts,
      correct_a = correct_a + v_correct::int
    where id = p_match_id;
  end if;

  -- Both sides may now be in → advance/finalize exactly like a human submit.
  perform maybe_advance(p_match_id, idx::smallint);

  return jsonb_build_object('acted', true);
end; $$;

-- ─────────────────────────────────────────────────────────
-- 4. match_with_bot — the bot's shown rating is the human's.
-- Recreated from 20260715070000; ONE value changed (elo_b_before).
-- ─────────────────────────────────────────────────────────
create or replace function match_with_bot()
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid      uuid := (select auth.uid());
  bot_id   uuid := '00000000-0000-0000-0000-00000000b071';
  me       matchmaking_queue%rowtype;
  my_elo   int;
  q_ids    uuid[];
  new_match_id uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('match_with_bot', 5, 60);

  -- Must hold a live waiting row ≥15s old: the bot is a fallback after real
  -- matchmaking has had a chance, not an instant farm button.
  select * into me from matchmaking_queue
  where user_id = uid and status = 'waiting'
  order by enqueued_at desc limit 1
  for update;
  if not found then raise exception 'not in queue'; end if;
  if me.enqueued_at > now() - interval '15 seconds' then
    raise exception 'bot not available yet';
  end if;

  select elo into my_elo from profiles where id = uid;

  q_ids := coalesce(pick_section_question_ids('VARC',  my_elo), '{}')
        || coalesce(pick_section_question_ids('DILR',  my_elo), '{}')
        || coalesce(pick_section_question_ids('QUANT', my_elo), '{}');
  if coalesce(array_length(q_ids, 1), 0) = 0 then
    raise exception 'no questions available';
  end if;

  -- Created directly active (no presence handshake — the bot is always
  -- "present"); 3s-ahead question_started_at gives the shared lead-in the
  -- client already renders.
  --
  -- elo_b_before = the HUMAN's rating, not the bot's inert profiles.elo (1200).
  -- bot_act derives its correct-probability from the human's rating, so the
  -- bot genuinely plays at your level — showing a fixed 1200 to an 1800 player
  -- who then loses was just a lie. profiles.elo for the bot is never read by
  -- the match path and the bot is excluded from the ladder (20260716140000).
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, started_at, question_started_at)
  values (uid, bot_id, 'active', false, q_ids,
          my_elo, my_elo,
          now(), now() + interval '3 seconds')
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id = me.id;

  return new_match_id;
end; $$;

-- ─────────────────────────────────────────────────────────
-- get_debrief_data — same story for opp_elo, which reads profiles directly.
-- Recreated from 20260716130000; ONE expression changed.
-- ─────────────────────────────────────────────────────────
create or replace function get_debrief_data(p_match_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  m   matches%rowtype;
  uid uuid := (select auth.uid());
  opp uuid;
  res jsonb;
begin
  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status not in ('completed', 'abandoned') then
    raise exception 'match not finished';
  end if;
  opp := case when uid = m.player_a then m.player_b else m.player_a end;

  select jsonb_build_object(
    'status',    m.status,
    'is_rated',  m.is_rated,
    'result',    case when m.winner_id is null and m.status = 'completed' then 'draw'
                      when m.winner_id = uid then 'win'
                      when m.winner_id is null then 'unresolved'
                      else 'loss' end,
    'my_score',  case when uid = m.player_a then m.score_a else m.score_b end,
    'opp_score', case when uid = m.player_a then m.score_b else m.score_a end,
    'my_elo',    (select p.elo from profiles p where p.id = uid),
    -- The bot has no rating of its own — it plays at the human's, which
    -- match_with_bot locked into elo_*_before at creation.
    'opp_elo',   (select case when p.is_bot
                              then case when uid = m.player_a then m.elo_b_before else m.elo_a_before end
                              else p.elo end
                  from profiles p where p.id = opp),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'q',            gs.i,
        'section',      q.section,
        'qtype',        q.qtype,
        'question_elo', q.elo,
        'cap_ms',       question_cap_ms(m.question_ids, gs.i - 1),
        'mine', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null and a.answer_text is null,
                   'points',  a.points_awarded,
                   'time_ms', a.time_taken_ms)
                 from match_answers a
                 where a.match_id = m.id and a.user_id = uid and a.question_index = gs.i - 1),
        'opp', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null and a.answer_text is null,
                   'points',  a.points_awarded,
                   'time_ms', a.time_taken_ms)
                 from match_answers a
                 where a.match_id = m.id and a.user_id = opp and a.question_index = gs.i - 1)
      ) order by gs.i)
      from generate_subscripts(m.question_ids, 1) gs(i)
      join questions q on q.id = m.question_ids[gs.i]
    ), '[]'::jsonb)
  ) into res;
  return res;
end; $$;
