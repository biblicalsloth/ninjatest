-- ─────────────────────────────────────────────────────────
-- Practice serves TITA.
--
-- 20260716212156 made start_practice MCQ-only, deliberately: a TITA in a drill
-- was unanswerable (get_practice_question returned options — '[]' for TITA — and
-- no qtype, and submit_practice_answer took only p_selected, so no options
-- rendered and every submit scored wrong). Excluding was one line; this is the
-- rest of the work it deferred, so the 52 TITA can be drilled solo instead of
-- only appearing 1-in-3 inside a live match.
--
-- FOUR pieces, and the fourth is the non-obvious one:
--
-- 1. practice_answers.answer_text — TITA is scored by tita_matches against a
--    typed string, not by an index. Mirrors match_answers. The canonical skip
--    notion follows the match path exactly (20260716130000): skip = BOTH
--    selected_index and answer_text null. Never test selected_index alone.
--
-- 2. get_practice_question returns qtype so the client knows to render a typed
--    box instead of an options grid. It does NOT return answer_value — the key
--    must not cross the wire before the answer is locked, or the drill is a
--    self-serve answer sheet. submit_practice_answer reveals it, and only then.
--
-- 3. submit_practice_answer takes p_answer_text and branches. Signature grows a
--    parameter, so this is a DROP + CREATE, not a replace — a create-or-replace
--    with an extra arg makes an OVERLOAD, and two candidates make PostgREST
--    ambiguous. The 4th arg is defaulted, so existing 3-arg callers still bind.
--    Grants re-applied after the drop.
--
-- 4. get_practice_question_for_ninja stops hardcoding my_answer_text.
--    20260717160000 returns `null::text` for it, which was correct while
--    practice was MCQ-only. The moment a drill can serve TITA that null becomes
--    a LIE: buildQuestionPrompt does `attempted = isTita ? my_answer_text != null
--    : my_selected_index != null`, so a user who typed a wrong answer would be
--    told they skipped — precisely the bug 20260716201821 fixed for the match
--    path. (CLAUDE.md's "a TITA-aware practice mode needs no change on the Ninja
--    side" was written against the MCQ-only assumption and does not survive this
--    migration.) Recreated from 20260717160000's definition; only that one
--    expression changes.
--
-- Practice still awards no points and never nudges question ELO — unchanged and
-- deliberate: it is solo and unrated, so it is not a calibration signal and not
-- a collusion channel.
-- ─────────────────────────────────────────────────────────

alter table practice_answers add column if not exists answer_text text;

-- ── 0. The QUANT quota floor only makes sense from 3 slots up ──
-- Recreated from 20260716220817. greatest(1, ...) was written for the match,
-- which only ever asks for 3 or 9 — both unaffected. Practice asks for 1, 3 or 5
-- (weakest-section-first), and at p_total=1 the floor forced n_tita=1, i.e. a
-- 100% TITA "QUANT slot" for anyone whose strongest section is QUANT. Below 3
-- slots there is no honest 1-in-3, so take none.
create or replace function pick_quant_question_ids(
  p_target_elo integer,
  p_total integer,
  p_users uuid[] default '{}'
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n_tita int := case when p_total >= 3 then greatest(1, round(p_total / 3.0)::int) else 0 end;
  v_seen uuid[];
  v_tita uuid[];
  v_mcq  uuid[];
  v_ids  uuid[];
begin
  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = any(p_users);

  select array_agg(t.id) into v_tita from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'tita'
    order by (q.id = any(v_seen))::int,
             abs(q.elo - p_target_elo) + random() * 300
    limit n_tita
  ) t;
  v_tita := coalesce(v_tita, '{}');

  select array_agg(t.id) into v_mcq from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'mcq'
    order by (q.id = any(v_seen))::int,
             abs(q.elo - p_target_elo) + random() * 300
    limit p_total - coalesce(array_length(v_tita, 1), 0)
  ) t;
  v_mcq := coalesce(v_mcq, '{}');

  select array_agg(x order by random()) into v_ids
  from unnest(v_tita || v_mcq) x;

  return coalesce(v_ids, '{}');
end $$;

revoke all on function pick_quant_question_ids(integer, integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_quant_question_ids(integer, integer, uuid[]) to service_role;

-- ── 1. start_practice: TITA is drillable again ──
-- Recreated from 20260716212156. Dropping the qtype='mcq' filter is NOT enough:
-- start_practice picked on ELO alone, and TITA seeds +100 above the MCQ scale
-- (20260716212156), so at a fresh player's 1000 the MCQs at 1100 win every slot
-- and TITA is served exactly as often as when it was filtered out — measured 0
-- across 5 sessions. So the QUANT slot delegates to pick_quant_question_ids,
-- the single source of truth for the QUANT type mix, which also brings the
-- unseen preference (20260716220817) that practice never had.
create or replace function start_practice()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid         uuid := (select auth.uid());
  today_count int;
  player_elo  int;
  ordered     text[];
  wanted      int[] := array[5, 3, 1];
  ids         uuid[] := '{}';
  sec_ids     uuid[];
  v_seen      uuid[];
  i           int;
  sid         uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('start_practice', 5, 60);

  select count(*) into today_count
  from practice_sessions
  where user_id = uid and created_at >= date_trunc('day', now());
  if today_count >= 5 then
    raise exception 'daily practice limit reached';
  end if;

  select elo into player_elo from profiles where id = uid;

  -- Sections ordered weakest-first by the caller's real accuracy; sections
  -- with <5 real answers count as neutral 0.5 so newcomers get 3/3/3-ish.
  -- Skip = selected_index AND answer_text both null (canonical, 20260716130000).
  select array_agg(s.sec order by s.acc asc, s.sec) into ordered
  from (
    select sec.sec,
           coalesce((
             select case when count(*) >= 5
                         then avg(case when a.is_correct then 1.0 else 0.0 end) end
             from match_answers a
             join questions q on q.id = a.question_id
             where a.user_id = uid
               and not (a.selected_index is null and a.answer_text is null)
               and q.section = sec.sec::cat_section
           ), 0.5) as acc
    from (values ('VARC'), ('DILR'), ('QUANT')) sec(sec)
  ) s;

  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = uid;

  for i in 1..3 loop
    if ordered[i] = 'QUANT' then
      -- One place decides the QUANT type mix; practice must not grow a second.
      sec_ids := pick_quant_question_ids(player_elo, wanted[i], array[uid]);
    else
      select array_agg(t.id) into sec_ids
      from (
        select q.id
        from questions q
        where q.section = ordered[i]::cat_section and q.is_active
        order by (q.id = any(v_seen))::int,
                 abs(q.elo - (player_elo + (random() * 300 - 150)::int)), random()
        limit wanted[i]
      ) t;
    end if;
    ids := ids || coalesce(sec_ids, '{}');
  end loop;

  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'no practice questions available';
  end if;

  insert into practice_sessions (user_id, question_ids)
  values (uid, ids)
  returning id into sid;

  return jsonb_build_object('session_id', sid, 'total', array_length(ids, 1));
end; $$;

revoke all on function start_practice() from public, anon;
grant execute on function start_practice() to authenticated, service_role;

-- ── 2. get_practice_question: + qtype, still no key ──
-- Return type changes → drop + recreate.
drop function if exists get_practice_question(uuid, int);
create function get_practice_question(p_session uuid, p_index int)
returns table(section text, body text, options jsonb, qtype text,
              image_url text, passage_body text, passage_image_url text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare s practice_sessions%rowtype;
begin
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  if p_index <> s.current_index or p_index >= array_length(s.question_ids, 1) then
    raise exception 'bad index';
  end if;

  return query
    select q.section::text, q.body, q.options, q.qtype, q.image_url,
           p.body, p.image_url
    from questions q
    left join passages p on p.id = q.passage_id
    where q.id = s.question_ids[p_index + 1];
end; $$;

revoke all on function get_practice_question(uuid, int) from public, anon;
grant execute on function get_practice_question(uuid, int) to authenticated, service_role;

-- ── 3. submit_practice_answer: score a typed answer ──
drop function if exists submit_practice_answer(uuid, int, int);
create function submit_practice_answer(
  p_session uuid,
  p_index int,
  p_selected int,
  p_answer_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s practice_sessions%rowtype;
  q questions%rowtype;
  v_correct boolean;
  v_answer  text;
  total int;
begin
  select * into s from practice_sessions where id = p_session for update;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  total := array_length(s.question_ids, 1);
  if p_index <> s.current_index or p_index >= total then raise exception 'bad index'; end if;

  select * into q from questions where id = s.question_ids[p_index + 1];

  if q.qtype = 'tita' then
    -- A blank / whitespace-only entry is a skip, not a wrong answer, matching
    -- submit_answer. p_selected is ignored: TITA has no options.
    v_answer  := case when tita_norm(p_answer_text) is null then null
                      else btrim(p_answer_text) end;
    v_correct := (v_answer is not null and tita_matches(v_answer, q.answer_value));
    insert into practice_answers (session_id, question_index, selected_index, answer_text, is_correct)
    values (p_session, p_index, null, v_answer, v_correct);
  else
    if p_selected is not null
       and (p_selected < 0 or p_selected > jsonb_array_length(q.options) - 1) then
      raise exception 'bad option';
    end if;
    v_correct := p_selected is not null and p_selected = q.correct_index;
    insert into practice_answers (session_id, question_index, selected_index, answer_text, is_correct)
    values (p_session, p_index, p_selected, null, v_correct);
  end if;

  update practice_sessions set
    current_index = p_index + 1,
    correct_count = correct_count + (v_correct::int),
    completed_at  = case when p_index + 1 >= total then now() else completed_at end
  where id = p_session;

  return jsonb_build_object(
    'is_correct', v_correct,
    'qtype', q.qtype,
    -- correct_index is meaningless for TITA; answer_value is the key it reveals.
    'correct_index', case when q.qtype = 'tita' then null else q.correct_index end,
    'answer_value', case when q.qtype = 'tita' then q.answer_value else null end,
    'explanation', q.explanation,
    'done', p_index + 1 >= total
  );
end; $$;

revoke all on function submit_practice_answer(uuid, int, int, text) from public, anon;
grant execute on function submit_practice_answer(uuid, int, int, text) to authenticated, service_role;

-- ── 4. get_practice_question_for_ninja: report the typed answer, not a null ──
-- Recreated from 20260717160000; only my_answer_text stops being hardcoded null.
create or replace function get_practice_question_for_ninja(p_session uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text,
              my_selected_index smallint, my_is_correct boolean,
              qtype text, answer_value text, my_answer_text text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  s        practice_sessions%rowtype;
  q        questions%rowtype;
  a        practice_answers%rowtype;
  attempts int;
begin
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  if p_index < 0 or p_index >= coalesce(array_length(s.question_ids, 1), 0) then
    raise exception 'bad index';
  end if;

  -- Reveal gate: only an ANSWERED question may be sent to Ninja. Until the
  -- answer is locked, submit_practice_answer hasn't revealed the key either.
  select * into a from practice_answers
  where session_id = p_session and question_index = p_index;
  if not found then raise exception 'question not answered'; end if;

  -- Per-(session, question, user) re-ask ceiling — pre-spend, so an exhausted
  -- question never triggers another generation. Same 3 as the match path.
  select count(*) into attempts
  from ninja_responses
  where practice_session_id = p_session and user_id = (select auth.uid())
    and question_index = p_index;
  if attempts >= 3 then raise exception 'ninja attempt limit reached'; end if;

  select * into q from questions where id = s.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id),
           a.selected_index, a.is_correct,
           q.qtype, q.answer_value, a.answer_text;
end; $$;

revoke all on function get_practice_question_for_ninja(uuid, int) from public, anon;
grant execute on function get_practice_question_for_ninja(uuid, int) to authenticated, service_role;
