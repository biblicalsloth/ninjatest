-- ─────────────────────────────────────────────────────────────────────────────
-- SELF-PACED MATCHES
--
-- Old model: both players moved in lockstep on a single matches.current_index —
-- advance only when BOTH answered question i (maybe_advance) or the cron timed
-- it out. A fast player waited for the slow one on every question; both finished
-- together. That was wrong: players should each traverse their own 9 questions
-- on their own clock, finish independently, and the winner is decided only once
-- BOTH are done.
--
-- New model (human-vs-human):
--   • Each player's position is DERIVED = count of their own match_answers rows
--     (0..9; 9 = finished). No new index column, so it can never desync from the
--     answers that actually exist.
--   • Two new columns hold each player's CURRENT question clock:
--     q_started_a / q_started_b. get_match_question and submit_answer read the
--     caller's own clock; scoring/timeouts are per-player.
--   • submit_answer advances only the caller (sets their next q_started) and
--     finalizes only when BOTH players have 9 answers.
--   • advance_timed_out drains each player independently against their own clock.
--
-- Bot matches keep the OLD shared path unchanged (a bot has no independent
-- clock, is created 'active' with no q_started_*, and bot_act drives the shared
-- current_index via maybe_advance). submit_answer / get_match_question /
-- advance_timed_out branch on `is a bot in this match` and leave that path exactly
-- as it was. maybe_advance stays for the bot path only.
--
-- current_index is kept in sync as least(idx_a, idx_b) purely so the spectator
-- RPCs (which read current_index) still see a valid in-range question.
--
-- Guarded by scripts/elo-stress-test.sql §2 (rewritten for self-pace) and §17.
-- ─────────────────────────────────────────────────────────────────────────────

alter table matches add column if not exists q_started_a timestamptz;
alter table matches add column if not exists q_started_b timestamptz;

-- ── start_match: both players' Q1 clocks start together after a 3s lead-in ──
create or replace function start_match(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or m.status <> 'pending' then return; end if;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  update matches
  set status = 'active', started_at = now(),
      question_started_at = now() + interval '3 seconds',
      q_started_a = now() + interval '3 seconds',
      q_started_b = now() + interval '3 seconds'
  where id = p_match_id;
end;
$$;

-- ── get_match_question: serve the CALLER's current question against THEIR clock ──
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table(question_id uuid, section cat_section, body text, options jsonb,
              qtype text, cap_ms integer, started_at timestamptz,
              passage text, image_url text, passage_image_url text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  perm      integer[];
  shuffled  jsonb;
  v_passage text;
  v_pimage  text;
  v_bot     boolean;
  v_myidx   int;
  v_started timestamptz;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  v_bot := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  if v_bot then
    -- shared path (bot match): the single current_index + shared clock
    if p_index <> m.current_index then raise exception 'not current question'; end if;
    v_started := m.question_started_at;
  else
    -- self-paced: the caller's own progress = their answer count, own clock
    select count(*) into v_myidx from match_answers
    where match_id = p_match_id and user_id = auth.uid();
    if p_index <> v_myidx then raise exception 'not current question'; end if;
    -- q_started_* is always set by start_match/submit_answer in production; the
    -- coalesce is a fallback for direct-inserted test matches.
    v_started := coalesce(case when auth.uid() = m.player_a then m.q_started_a else m.q_started_b end,
                          m.question_started_at);
  end if;

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
    q.id, q.section, q.body, shuffled, q.qtype,
    question_cap_ms(m.question_ids, p_index::int),
    v_started,
    v_passage, q.image_url, v_pimage;
end;
$$;

-- ── submit_answer: score against the caller's own clock, advance only the caller ──
create or replace function submit_answer(p_match_id uuid, p_question_index smallint,
                                         p_selected_index smallint, p_answer_text text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
  v_bot        boolean;
  v_myidx      int;
  v_started    timestamptz;
  v_cnt_a      int;
  v_cnt_b      int;
begin
  perform check_rate_limit('submit_answer', 20, 5);

  select * into m from matches where id = p_match_id for update;
  if not found or m.status <> 'active' then raise exception 'match not active'; end if;
  if uid not in (m.player_a, m.player_b) then raise exception 'not a participant'; end if;

  is_a  := (uid = m.player_a);
  v_bot := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  -- The caller's current question + clock: shared for bots, per-player otherwise.
  if v_bot then
    v_myidx   := m.current_index;
    v_started := m.question_started_at;
  else
    select count(*) into v_myidx from match_answers where match_id = p_match_id and user_id = uid;
    v_started := coalesce(case when is_a then m.q_started_a else m.q_started_b end,
                          m.question_started_at);
  end if;

  if p_question_index <> v_myidx then raise exception 'stale question'; end if;
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
    (extract(epoch from (now() - v_started)) * 1000)::int));

  late := (extract(epoch from (now() - v_started)) * 1000) > cap + 3000;

  grace := round(cfg.speed_mult * floor(least(cap - taken_ms, cap_base)::numeric / cfg.grace_block_ms))::int;

  if q.qtype = 'tita' then
    canonical := null;
    if late or tita_norm(p_answer_text) is null then
      v_answer := null;
    else
      v_answer := btrim(p_answer_text);
    end if;
    correct := (v_answer is not null and tita_matches(v_answer, q.answer_value));
    pts := case
      when late or v_answer is null then 0
      when correct                  then cfg.base_points + grace
      else                               0
    end;
  else
    v_answer := null;
    if p_selected_index is null or late then
      canonical := null;
    elsif p_selected_index < 0 or p_selected_index >= n_opts then
      raise exception 'invalid option';
    else
      perm      := option_perm(p_match_id, uid, p_question_index, n_opts);
      canonical := perm[p_selected_index + 1];
    end if;

    correct := (canonical is not null and canonical = q.correct_index);
    pts := case
      when late               then 0
      when correct            then cfg.base_points + grace
      when canonical is null  then 0
      else                         -round((cfg.base_points + grace)::numeric
                                          / greatest(n_opts - 1, 1))::int
    end;
  end if;

  answered := (canonical is not null or v_answer is not null);

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

  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  suspect := (answered and taken_ms < 2000);
  if correct and suspect then
    insert into match_events(match_id, user_id, question_index, event_type, meta)
    values (p_match_id, uid, p_question_index, 'fast_answer',
            jsonb_build_object('taken_ms', taken_ms, 'section', q.section));
  end if;

  v_calibrates := m.is_rated or exists (
    select 1 from profiles p
    where p.id in (m.player_a, m.player_b) and p.is_bot
  );

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

  if v_bot then
    -- shared path: advance both together once both have answered this index
    perform maybe_advance(p_match_id, p_question_index);
  else
    -- self-paced: start the caller's NEXT question clock (+3s so the between-
    -- question reveal doesn't eat the next question's time, mirroring start_match's
    -- lead-in). Finalize only when BOTH players have all 9 answers.
    if is_a then
      update matches set q_started_a = now() + interval '3 seconds' where id = p_match_id;
    else
      update matches set q_started_b = now() + interval '3 seconds' where id = p_match_id;
    end if;

    select count(*) into v_cnt_a from match_answers where match_id = p_match_id and user_id = m.player_a;
    select count(*) into v_cnt_b from match_answers where match_id = p_match_id and user_id = m.player_b;
    if v_cnt_a >= 9 and v_cnt_b >= 9 then
      perform finalize_match(p_match_id);
    else
      -- keep current_index in range for the spectator RPCs (the lagging player)
      update matches set current_index = least(v_cnt_a, v_cnt_b)::smallint where id = p_match_id;
    end if;
  end if;

  perform broadcast_spectator_update(p_match_id);
end;
$$;

-- ── advance_timed_out: drain each player against their own clock ──
create or replace function advance_timed_out()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r       record;
  cap     integer;
  pid     uuid;
  v_bot   boolean;
  v_idx   int;
  v_start timestamptz;
  v_cnt_a int;
  v_cnt_b int;
begin
  update matches
  set status = 'abandoned', ended_at = now()
  where status = 'pending'
    and created_at < now() - interval '2 minutes';

  for r in select m.* from matches m where m.status = 'active' loop
    v_bot := exists (select 1 from profiles p where p.id in (r.player_a, r.player_b) and p.is_bot);

    if v_bot then
      -- shared drain (bot match): unchanged from the old model
      cap := question_cap_ms(r.question_ids, r.current_index);
      if cap is not null
         and now() >= r.question_started_at + (cap || ' milliseconds')::interval then
        foreach pid in array array[r.player_a, r.player_b] loop
          insert into match_answers (
            match_id, user_id, question_id, question_index,
            selected_index, is_correct, points_awarded, time_taken_ms
          )
          values (r.id, pid, r.question_ids[r.current_index + 1], r.current_index, null, false, 0, null)
          on conflict (match_id, user_id, question_index) do nothing;
        end loop;

        if r.current_index >= 8 then
          perform finalize_match(r.id);
        else
          update matches
          set current_index = r.current_index + 1, question_started_at = now()
          where id = r.id and status = 'active' and current_index = r.current_index;
        end if;
        perform broadcast_spectator_update(r.id);
      end if;

    else
      -- self-paced drain: each player advances against their own q_started, and
      -- a long-absent player is fast-forwarded in one pass by chaining the clock
      -- (next question's start = the deadline that just passed).
      foreach pid in array array[r.player_a, r.player_b] loop
        select count(*) into v_idx from match_answers where match_id = r.id and user_id = pid;
        v_start := coalesce(case when pid = r.player_a then r.q_started_a else r.q_started_b end,
                            r.question_started_at);

        while v_idx < 9 and v_start is not null loop
          cap := question_cap_ms(r.question_ids, v_idx);
          exit when cap is null;
          exit when now() < v_start + (cap || ' milliseconds')::interval;
          insert into match_answers (
            match_id, user_id, question_id, question_index,
            selected_index, is_correct, points_awarded, time_taken_ms
          )
          values (r.id, pid, r.question_ids[v_idx + 1], v_idx, null, false, 0, null)
          on conflict (match_id, user_id, question_index) do nothing;
          v_start := v_start + (cap || ' milliseconds')::interval;
          v_idx   := v_idx + 1;
        end loop;

        if pid = r.player_a then
          update matches set q_started_a = v_start where id = r.id;
        else
          update matches set q_started_b = v_start where id = r.id;
        end if;
      end loop;

      select count(*) into v_cnt_a from match_answers where match_id = r.id and user_id = r.player_a;
      select count(*) into v_cnt_b from match_answers where match_id = r.id and user_id = r.player_b;
      if v_cnt_a >= 9 and v_cnt_b >= 9 then
        perform finalize_match(r.id);
      else
        update matches set current_index = least(v_cnt_a, v_cnt_b)::smallint where id = r.id;
      end if;
      perform broadcast_spectator_update(r.id);
    end if;
  end loop;
end;
$$;

-- ── forfeit_match: absence is judged against the QUITTER's own clock/progress ──
create or replace function forfeit_match(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  cap             integer;
  prev_absent     boolean;
  v_bot           boolean;
  v_qidx          int;
  v_qstart        timestamptz;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  quitter := case when present_player = m.player_a then m.player_b else m.player_a end;
  v_bot   := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  -- the quitter's own position + clock (shared for a bot match)
  if v_bot then
    v_qidx   := m.current_index;
    v_qstart := m.question_started_at;
  else
    select count(*) into v_qidx from match_answers where match_id = p_match_id and user_id = quitter;
    v_qstart := coalesce(case when quitter = m.player_a then m.q_started_a else m.q_started_b end,
                         m.question_started_at);
  end if;

  -- A cron skip-row (null time) on the quitter's PREVIOUS question proves they
  -- already missed a full deadline.
  prev_absent := v_qidx > 0 and exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = v_qidx - 1
      and selected_index is null and time_taken_ms is null
  );

  -- If the quitter already answered their current question, they're not absent.
  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = quitter
      and question_index = v_qidx
      and (selected_index is not null or time_taken_ms is not null)
  ) then
    raise exception 'opponent answered — not absent';
  end if;

  if not prev_absent then
    cap := question_cap_ms(m.question_ids, v_qidx);
    -- fails closed: a NULL cap (quitter finished, or missing row) means 'too early'
    if v_qstart is null or cap is null
       or now() < v_qstart + ((cap + 5000)::text || ' milliseconds')::interval then
      raise exception 'too early to forfeit — opponent still within the question deadline';
    end if;
  end if;

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
