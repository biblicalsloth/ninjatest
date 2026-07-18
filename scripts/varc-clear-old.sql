-- Backs up + clears the old temporary VARC rows before loading the extracted bank.
-- FK-safe: match_answers.question_id is the only hard FK into questions; rows referenced
-- there are DEACTIVATED (can't delete), unreferenced rows are DELETED. Idempotent-ish:
-- re-running just re-backs-up an empty set. Run ONCE before load-varc-questions.mjs.
--
-- Run via the linked remote:  SUPABASE_DB_PASSWORD=… supabase db push is for migrations —
-- this is data, so run it through psql/the container instead, e.g.:
--   docker exec -i supabase_db_ninjatest psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/varc-clear-old.sql
-- (remote: pipe to the pooler connection string). Wrapped in a txn — all or nothing.

begin;

-- 1. snapshot everything VARC (questions + passages) for rollback
create table if not exists _backup_varc_temp_20260718 as
  select * from questions where section = 'VARC';
create table if not exists _backup_varc_passages_20260718 as
  select * from passages where section = 'VARC';

-- 2. deactivate VARC questions referenced by played answers (hard FK — keep for replay/reveal)
update questions
   set is_active = false
 where section = 'VARC'
   and id in (select distinct question_id from match_answers);

-- 3. delete the unreferenced old VARC questions
delete from questions
 where section = 'VARC'
   and id not in (select distinct question_id from match_answers);

-- 4. old VARC passages: none expected (table starts empty), but clear any unreferenced
delete from passages
 where section = 'VARC'
   and id not in (select passage_id from questions where passage_id is not null);

-- report
do $$
declare kept int; gone int; pass int;
begin
  select count(*) into kept from questions where section='VARC' and is_active = false;
  select count(*) into gone from _backup_varc_temp_20260718;
  select count(*) into pass from passages where section='VARC';
  raise notice 'VARC cleared: % backed up, % deactivated (kept for FK), % passages remain', gone, kept, pass;
end $$;

commit;
