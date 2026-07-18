-- =========================================================
-- Ninja AI guard harness. Assert-based; raises on any violation, prints
-- NOTICEs on success. Runs in one transaction and ROLLS BACK — no state
-- survives. Inserts into auth.users, so run against a BRANCH or local stack:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/ninja-guard-test.sql
--
-- Against the local Docker stack (no psql on the host):
--   docker exec -i supabase_db_ninjatest psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < scripts/ninja-guard-test.sql
--
-- Asserts the security boundary of the Ninja layer:
--   1. a participant can fetch a question and save a response
--   2. a NON-participant is refused (get_question_for_ninja, save_ninja_response)
--   3. get_ninja_responses returns only the caller's own rows
--   4. unreached questions stay unreadable on a non-completed match
--   5. the 3-attempt re-ask cap holds (the cost guard)
--   6. every ask is refused while the match is still active
--   7. both Ninja reads branch on qtype, so TITA isn't prompted with a blank key
--   8. a caller can see their own live match row under RLS — the data source
--      behind lib/ai/live-match.ts::inLiveMatch, which gates all six
--      user-facing routes (ask, debrief, coach, solve, daily, plan)
--   9. the practice twin of the same boundary (20260717160000): owner-only, an
--      UNANSWERED drill question is refused (practice's reveal gate — the
--      analogue of #4), and the 3-attempt cap holds per (session, question)
--  10. get_learner_profile counts what it claims (20260717190000): a cron
--      timeout is not a skip, rates are own-rows/rated-only, and the ELO slope
--      reads forward in time
--  11. ninja_study_plans is a cost cache: first-write-wins never re-bills, and
--      regenerate is bounded to one rewrite per week IN the RPC
-- =========================================================
begin;

do $$
declare
  ua uuid := gen_random_uuid();   -- participant (the caller under test)
  ub uuid := gen_random_uuid();   -- opponent
  uc uuid := gen_random_uuid();   -- outsider
  qids uuid[]; mid uuid;
  qrow record; rid uuid; n int;
begin
  insert into auth.users (id, aud, role, email) values
    (ua, 'authenticated', 'authenticated', 'ninja-a@test.local'),
    (ub, 'authenticated', 'authenticated', 'ninja-b@test.local'),
    (uc, 'authenticated', 'authenticated', 'ninja-c@test.local');
  insert into profiles (id, username, display_name)
  values (ua, 'ninja_a', 'A'), (ub, 'ninja_b', 'B'), (uc, 'ninja_c', 'C')
  on conflict (id) do nothing;

  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select 'QUANT'::cat_section, 3, 'ninja q' || g, '["w","x","y","z"]'::jsonb, 1, 'because', 1200
  from generate_series(1, 9) g;
  select array_agg(id order by body) into qids from questions where body like 'ninja q%';

  -- completed match A vs B (matches has `check (player_a <> player_b)`, so the
  -- pair must be real; the guards only read player_a/player_b)
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ua, ub, 'completed', false, qids, 1200, 1200, 9, now())
  returning id into mid;

  -- 1. participant can read the question and save
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select * into qrow from get_question_for_ninja(mid, 0);
  if qrow.body is null or qrow.correct_index <> 1 then
    raise exception 'participant read wrong question data: %', qrow;
  end if;
  rid := save_ninja_response(mid, 0, 'test/model', 'Ninja says B.');
  if rid is null then raise exception 'save returned null id'; end if;

  select count(*) into n from get_ninja_responses(mid, 0);
  if n <> 1 then raise exception 'expected 1 own response, got %', n; end if;
  raise notice 'PASS 1: participant reads question + saves + lists own response';

  -- 2. outsider is refused on both surfaces
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  begin
    perform * from get_question_for_ninja(mid, 0);
    raise exception 'FAIL: outsider fetched a question (guard broken)';
  exception when others then
    if sqlerrm not like '%forbidden%' then raise; end if;
  end;
  begin
    perform save_ninja_response(mid, 0, 'test/model', 'hax');
    raise exception 'FAIL: outsider saved a response (guard broken)';
  exception when others then
    if sqlerrm not like '%forbidden%' then raise; end if;
  end;

  -- 3. outsider sees none of A's rows
  select count(*) into n from get_ninja_responses(mid, 0);
  if n <> 0 then raise exception 'outsider saw % of another user''s responses', n; end if;
  raise notice 'PASS 2: non-participant refused on read + save; sees no rows';

  -- 4. unreached-question leak (finding #1): on a non-completed match, a
  -- participant may read served questions but NOT ones the match never reached.
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  declare amid uuid;
  begin
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (ua, ub, 'abandoned', false, qids, 1200, 1200, 2, now())
    returning id into amid;

    -- reached (index 0 < current_index 2) is allowed
    perform * from get_question_for_ninja(amid, 0);

    -- unreached (index 5 > current_index 2) must raise 'question not reached'
    begin
      perform * from get_question_for_ninja(amid, 5);
      raise exception 'FAIL: pulled an unreached question on abandoned match (answer-key leak)';
    exception when others then
      if sqlerrm not like '%not reached%' then raise; end if;
    end;
    raise notice 'PASS 3: unreached questions refused on non-completed match';

    -- 5. re-ask cap (finding #2): 3 attempts per (match, question, user), then refused.
    perform save_ninja_response(amid, 0, 'm', 'a1');
    perform save_ninja_response(amid, 0, 'm', 'a2');
    perform save_ninja_response(amid, 0, 'm', 'a3');
    begin
      perform * from get_question_for_ninja(amid, 0);
      raise exception 'FAIL: 4th ninja attempt allowed (cost cap broken)';
    exception when others then
      if sqlerrm not like '%attempt limit%' then raise; end if;
    end;
    raise notice 'PASS 4: re-ask attempt cap enforced';
  end;

  -- 6. post-match only (20260715010000): on an ACTIVE match every index is
  -- refused, including already-answered ones.
  declare lmid uuid;
  begin
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (ua, ub, 'active', false, qids, 1200, 1200, 2, now())
    returning id into lmid;
    begin
      perform * from get_question_for_ninja(lmid, 0);
      raise exception 'FAIL: ninja answered during an active match';
    exception when others then
      if sqlerrm not like '%still active%' then raise; end if;
    end;
    raise notice 'PASS 5: all asks refused while match is active';
  end;

  -- 7. TITA awareness (20260716201821). A TITA row carries options='[]' and
  -- correct_index=0, and the user's attempt lives in answer_text, not
  -- selected_index. Both Ninja reads must branch on qtype — otherwise the ask
  -- prompt gets a BLANK key and a wrong typed answer reports as a skip.
  declare
    tqid uuid; tmid uuid; tqids uuid[]; trow record; mistakes jsonb; mrow jsonb;
  begin
    insert into questions (section, difficulty, body, options, correct_index,
                           explanation, elo, qtype, answer_value)
    values ('QUANT'::cat_section, 3, 'ninja tita q', '[]'::jsonb, 0,
            'because 42', 1200, 'tita', '42')
    returning id into tqid;
    -- 9 slots; only index 0 is the TITA question under test.
    tqids := array_prepend(tqid, qids[1:8]);

    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (ua, ub, 'completed', false, tqids, 1200, 1200, 9, now())
    returning id into tmid;

    -- The user TYPED a wrong answer: selected_index null, answer_text set.
    insert into match_answers (match_id, user_id, question_id, question_index,
                               selected_index, answer_text, is_correct,
                               points_awarded, time_taken_ms)
    values (tmid, ua, tqid, 0, null, '41', false, -30, 40000);

    select * into trow from get_question_for_ninja(tmid, 0);
    if trow.qtype <> 'tita' then
      raise exception 'FAIL: get_question_for_ninja lost qtype (got %)', trow.qtype;
    end if;
    if trow.answer_value <> '42' then
      raise exception 'FAIL: TITA key missing — ninja would be prompted with a blank correct answer (got %)', trow.answer_value;
    end if;
    if trow.my_answer_text <> '41' then
      raise exception 'FAIL: TITA typed answer not returned — ninja reads it as a skip (got %)', trow.my_answer_text;
    end if;
    raise notice 'PASS 6: get_question_for_ninja returns qtype + key + typed answer for TITA';

    mistakes := get_recent_mistakes(25);
    select m into mrow from jsonb_array_elements(mistakes) m
    where m ->> 'question' = 'ninja tita q';
    if mrow is null then raise exception 'FAIL: TITA mistake absent from get_recent_mistakes'; end if;
    if mrow ->> 'correct_answer' is distinct from '42' then
      raise exception 'FAIL: coach fed null TITA correct_answer (got %)', mrow ->> 'correct_answer';
    end if;
    if mrow ->> 'your_answer' is distinct from '41' then
      raise exception 'FAIL: coach fed null TITA your_answer (got %)', mrow ->> 'your_answer';
    end if;
    if (mrow ->> 'skipped')::boolean then
      raise exception 'FAIL: typed wrong TITA answer reported to the coach as a skip';
    end if;
    raise notice 'PASS 7: get_recent_mistakes reports TITA answers, not nulls-and-skips';
  end;

  -- 8. lib/ai/live-match.ts::inLiveMatch reads `matches` through RLS to gate
  -- /api/ninja/{ask,coach,solve,daily,debrief,plan} — coach and solve are the
  -- free-text routes a player could otherwise paste a live question into from a
  -- second tab; ask and debrief are gated because their per-match RPC guards
  -- (section 6's 'match still active', 'match not finished') only inspect the
  -- match the REQUEST NAMES — mid-match, one aimed at an OLD completed match
  -- passes them. daily and plan take no question input and ride the same rule
  -- for one definition.
  -- It has no RPC to guard it, so assert its data source:
  -- the caller must be able to SEE their own live match row through RLS. That is
  -- the whole property — inLiveMatch filters by the caller's own id, so a leaked
  -- row can't reach it, but a HIDDEN own row silently returns "not in a match"
  -- and fails the gate OPEN, which is the cheat.
  -- Runs under the real `authenticated` role — the rest of this harness is owner
  -- and bypasses RLS entirely (same trick as elo-stress-test section 9).
  declare lmid2 uuid; seen int;
  begin
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (ua, ub, 'active', false, qids, 1200, 1200, 2, now())
    returning id into lmid2;

    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    select count(*) into seen from matches
    where (player_a = ua or player_b = ua) and status in ('active', 'pending');
    if seen = 0 then
      raise exception 'FAIL: participant cannot see their own live match under RLS — inLiveMatch fails open';
    end if;
    reset role;
    raise notice 'PASS 8: live-match visibility under RLS backs the ask/coach/solve/daily/debrief/plan gate';
  end;

  -- 9. Practice asks (20260717160000). Same boundary as the match path, one
  -- guard swapped: "reached" becomes "answered", because submit_practice_answer
  -- is the moment the key is revealed anyway. Before it, sending a drill
  -- question to Ninja would be an answer-key leak over the 45 questions/day a
  -- user can pull — questions is RLS `using(false)` to stop exactly that.
  declare psid uuid; prow record; pn int;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    insert into practice_sessions (user_id, question_ids, current_index)
    values (ua, qids, 1) returning id into psid;
    -- ua answered q0 (wrong: picked 0, key is 1); q1..q8 remain unanswered.
    insert into practice_answers (session_id, question_index, selected_index, is_correct)
    values (psid, 0, 0, false);

    -- answered → served, with the caller's own pick attached so the prompt can
    -- name the distractor they fell for
    select * into prow from get_practice_question_for_ninja(psid, 0);
    if prow.body is null or prow.correct_index <> 1 then
      raise exception 'FAIL: practice ninja read wrong question data: %', prow;
    end if;
    if prow.my_selected_index <> 0 or prow.my_is_correct is not false then
      raise exception 'FAIL: practice ninja lost the caller''s own answer (got %, %)',
        prow.my_selected_index, prow.my_is_correct;
    end if;

    -- UNANSWERED → refused. This is the bank-leak guard.
    begin
      perform * from get_practice_question_for_ninja(psid, 5);
      raise exception 'FAIL: pulled an UNANSWERED practice question (answer-key leak)';
    exception when others then
      if sqlerrm not like '%not answered%' then raise; end if;
    end;

    -- outsider → refused on both the read and the save
    perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
    begin
      perform * from get_practice_question_for_ninja(psid, 0);
      raise exception 'FAIL: outsider read another user''s practice question';
    exception when others then
      if sqlerrm not like '%forbidden%' then raise; end if;
    end;
    begin
      perform save_ninja_practice_response(psid, 0, 'm', 'x');
      raise exception 'FAIL: outsider saved into another user''s practice session';
    exception when others then
      if sqlerrm not like '%forbidden%' then raise; end if;
    end;

    -- 3-attempt cap per (session, question, user) — the cost guard, pre-spend
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    perform save_ninja_practice_response(psid, 0, 'm', 'p1');
    perform save_ninja_practice_response(psid, 0, 'm', 'p2');
    perform save_ninja_practice_response(psid, 0, 'm', 'p3');
    begin
      perform * from get_practice_question_for_ninja(psid, 0);
      raise exception 'FAIL: 4th practice ninja attempt allowed (cost cap broken)';
    exception when others then
      if sqlerrm not like '%attempt limit%' then raise; end if;
    end;

    select count(*) into pn from get_ninja_practice_responses(psid, 0);
    if pn <> 3 then raise exception 'FAIL: expected 3 practice responses, got %', pn; end if;

    -- XOR: a practice row must not also claim a match, and vice versa
    begin
      insert into ninja_responses (user_id, match_id, practice_session_id, question_index, model_id, content)
      values (ua, mid, psid, 0, 'm', 'both');
      raise exception 'FAIL: a ninja_response claimed BOTH a match and a practice session';
    exception when check_violation then null;
    end;

    raise notice 'PASS 9: practice asks are owner-only, answered-only, and capped at 3';
  end;

  -- 10. get_learner_profile (20260717190000). The signal is match_answers x
  -- questions x rating_history rolled up — no LLM. The one thing that reads as a
  -- bug if wrong is the timeout: advance_timed_out writes null skip-rows with
  -- time_taken_ms = NULL, and counting those as skips tells a player who ran out
  -- of clock they keep choosing to skip.
  declare
    lp jsonb; lmid uuid; lqids uuid[]; sec jsonb;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
    lqids := qids; -- reuse the 9 QUANT MCQ rows (elo 1200 → band '1200_1400')

    -- One RATED completed match for uc. q0 correct, q1 a real skip (both indices
    -- null, but a client time IS recorded), q2 a cron TIMEOUT (time_taken_ms NULL).
    insert into matches (player_a, player_b, status, is_rated, question_ids,
                         elo_a_before, elo_b_before, current_index, question_started_at)
    values (uc, ua, 'completed', true, lqids, 1300, 1200, 9, now())
    returning id into lmid;
    insert into match_answers (match_id, user_id, question_id, question_index,
                               selected_index, is_correct, points_awarded, time_taken_ms) values
      (lmid, uc, lqids[1], 0, 1,    true,  100, 30000),   -- correct
      (lmid, uc, lqids[2], 1, null, false, 0,   88000),   -- real skip: null pick, but timed
      (lmid, uc, lqids[3], 2, null, false, 0,   null);    -- cron timeout: time is NULL

    -- Give uc a rating point so the trend window is non-empty, and set the live
    -- ELO to match so deviation (current - window mean) is a clean 0.
    insert into rating_history (user_id, match_id, elo_before, elo_after, delta)
    values (uc, lmid, 1200, 1300, 100);
    update profiles set elo = 1300 where id = uc;

    lp := get_learner_profile(50);
    if (lp ->> 'matches_analyzed')::int <> 1 then
      raise exception 'FAIL: expected 1 rated match analyzed, got %', lp ->> 'matches_analyzed';
    end if;
    -- 3 rows faced, but only 2 graded (the timeout is held out of every rate).
    if (lp ->> 'questions_answered')::int <> 2 then
      raise exception 'FAIL: timeout row leaked into graded set (got % graded)', lp ->> 'questions_answered';
    end if;
    if (lp ->> 'timeouts')::int <> 1 then
      raise exception 'FAIL: timeout not counted as a timeout (got %)', lp ->> 'timeouts';
    end if;

    sec := lp -> 'by_section' -> 'QUANT';
    -- 2 graded (correct + real skip). Skip rate is 1/2, NOT 1/3 or 2/3 — the
    -- cron timeout is neither in the denominator nor counted as a skip.
    if (sec ->> 'answered')::int <> 2 then
      raise exception 'FAIL: section denominator includes the timeout (got %)', sec ->> 'answered';
    end if;
    if (sec ->> 'skip_rate')::numeric <> 0.5 then
      raise exception 'FAIL: skip_rate miscounts timeout-vs-skip (got %, expected 0.5)', sec ->> 'skip_rate';
    end if;
    if (sec ->> 'accuracy')::numeric <> 0.5 then
      raise exception 'FAIL: accuracy over wrong denominator (got %, expected 0.5)', sec ->> 'accuracy';
    end if;
    if (sec ->> 'timeouts')::int <> 1 then
      raise exception 'FAIL: per-section timeout miscount (got %)', sec ->> 'timeouts';
    end if;
    -- ELO band split lands on the bank's own difficulty (1200 → '1200_1400').
    if lp -> 'by_question_elo_band' -> '1200_1400' ->> 'answered' is null then
      raise exception 'FAIL: elo band bucket missing for 1200-elo questions';
    end if;
    -- Trend deviation is current elo (1300) minus the window mean (1300 here).
    if (lp -> 'elo_trend' ->> 'current_elo')::int <> 1300 then
      raise exception 'FAIL: trend current_elo wrong (got %)', lp -> 'elo_trend' ->> 'current_elo';
    end if;
    raise notice 'PASS 10: learner profile counts timeouts as timeouts, not skips, over the rated set';
  end;

  -- 11. ninja_study_plans cost-cache contract (20260717190000).
  declare
    p1 jsonb := '{"diagnosis":"d","target":"t","days":{"Mon":[]}}'::jsonb;
    p2 jsonb := '{"diagnosis":"d2","target":"t2","days":{"Tue":[]}}'::jsonb;
    got jsonb; rc int;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

    -- First write stores it; a second non-replace write is a no-op (never re-bills).
    perform save_ninja_study_plan(p1, 'm1', null, false);
    perform save_ninja_study_plan(p2, 'm2', null, false);
    select plan into got from get_ninja_study_plan(null);
    if got ->> 'diagnosis' <> 'd' then
      raise exception 'FAIL: first-write-wins broken — second save overwrote (got %)', got ->> 'diagnosis';
    end if;

    -- Explicit replace is allowed exactly once.
    perform save_ninja_study_plan(p2, 'm2', null, true);
    select plan, regens into got, rc from get_ninja_study_plan(null);
    if got ->> 'diagnosis' <> 'd2' or rc <> 1 then
      raise exception 'FAIL: first regenerate did not apply (diag %, regens %)', got ->> 'diagnosis', rc;
    end if;

    -- A second replace is refused IN the RPC — the bound doesn't live only in the route.
    begin
      perform save_ninja_study_plan(p1, 'm1', null, true);
      raise exception 'FAIL: second regenerate allowed — weekly bound not enforced in the RPC';
    exception when others then
      if sqlerrm not like '%regenerate limit%' then raise; end if;
    end;
    raise notice 'PASS 11: study plan is first-write-wins with a one-per-week regenerate bound';
  end;
end $$;

rollback;
