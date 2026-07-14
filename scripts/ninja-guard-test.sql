-- =========================================================
-- Ninja AI guard harness. Assert-based; raises on any violation, prints
-- NOTICEs on success. Runs in one transaction and ROLLS BACK — no state
-- survives. Inserts into auth.users, so run against a BRANCH or local stack:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/ninja-guard-test.sql
--
-- Asserts the security boundary of the Ninja layer:
--   1. a participant can fetch a question and save a response
--   2. a NON-participant is refused (get_question_for_ninja, save_ninja_response)
--   3. get_ninja_responses returns only the caller's own rows
-- =========================================================
begin;

do $$
declare
  ua uuid := gen_random_uuid();   -- participant
  uc uuid := gen_random_uuid();   -- outsider
  qids uuid[]; mid uuid;
  qrow record; rid uuid; n int;
begin
  insert into auth.users (id, aud, role, email) values
    (ua, 'authenticated', 'authenticated', 'ninja-a@test.local'),
    (uc, 'authenticated', 'authenticated', 'ninja-c@test.local');
  insert into profiles (id, username, display_name)
  values (ua, 'ninja_a', 'A'), (uc, 'ninja_c', 'C') on conflict (id) do nothing;

  insert into questions (section, difficulty, body, options, correct_index, explanation, elo)
  select 'QUANT'::cat_section, 3, 'ninja q' || g, '["w","x","y","z"]'::jsonb, 1, 'because', 1200
  from generate_series(1, 9) g;
  select array_agg(id order by body) into qids from questions where body like 'ninja q%';

  -- completed match A vs A (self-pair keeps the fixture minimal; guard only reads player_a/player_b)
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, current_index, question_started_at)
  values (ua, ua, 'completed', false, qids, 1200, 1200, 9, now())
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
    values (ua, ua, 'abandoned', false, qids, 1200, 1200, 2, now())
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
    values (ua, ua, 'active', false, qids, 1200, 1200, 2, now())
    returning id into lmid;
    begin
      perform * from get_question_for_ninja(lmid, 0);
      raise exception 'FAIL: ninja answered during an active match';
    exception when others then
      if sqlerrm not like '%still active%' then raise; end if;
    end;
    raise notice 'PASS 5: all asks refused while match is active';
  end;
end $$;

rollback;
