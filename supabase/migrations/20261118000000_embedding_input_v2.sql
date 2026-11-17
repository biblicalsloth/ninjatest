-- ─────────────────────────────────────────────────────────────────────────────
-- Embedding input v2: passage + stem + options (was stem only).
--
-- Measured on prod 2026-11-17: stem-only embeddings made "similar" near-
-- meaningless for generic stems — 31 "Choose the word that does not belong"
-- rows embedded identically (content lives in the options) and 300+ RC/caselet
-- stems ("Which statement is true?") matched unrelated passages. The contract
-- now lives in embedInput() in scripts/backfill-embeddings.mjs.
--
-- Because the input now spans three columns and a second table, the staleness
-- rule widens with it:
--   * questions: body, options, or passage_id change -> null the embedding
--   * passages:  body change -> null every child question's embedding
-- Then every embedding is nulled once so the backfill re-embeds the whole bank
-- under v2. Until it runs, start_practice_similar uses its same-section/ELO
-- fallback and the picker near-dup guard (next migration) is a no-op — both
-- are designed to tolerate NULL.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function questions_null_stale_embedding()
returns trigger
language plpgsql
set search_path = pg_catalog, public as $$
begin
  -- `update of ...` fires when a column is *mentioned*, not only when it changes.
  if new.body       is distinct from old.body
  or new.options    is distinct from old.options
  or new.passage_id is distinct from old.passage_id then
    new.embedding := null;
  end if;
  return new;
end; $$;

drop trigger if exists questions_null_stale_embedding_trg on questions;
create trigger questions_null_stale_embedding_trg
  before update of body, options, passage_id on questions
  for each row execute function questions_null_stale_embedding();

-- A caselet/RC edit changes the input of every sibling.
create or replace function passages_null_child_embeddings()
returns trigger
language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.body is distinct from old.body then
    update questions set embedding = null
    where passage_id = new.id and embedding is not null;
  end if;
  return null;
end; $$;

drop trigger if exists passages_null_child_embeddings_trg on passages;
create trigger passages_null_child_embeddings_trg
  after update of body on passages
  for each row execute function passages_null_child_embeddings();

-- Trigger functions run from table writes only; no client role calls them.
revoke all on function questions_null_stale_embedding()  from public, anon, authenticated;
revoke all on function passages_null_child_embeddings()  from public, anon, authenticated;

-- Re-embed everything under v2. Run `node scripts/backfill-embeddings.mjs` after.
update questions set embedding = null where embedding is not null;

comment on column questions.embedding is
  'openai/text-embedding-3-small (via OpenRouter) over passage body + stem + options — see embedInput() in scripts/backfill-embeddings.mjs (v2, 20261118000000); query-time embedding MUST use the same shape or the query vector lands in a different space. NULL = needs (re)embedding; the backfill script picks up NULLs. Nulled automatically when body/options/passage_id or the parent passage body changes.';
