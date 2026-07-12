-- =========================================================
-- Question-ELO auto-weighting pipeline.
--
--   1. submit_answer     — provisional K for new questions, time-weighted
--                          result signal, [400, 2800] clamp, suspected-cheat
--                          (fast_answer) submissions excluded from ELO updates.
--   2. admin_upsert_questions — seed question ELO from difficulty on insert
--                          (elo = 1000 + difficulty*100, same as the
--                          20260713000000 backfill); re-seed on update only
--                          while evidence is thin (times_seen < 20). Also:
--                          duration_ms must now be a positive integer, and
--                          updates no longer detach a question from its
--                          passage when the group omits passage fields.
--   3. pick_section_question_ids(section, target_elo) — adaptive selection:
--                          questions (and passage groups, by mean question
--                          ELO) biased toward the players' average ELO with
--                          random()*300 jitter. Wired into try_match_internal
--                          and accept_challenge. Replaces both the random
--                          1-arg picker (20260713030000) and the dead
--                          pick_questions() (20260713000300).
--
-- Constants (simulation-backed, scripts/simulate-question-elo.mjs):
--   K = 32 while times_seen < 20, then 16 — halves time-to-converge for new
--   questions without visible steady-state noise increase.
--   res_q: wrong = 1.0; correct = 0.35 * (taken_ms / cap) — a slow correct
--   answer is weak evidence the question is easy, a fast one strong evidence.
-- ponytail: constants inline; move to a config table when tuning becomes routine.
-- =========================================================

-- ── 1. submit_answer — restated from 20260713000300 (shuffle mapping KEPT,
--       see 20260713040000). Only the question-ELO block changes. ────────────
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
  k_q        integer;
  suspect    boolean;
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

  -- Implausibly-fast correct answer (< 2s): telemetry, and excluded from the
  -- question-ELO update so suspected cheats can't poison difficulty ratings.
  -- ponytail: flat 2s threshold; per-section thresholds if false positives matter.
  suspect := (correct and taken_ms < 2000);
  if suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  -- Per-question ELO nudge. Only a real, non-suspect answer is signal; a
  -- timeout skip isn't. Question "wins" when the player gets it wrong.
  -- Time-weighted result: a barely-in-time correct answer still says the
  -- question is on the hard side. Provisional K while evidence is thin.
  if canonical is not null and not suspect then
    select elo into player_elo from profiles where id = uid;
    exp_q := 1.0 / (1.0 + power(10.0, (player_elo - q.elo) / 400.0));
    res_q := case when correct
                  then 0.35 * (taken_ms::numeric / greatest(cap, 1))
                  else 1.0 end;
    k_q   := case when q.times_seen < 20 then 32 else 16 end;
    update questions
      set elo = greatest(400, least(2800, round(elo + k_q * (res_q - exp_q))::int)),
          times_seen = times_seen + 1
      where id = q.id;
  else
    update questions set times_seen = times_seen + 1 where id = q.id;
  end if;

  perform maybe_advance(p_match_id, p_question_index);
  perform broadcast_spectator_update(p_match_id);
end; $$;

-- ── 2. admin_upsert_questions — restated from 20260713020000. Changes:
--       * insert seeds elo from difficulty; update re-seeds only if times_seen < 20
--       * duration_ms, when provided, must be a positive integer (was: silently
--         nulled; a non-positive cap made correct answers score negative points)
--       * update only touches passage_id when the group references a passage,
--         so editing a question without passage fields no longer detaches it ──
create or replace function admin_upsert_questions(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  grp                jsonb;
  q                  jsonb;
  n_row              int   := 0;
  v_inserted         int   := 0;
  v_updated          int   := 0;
  v_errors           jsonb := '[]'::jsonb;
  v_section          text;
  v_section_ok       boolean;
  v_passage_text     text;
  v_in_passage_id    uuid;
  v_existing_section text;
  v_refs_passage     boolean;
  v_passage_error    text;
  v_passage_resolved boolean;
  v_resolved_pid     uuid;
  v_err              text;
  v_difficulty       smallint;
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  for grp in select jsonb_array_elements(coalesce(payload, '[]'::jsonb)) loop
    -- ── group-level setup ──
    v_section        := grp->>'section';
    v_section_ok     := v_section in ('VARC', 'DILR', 'QUANT');
    v_passage_text   := grp->>'passage';                         -- null if absent/json-null
    v_in_passage_id  := nullif(grp->>'passage_id', '')::uuid;    -- null if absent/json-null
    v_refs_passage   := (v_passage_text is not null) or (v_in_passage_id is not null);
    v_passage_error  := null;
    v_passage_resolved := false;
    v_resolved_pid   := null;

    if not v_section_ok then
      v_passage_error := 'invalid section: ' || coalesce(v_section, '(null)');
    elsif v_in_passage_id is not null then
      select p.section::text into v_existing_section from passages p where p.id = v_in_passage_id;
      if not found then
        v_passage_error := 'passage_id not found';
      elsif v_existing_section <> v_section then
        v_passage_error := format('passage section %s does not match question section %s',
                                  v_existing_section, v_section);
      end if;
    end if;

    -- ── per-question ──
    for q in select jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb)) loop
      n_row := n_row + 1;

      if v_passage_error is not null then
        v_err := v_passage_error;
      elsif coalesce(btrim(q->>'body'), '') = '' then
        v_err := 'body is empty or blank';
      elsif jsonb_typeof(q->'options') is distinct from 'array'
            or coalesce(jsonb_array_length(q->'options'), 0) = 0 then
        v_err := 'options must be a non-empty array';
      elsif exists (select 1 from jsonb_array_elements(q->'options') e where jsonb_typeof(e) <> 'string') then
        v_err := 'options must all be strings';
      elsif (q->>'correct_index') is null or (q->>'correct_index') !~ '^-?[0-9]+$' then
        v_err := 'correct_index must be an integer';
      elsif (q->>'correct_index')::int < 0
            or (q->>'correct_index')::int > jsonb_array_length(q->'options') - 1 then
        v_err := 'correct_index out of range';
      elsif (q ? 'difficulty') and (q->>'difficulty') is not null
            and ((q->>'difficulty') !~ '^-?[0-9]+$'
                 or (q->>'difficulty')::int < 1 or (q->>'difficulty')::int > 5) then
        v_err := 'difficulty must be between 1 and 5';
      elsif (q ? 'duration_ms') and (q->>'duration_ms') is not null
            and ((q->>'duration_ms') !~ '^[0-9]+$' or (q->>'duration_ms')::bigint <= 0
                 or (q->>'duration_ms')::bigint > 2147483647) then
        v_err := 'duration_ms must be a positive integer';
      else
        v_err := null;
      end if;

      if v_err is not null then
        v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', v_err);
        continue;
      end if;

      -- Resolve the passage lazily on the first VALID question of the group,
      -- so a fully-invalid group never leaves an orphan passage.
      if not v_passage_resolved then
        if v_refs_passage then
          if v_in_passage_id is not null then
            v_resolved_pid := v_in_passage_id;
            if v_passage_text is not null then
              update passages set body = v_passage_text where id = v_in_passage_id;
            end if;
          else
            insert into passages (section, body)
            values (v_section::cat_section, v_passage_text)
            returning id into v_resolved_pid;
          end if;
        else
          v_resolved_pid := null;
        end if;
        v_passage_resolved := true;
      end if;

      v_difficulty := coalesce((q->>'difficulty')::smallint, 3);

      if (q ? 'id') and nullif(q->>'id', '') is not null then
        update questions set
          section       = v_section::cat_section,
          difficulty    = v_difficulty,
          body          = q->>'body',
          options       = q->'options',
          correct_index = (q->>'correct_index')::smallint,
          explanation   = q->>'explanation',
          duration_ms   = (q->>'duration_ms')::int,
          -- keep the passage link unless this upload explicitly references one
          passage_id    = case when v_refs_passage then v_resolved_pid else passage_id end,
          -- re-seed only while evidence is thin; never clobber a converged rating
          elo           = case when times_seen < 20 then 1000 + v_difficulty * 100 else elo end
        where id = (q->>'id')::uuid;
        if found then
          v_updated := v_updated + 1;
        else
          v_errors := v_errors || jsonb_build_object('row', n_row, 'reason', 'question id not found');
        end if;
      else
        insert into questions (section, difficulty, body, options, correct_index,
                               explanation, duration_ms, passage_id, elo)
        values (
          v_section::cat_section,
          v_difficulty,
          q->>'body',
          q->'options',
          (q->>'correct_index')::smallint,
          q->>'explanation',
          (q->>'duration_ms')::int,
          v_resolved_pid,
          1000 + v_difficulty * 100
        );
        v_inserted := v_inserted + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'errors', v_errors);
end;
$$;

-- ── 3. Adaptive, passage-aware selection ─────────────────────────────────────
-- Same contract as the 20260713030000 picker (3 ids per section, passage
-- groups preferred for VARC/DILR, NULL on empty pool) but biased toward
-- p_target_elo with random()*300 jitter so the nearest questions aren't
-- drained every match. Passage groups compete by mean sub-question ELO.
drop function if exists pick_section_question_ids(cat_section);
drop function if exists pick_questions(integer, cat_section);  -- dead since 20260713030000

create function pick_section_question_ids(p_section cat_section, p_target_elo integer)
returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_ids  uuid[];
  v_pid  uuid;
begin
  if p_section = 'QUANT' then
    select array_agg(id) into v_ids from (
      select id from questions
      where section = p_section and is_active
      order by abs(elo - p_target_elo) + random() * 300 limit 3
    ) s;
    return v_ids;
  end if;

  -- VARC / DILR: try a passage group first, nearest mean ELO wins (with jitter).
  select p.id into v_pid
  from passages p
  join questions q on q.passage_id = p.id and q.is_active
  where p.section = p_section and p.is_active
  group by p.id
  having count(*) >= 3
  order by abs(avg(q.elo) - p_target_elo) + random() * 300
  limit 1;

  if v_pid is not null then
    select array_agg(id order by created_at) into v_ids from (
      select id, created_at from questions
      where passage_id = v_pid and is_active
      order by created_at limit 3
    ) s;
    return v_ids;
  end if;

  -- Fallback: standalone questions only.
  select array_agg(id) into v_ids from (
    select id from questions
    where section = p_section and is_active and passage_id is null
    order by abs(elo - p_target_elo) + random() * 300 limit 3
  ) s;
  return v_ids;
end;
$$;

-- Internal helper: only called from other SECURITY DEFINER builders.
revoke execute on function pick_section_question_ids(cat_section, integer) from public, anon, authenticated;

-- ── 3a. try_match_internal — restated from 20260713030000, target-ELO picks ──
create or replace function try_match_internal(p_user_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
  target       integer;
begin
  select * into me
  from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  my_band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  target := ((me.elo + opp.elo) / 2)::int;
  q_ids := coalesce(pick_section_question_ids('VARC',  target), '{}')
        || coalesce(pick_section_question_ids('DILR',  target), '{}')
        || coalesce(pick_section_question_ids('QUANT', target), '{}');

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids, me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

-- ── 3b. accept_challenge — restated from 20260713030000, target-ELO picks
--        (single-section mode gets the same bias+jitter, 9 from one section) ──
create or replace function accept_challenge(p_code text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
  target    int;
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
  target := ((host_elo + me_elo) / 2)::int;

  if ch.section_mode is null then
    q_ids := coalesce(pick_section_question_ids('VARC',  target), '{}')
          || coalesce(pick_section_question_ids('DILR',  target), '{}')
          || coalesce(pick_section_question_ids('QUANT', target), '{}');
  else
    select array_agg(id) into q_ids from (
      select id from questions
      where section = ch.section_mode and is_active
      order by abs(elo - target) + random() * 300 limit 9
    ) s;
  end if;

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;
