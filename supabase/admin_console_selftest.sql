-- Admin console self-test — NOT a migration. Manual, transactional, rolls back.
--
-- Run (local Supabase stack — must connect as a superuser, e.g. `postgres`,
-- because it toggles session_replication_role to bypass the profiles FK while
-- seeding a fake admin):
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/admin_console_selftest.sql
--
-- Expects the admin console migrations (20260713010000/020000/030000) applied.
-- Prints a NOTICE and rolls back; any ASSERT failure aborts with an error.

begin;

do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-000000000abc';
  vpid     uuid;
  r        jsonb;
  cnt      int;
begin
  -- Seed a fake admin without an auth.users row (disable FK/triggers briefly).
  perform set_config('session_replication_role', 'replica', true);
  insert into profiles (id, username, is_admin) values (admin_id, '__selftest_admin', true);
  perform set_config('session_replication_role', 'origin', true);
  -- Make auth.uid() resolve to our admin for the rest of the tx.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id)::text, true);

  -- T1: correct_index out of range -> in errors, not inserted.
  r := admin_upsert_questions(
    '[{"section":"QUANT","passage":null,"questions":[
        {"body":"Bad range","options":["a","b"],"correct_index":5}]}]'::jsonb);
  assert (r->>'inserted')::int = 0, 'T1 inserted != 0: ' || r::text;
  assert (r->>'updated')::int  = 0, 'T1 updated != 0: '  || r::text;
  assert jsonb_array_length(r->'errors') = 1, 'T1 errors != 1: ' || r::text;
  assert (r->'errors'->0->>'reason') ilike '%out of range%', 'T1 reason: ' || r::text;
  assert (r->'errors'->0->>'row') = '1', 'T1 row != 1: ' || r::text;

  -- T2: sub-question whose passage section differs from question section.
  insert into passages (section, body) values ('VARC', 'A VARC passage') returning id into vpid;
  r := admin_upsert_questions(jsonb_build_array(jsonb_build_object(
        'section', 'QUANT',
        'passage_id', vpid,
        'questions', jsonb_build_array(
          jsonb_build_object('body','Stem','options',jsonb_build_array('a','b'),'correct_index',0)))));
  assert (r->>'inserted')::int = 0, 'T2 inserted != 0: ' || r::text;
  assert jsonb_array_length(r->'errors') = 1, 'T2 errors != 1: ' || r::text;
  assert (r->'errors'->0->>'reason') ilike '%section%', 'T2 reason: ' || r::text;

  -- T3: valid 3-question passage group -> inserted=3, no errors, one shared passage.
  r := admin_upsert_questions(
    '[{"section":"VARC","passage":"Shared reading passage","questions":[
        {"body":"S1","options":["a","b","c"],"correct_index":0},
        {"body":"S2","options":["a","b"],"correct_index":1},
        {"body":"S3","options":["a","b"],"correct_index":0}]}]'::jsonb);
  assert (r->>'inserted')::int = 3, 'T3 inserted != 3: ' || r::text;
  assert (r->>'updated')::int  = 0, 'T3 updated != 0: '  || r::text;
  assert jsonb_array_length(r->'errors') = 0, 'T3 errors not empty: ' || r::text;

  select count(distinct passage_id) into cnt
  from questions where body in ('S1','S2','S3') and passage_id is not null;
  assert cnt = 1, 'T3 questions should share exactly one passage';

  raise notice 'ALL ADMIN CONSOLE SELFTESTS PASSED';
end $$;

rollback;
