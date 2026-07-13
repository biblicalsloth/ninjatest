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
end $$;

rollback;
