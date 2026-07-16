-- =========================================================
-- TITA (Type-In-The-Answer) question type — numeric free-text answers
-- =========================================================
-- Real CAT mixes MCQs with TITA items: no options, the candidate types a
-- number, and — critically — TITA carries NO negative marking. The bank now
-- holds 51 QUANT TITA questions (20260716120000 added questions.qtype /
-- questions.answer_value); they were parked is_active=false because every
-- match-path function assumed options + correct_index.
--
-- What breaks without this migration (all of it real, not theoretical):
--   • get_match_question     — option_perm/jsonb_agg over an EMPTY options
--                              array serves `null` options.
--   • submit_answer          — no way to send a typed answer at all.
--   • bot_act                — `% n_opts` with n_opts=0 → DIVISION BY ZERO,
--                              and `/(n_opts-1)` → divide by -1, which AWARDS
--                              points for a wrong bot answer.
--   • finalize_match         — per-question max margin (1 + 1/(n-1)) evaluates
--                              to 1+1/greatest(-1,1) = 2 for TITA, overstating
--                              FULL and silently shrinking every ELO delta in
--                              any match containing a TITA.
--   • get_debrief_data       — `skipped := selected_index is null` reports a
--                              genuine TITA answer as a SKIP.
--   • get_answer_reveal      — reveals a display index that doesn't exist.
--
-- Scoring: correct → base_points + the SAME speed bonus curve as MCQ.
-- Wrong/blank → 0. No negative marking: the derived MCQ penalty exists to make
-- a random guess EV-neutral over n options; a free-text number has no guess
-- distribution to neutralise, and real CAT doesn't penalise TITA either.
-- Max/question therefore stays 140 (parity with MCQ's correct case).
--
-- match_answers.selected_index stays NULL for TITA (there is no option index) —
-- so "skipped" is now (selected_index IS NULL AND answer_text IS NULL). The
-- cron's null-skip marker (time_taken_ms IS NULL) is untouched.
--
-- Every function below is recreated from its LATEST definition:
--   get_match_question, get_match_question_spectator, submit_answer,
--   bot_act, get_debrief_data   <- 20260715100000_passage_reading_time
--   finalize_match              <- 20260715000000_scoring_ev_parity_elo_fixes
--   get_answer_reveal           <- 20260713090000_audit_round2_fixes
-- DROP+CREATE resets privileges to PUBLIC EXECUTE, so grants are restored
-- explicitly at the bottom (authenticated + service_role; finalize_match is
-- service_role-only). Never let anon back in.

alter table match_answers add column if not exists answer_text text;
comment on column match_answers.answer_text is 'typed answer for tita questions; NULL for mcq. skip = selected_index IS NULL AND answer_text IS NULL';

-- ─────────────────────────────────────────────────────────
-- Answer matching. Numeric-aware so "50", " 50 ", "50.0" and "1,050" all
-- behave; falls back to case-insensitive text equality for anything the book
-- stored as non-numeric.
-- ─────────────────────────────────────────────────────────
create or replace function tita_norm(t text) returns text
language sql immutable
set search_path = pg_catalog, public as $$
  select nullif(btrim(regexp_replace(lower(coalesce(t, '')), '[\s,]', '', 'g')), '')
$$;

create or replace function tita_matches(p_input text, p_expected text) returns boolean
language plpgsql immutable
set search_path = pg_catalog, public as $$
declare a text; b text;
begin
  a := tita_norm(p_input);
  b := tita_norm(p_expected);
  if a is null or b is null then return false; end if;
  begin
    return a::numeric = b::numeric;   -- 50 = 50.0
  exception when others then
    return a = b;                      -- non-numeric answer_value
  end;
end $$;

-- ─────────────────────────────────────────────────────────
-- get_match_question — adds qtype; TITA serves NO options (and never touches
-- option_perm, which is meaningless for an empty array). answer_value is of
-- course never sent to the client.
-- ─────────────────────────────────────────────────────────
drop function if exists get_match_question(uuid, smallint);
create function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  qtype             text,
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

  if q.qtype = 'tita' then
    shuffled := '[]'::jsonb;
  else
    perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
    select jsonb_agg(q.options -> p order by ord) into shuffled
    from unnest(perm) with ordinality as u(p, ord);
  end if;

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id,
    q.section,
    q.body,
    shuffled,
    q.qtype,
    question_cap_ms(m.question_ids, p_index::int),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- get_match_question_spectator — same qtype addition; spectators never see
-- options for a TITA (there are none) nor the answer.
-- ─────────────────────────────────────────────────────────
drop function if exists get_match_question_spectator(uuid, smallint);
create function get_match_question_spectator(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  qtype             text,
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
    q.id, q.section, q.body,
    case when q.qtype = 'tita' then '[]'::jsonb else q.options end,
    q.qtype,
    question_cap_ms(m.question_ids, p_index::int),
    m.question_started_at,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- submit_answer — gains p_answer_text for TITA. The old 3-arg signature is
-- DROPPED rather than overloaded: a defaulted 4th param alongside the 3-arg
-- version makes every existing 3-arg call ambiguous ("function is not unique").
-- Existing MCQ clients keep working — PostgREST binds their 3 named args to
-- this function and p_answer_text defaults to null.
-- Recreated from 20260715100000; changes: p_answer_text param, the `answered`
-- notion (canonical OR typed answer), the TITA scoring branch, answer_text
-- persisted.
-- ─────────────────────────────────────────────────────────
drop function if exists submit_answer(uuid, smallint, smallint);
create function submit_answer(
  p_match_id uuid, p_question_index smallint, p_selected_index smallint,
  p_answer_text text default null
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
  v_answer   text;
  answered   boolean;
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
    -- NO negative marking on TITA (see header).
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
    -- number of wrong options: a random guess is exactly EV-neutral at every t
    -- (fast wrong answers cost more, matching their larger potential reward).
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

  -- Per-question ELO nudge, ATOMIC. Only rated matches nudge (unrated
  -- challenges are uncapped per pair — a collusion channel otherwise); a
  -- late/skip answer never nudges — only bumps times_seen.
  if answered and not suspect and m.is_rated then
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
-- get_answer_reveal — adds qtype / answer_value / my_answer_text so the reveal
-- screen can show "the answer was 245, you typed 240". correct_index stays
-- NULL for TITA (no display index exists). Recreated from 20260713090000;
-- changes: the tita branch around option_perm, three new output columns.
-- ─────────────────────────────────────────────────────────
drop function if exists get_answer_reveal(uuid, smallint);
create function get_answer_reveal(p_match_id uuid, p_index smallint)
returns table (
  correct_index  smallint,
  qtype          text,
  answer_value   text,
  my_answer_text text,
  explanation    text,
  points_awarded integer,
  is_correct     boolean,
  passage        text
)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  m            matches%rowtype;
  q            questions%rowtype;
  perm         integer[];
  disp_correct smallint;
  v_passage    text;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  -- Only reveal once the question has closed
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  -- On abandoned/pending matches only questions that were actually served may
  -- be revealed — the old gate leaked the whole bank tail after a forfeit.
  if m.status <> 'completed'
     and (p_index > m.current_index
          or (p_index = m.current_index and m.question_started_at is null)) then
    raise exception 'question not reached';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.qtype <> 'tita' then
    perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
    select (ord - 1)::smallint into disp_correct
    from unnest(perm) with ordinality as u(p, ord)
    where p = q.correct_index;
  end if;

  if q.passage_id is not null then
    select p.body into v_passage from passages p where p.id = q.passage_id;
  end if;

  return query
    select
      disp_correct,
      q.qtype,
      case when q.qtype = 'tita' then q.answer_value else null end,
      a.answer_text,
      q.explanation,
      coalesce(a.points_awarded, 0)::integer,
      coalesce(a.is_correct, false),
      v_passage
    from (select 1) _dummy
    left join match_answers a
      on a.match_id = p_match_id
     and a.user_id  = auth.uid()
     and a.question_index = p_index;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- finalize_match — per-question max margin must not use (1 + 1/(n-1)) for a
-- TITA: with options=[] that evaluates to 1 + 1/greatest(-1,1) = 2, i.e. it
-- assumes a symmetric wrong-penalty that TITA does not have. TITA's true range
-- is base+max_bonus (correct) down to 0 (wrong), a factor of 1.
-- Recreated from 20260715000000; ONE expression changed.
-- ─────────────────────────────────────────────────────────
create or replace function finalize_match(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m           matches%rowtype;
  winner      uuid;
  loser       uuid;
  factor      numeric;
  margin      int;
  full_margin numeric;
  F_MIN       constant numeric := 0.3;
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

  -- No-skill guard: neither player answered a single question correctly (all
  -- skips, or all wrong). Abandon without touching ratings so a colluding pair
  -- can't farm ELO via guaranteed 0-0 draws, AND so the null-winner history
  -- filter hides it — a match with zero skill signal shouldn't render at all.
  if m.correct_a = 0 and m.correct_b = 0 and m.score_a <= 0 and m.score_b <= 0 then
    update matches set status='abandoned', ended_at=now(), winner_id=null
    where id = p_match_id;
    return;
  end if;

  if m.score_a = m.score_b then
    perform apply_draw(p_match_id);
    return;
  end if;

  if m.score_a > m.score_b then
    winner := m.player_a; loser := m.player_b;
  else
    winner := m.player_b; loser := m.player_a;
  end if;

  -- Normalize the margin to THIS match's maximum achievable margin (per
  -- question: winner's base + max speed bonus, plus the loser's max derived
  -- wrong-penalty (base + max bonus)/(n-1) — mirrors submit_answer's formula.
  -- TITA has no wrong-penalty, so its span is the positive side only).
  select 0.2 * sum(
           (cfg.base_points
            + round(cfg.speed_mult * floor(coalesce(q.duration_ms, cfg.cap_ms)::numeric / cfg.grace_block_ms)))
           * (case when q.qtype = 'tita' then 1.0
                   else 1 + 1.0 / greatest(jsonb_array_length(q.options) - 1, 1) end))
    into full_margin
  from unnest(m.question_ids) as qid
  join questions q on q.id = qid
  join section_config cfg on cfg.section = q.section;
  full_margin := coalesce(nullif(full_margin, 0), 300);

  factor := F_MIN + (1.0 - F_MIN) * least(margin::numeric / full_margin, 1.0);
  perform apply_rated_result(p_match_id, winner, loser, factor);
end;
$$;

-- ─────────────────────────────────────────────────────────
-- bot_act — TITA branch. Without it: `% n_opts` divides by zero, and the wrong
-- branch divides by (0-1) = -1, turning the penalty into a REWARD.
-- Recreated from 20260715100000; changes: v_answer declared, the tita branch
-- around sel/pts, answer_text persisted.
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
  v_answer text;
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

  -- Same scoring curve as submit_answer (derived EV-neutral wrong penalty;
  -- bonus time capped at the BASE cap — the reading window mints no points).
  bonus := round(sc.speed_mult * floor(least(cap - least(t_ans_ms, cap), cap_base)::numeric / sc.grace_block_ms))::int;

  if q.qtype = 'tita' then
    sel := null;
    if v_correct then
      v_answer := q.answer_value;
      pts      := sc.base_points + bonus;
    else
      -- Any value that is not the answer. Appending '.5' shifts the numeric
      -- value by a half regardless of the digits, so it can never collide.
      v_answer := coalesce(q.answer_value, '0') || '.5';
      pts      := 0;   -- no negative marking on TITA
    end if;
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
-- get_debrief_data — a TITA answer has selected_index NULL, so the old
-- `skipped := selected_index is null` reported every answered TITA as a skip.
-- Recreated from 20260715100000; ONE predicate changed (twice: mine + opp).
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

-- ─────────────────────────────────────────────────────────
-- Grants. DROP+CREATE reset each function's ACL to the default (PUBLIC
-- EXECUTE) — restore the pre-existing matrix exactly. anon stays out.
-- ─────────────────────────────────────────────────────────
revoke execute on function get_match_question(uuid, smallint)            from public, anon;
revoke execute on function get_match_question_spectator(uuid, smallint)  from public, anon;
revoke execute on function submit_answer(uuid, smallint, smallint, text) from public, anon;
revoke execute on function get_answer_reveal(uuid, smallint)             from public, anon;
revoke execute on function tita_norm(text)                               from public, anon;
revoke execute on function tita_matches(text, text)                      from public, anon;

grant execute on function get_match_question(uuid, smallint)             to authenticated, service_role;
grant execute on function get_match_question_spectator(uuid, smallint)   to authenticated, service_role;
grant execute on function submit_answer(uuid, smallint, smallint, text)  to authenticated, service_role;
grant execute on function get_answer_reveal(uuid, smallint)              to authenticated, service_role;
grant execute on function tita_matches(text, text)                       to authenticated, service_role;
grant execute on function tita_norm(text)                                to authenticated, service_role;
