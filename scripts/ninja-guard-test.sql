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

end $$;

rollback;
