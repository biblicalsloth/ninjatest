-- =========================================================
-- Passage reading time — first question of a passage group gets extra clock
--
-- The first VARC/DILR question served off a passage carries the full reading
-- cost (real CAT budgets ~2min just to read an RC passage); questions 2-3 of
-- the same passage ride free. The section cap (VARC 90s) was brutal for the
-- opener and generous for the followers.
--
-- Fix: section_config.reading_ms (new dial — VARC 60s, DILR 60s, QUANT 0).
-- The FIRST question of its passage in a match's question_ids gets
-- cap + reading_ms; later questions of the same passage get the plain cap.
-- "First" is a pure function of the frozen question_ids array, so every
-- reader computes the same deadline.
--
-- Speed bonus does NOT ride the reading window: submit_answer caps the bonus
-- time at the BASE cap — answering anywhere inside the reading window earns
-- the same max bonus as an instant answer did before. Max/question stays 140
-- in every section (parity), the derived wrong penalty stays EV-neutral
-- (it divides whatever the reward is), and finalize_match's FULL margin
-- (base + max bonus off the base cap) needs no change.
--
-- ONE cap source: question_cap_ms(). Callers recreated from their LATEST defs
-- (migration discipline — CREATE OR REPLACE from stale copies is the #1
-- regression vector here):
--   get_match_question           <- 20260713110000
--   get_match_question_spectator <- 20260713110000
--   submit_answer                <- 20260715000000
--   advance_timed_out            <- 20260713090000
--   forfeit_match                <- 20260713100000
--   bot_act                      <- 20260715070000
--   get_debrief_data             <- 20260715040000
-- finalize_match untouched (see above). option_perm untouched.
-- =========================================================

alter table section_config add column if not exists reading_ms integer not null default 0;

update section_config set reading_ms = 60000 where section = 'VARC';
update section_config set reading_ms = 60000 where section = 'DILR';
-- QUANT stays 0 (picker serves standalone quant only)

-- ─────────────────────────────────────────────────────────
-- question_cap_ms — the single source of a question's clock in a match.
-- base = coalesce(question.duration_ms, section cap_ms); + reading_ms when
-- the question has a passage and no EARLIER index in question_ids shares it.
-- Returns NULL if the question row is missing (callers fail closed on null).
-- ─────────────────────────────────────────────────────────
create or replace function question_cap_ms(p_question_ids uuid[], p_index int)
returns integer
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(q.duration_ms, cfg.cap_ms)
       + case
           when q.passage_id is not null and not exists (
             select 1
             from unnest(p_question_ids[1:p_index]) as prev_id
             join questions pq on pq.id = prev_id
             where pq.passage_id = q.passage_id
           )
           then cfg.reading_ms
           else 0
         end
  from questions q
  join section_config cfg on cfg.section = q.section
  where q.id = p_question_ids[p_index + 1];
$$;

revoke execute on function question_cap_ms(uuid[], int) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────
-- get_match_question — cap via question_cap_ms. Recreated verbatim from
-- 20260713110000; only the cap expression changed (cfg select dropped —
-- it existed solely for cap_ms). Return type unchanged, so no DROP and
-- existing grants persist.
-- ─────────────────────────────────────────────────────────
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  cap_ms            integer,
  started_at        timestamptz,
  passage           text,
  image_url         text,
  passage_image_url text
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  perm      integer[];
  shuffled  jsonb;
  v_passage text;
  v_pimage  text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
  select jsonb_agg(q.options -> p order by ord) into shuffled
  from unnest(perm) with ordinality as u(p, ord);

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id,
    q.section,
    q.body,
    shuffled,
    question_cap_ms(m.question_ids, p_index::int),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- get_match_question_spectator — same single-expression change.
-- Recreated verbatim from 20260713110000.
-- ─────────────────────────────────────────────────────────
create or replace function get_match_question_spectator(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  cap_ms            integer,
  started_at        timestamptz,
  passage           text,
  image_url         text,
  passage_image_url text
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  v_passage text;
  v_pimage  text;
begin
  select * into m from matches where id = p_match_id;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if auth.uid() in (m.player_a, m.player_b) then
    raise exception 'participants must use get_match_question';
  end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id, q.section, q.body, q.options,
    question_cap_ms(m.question_ids, p_index::int),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- submit_answer — cap via question_cap_ms; bonus time capped at the BASE
-- cap so the reading window is bonus-free grace (parity + EV-neutrality
-- preserved). Recreated verbatim from 20260715000000; changes: cap_base
-- declared, cap assignment, the grace formula's least(...) term.
-- ─────────────────────────────────────────────────────────
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
  cap_base   integer;
  taken_ms   integer;
  correct    boolean;
  grace      integer;
  pts        integer;
  n_opts     integer;
  perm       integer[];
  canonical  smallint;
  player_elo integer;
  res_q      numeric;
  suspect    boolean;
  late       boolean;
  inserted   int;
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
  -- Bonus time is capped at the BASE cap: answering anywhere inside a passage
  -- reading window earns the same max bonus an instant answer earns on a
  -- plain question — reading time extends the clock, never the reward.
  grace   := round(cfg.speed_mult * floor(least(cap - taken_ms, cap_base)::numeric / cfg.grace_block_ms))::int;
  -- Wrong penalty rides the same speed curve as the reward, divided by the
  -- number of wrong options: a random guess is exactly EV-neutral at every t
  -- (fast wrong answers cost more, matching their larger potential reward).
  pts     := case
    when late               then 0
    when correct            then cfg.base_points + grace
    when canonical is null  then 0
    else                         -round((cfg.base_points + grace)::numeric
                                        / greatest(n_opts - 1, 1))::int
  end;

  -- The cron's skip-row insert doesn't hold this match's row lock, so an
  -- in-slack submit can lose the unique-key race; resolve it as the skip the
  -- cron already recorded instead of aborting the whole call.
  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    canonical, correct, pts, taken_ms
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
  suspect := (canonical is not null and taken_ms < 2000);
  if correct and suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Per-question ELO nudge, ATOMIC. Only rated matches nudge (unrated
  -- challenges are uncapped per pair — a collusion channel otherwise); a
  -- late/skip answer (canonical null) never nudges — only bumps times_seen.
  if canonical is not null and not suspect and m.is_rated then
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
-- advance_timed_out — cron deadline via question_cap_ms. Recreated verbatim
-- from 20260713090000; only the cap computation changed.
-- ─────────────────────────────────────────────────────────
create or replace function advance_timed_out()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r   record;
  cap integer;
  pid uuid;
begin
  update matches
  set status = 'abandoned', ended_at = now()
  where status = 'pending'
    and created_at < now() - interval '2 minutes';

  for r in
    select m.*, q.id as q_id
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    cap := question_cap_ms(r.question_ids, r.current_index);

    if cap is not null
       and now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      foreach pid in array array[r.player_a, r.player_b] loop
        insert into match_answers (
          match_id, user_id, question_id, question_index,
          selected_index, is_correct, points_awarded, time_taken_ms
        )
        values (r.id, pid, r.q_id, r.current_index, null, false, 0, null)
        on conflict (match_id, user_id, question_index) do nothing;
      end loop;

      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id
          and status = 'active'
          and current_index = r.current_index;
      end if;

      perform broadcast_spectator_update(r.id);
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- forfeit_match — absence-proof deadline via question_cap_ms. Recreated
-- verbatim from 20260713100000; only the cap select changed (the null-cap
-- fail-closed guard is unchanged — question_cap_ms returns null on a
-- missing question row).
-- ─────────────────────────────────────────────────────────
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  cap             integer;
  prev_absent     boolean;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  quitter := case when present_player = m.player_a then m.player_b else m.player_a end;

  -- A submission (even a skip) always records time_taken_ms; only the cron's
  -- skip rows have a NULL time. Such a row on the quitter's PREVIOUS question
  -- is proof they already missed a full deadline — no need to wait out the
  -- current one again.
  prev_absent := m.current_index > 0 and exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = m.current_index - 1
      and selected_index is null and time_taken_ms is null
  );

  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = m.current_index
      and (selected_index is not null or time_taken_ms is not null)
  ) then
    raise exception 'opponent answered — not absent';
  end if;

  if not prev_absent then
    cap := question_cap_ms(m.question_ids, m.current_index);

    -- fails closed: a NULL cap (question row missing) means 'too early'
    if m.question_started_at is null or cap is null
       or now() < m.question_started_at + ((cap + 5000)::text || ' milliseconds')::interval then
      raise exception 'too early to forfeit — opponent still within the question deadline';
    end if;
  end if;

  -- No-skill guard (parity with finalize_match): a rated match where nobody
  -- got anything right carries no signal — end it without transferring ELO,
  -- and record NO winner (matching finalize_match's L3 fix).
  if not m.is_rated
     or (m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0) then
    update matches set status='abandoned', ended_at=now(), winner_id=null
    where id = p_match_id;
    return;
  end if;

  perform apply_rated_result(p_match_id, present_player, quitter, 1.0);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- bot_act — the bot plays on the same clock as a human: its answer-time plan
-- spans the EXTENDED cap (so it plausibly "reads" a passage opener) and its
-- bonus is capped at the BASE cap exactly like submit_answer. Recreated
-- verbatim from 20260715070000; changes: cap_base declared, cap via
-- question_cap_ms, the bonus least(...) term.
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
  n_opts   int;
  sel      int;
  bonus    int;
  pts      int;
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

  -- Deterministic plan for this (match, question).
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

  if v_correct then
    sel := q.correct_index;
  else
    -- floor, NOT ::int (which rounds): the offset must stay in [1, n-1] so a
    -- "wrong" pick can never wrap onto the correct option.
    sel := (q.correct_index + 1 + floor(bot_hash_unit(seed, 17) * (n_opts - 1))::int) % n_opts;
  end if;

  -- Same scoring curve as submit_answer (derived EV-neutral wrong penalty;
  -- bonus time capped at the BASE cap — the reading window mints no points).
  bonus := round(sc.speed_mult * floor(least(cap - least(t_ans_ms, cap), cap_base)::numeric / sc.grace_block_ms))::int;
  if v_correct then
    pts := sc.base_points + bonus;
  else
    pts := -round((sc.base_points + bonus)::numeric / (n_opts - 1))::int;
  end if;

  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (p_match_id, bot_id, q.id, idx, sel, v_correct, pts, t_ans_ms)
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
-- get_debrief_data — report each question's TRUE clock (extended for passage
-- openers) so the AI debrief never reads a legit opener answer as overtime.
-- Recreated verbatim from 20260715040000; only the cap_ms expression changed.
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
    'opp_elo',   (select p.elo from profiles p where p.id = opp),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'q',            gs.i,
        'section',      q.section,
        'question_elo', q.elo,
        'cap_ms',       question_cap_ms(m.question_ids, gs.i - 1),
        'mine', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null,
                   'points',  a.points_awarded,
                   'time_ms', a.time_taken_ms)
                 from match_answers a
                 where a.match_id = m.id and a.user_id = uid and a.question_index = gs.i - 1),
        'opp', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null,
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
