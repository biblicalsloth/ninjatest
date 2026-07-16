-- ─────────────────────────────────────────────────────────
-- pgvector over the question bank: extension, column, staleness trigger,
-- and the search primitive. No consumer wired yet — grants stay minimal
-- until one exists (see the grant note at the bottom).
--
-- SECURITY, the load-bearing part: search_questions returns IDS ONLY, never
-- bodies. `questions` is RLS `using (false)` and every body-serving RPC
-- (get_match_question, get_question_for_ninja, get_practice_question) is
-- reached-guarded on purpose. An endpoint that returns question text for an
-- arbitrary caller-supplied embedding is a bank-scraping oracle and would
-- undo all of that. Ids are inert: they can only be redeemed through those
-- same guarded RPCs. Do not widen the return type to include body/options.
-- ─────────────────────────────────────────────────────────

-- pgcrypto already lives in `extensions`; match it. Anything calling vector
-- operators needs `extensions` on its search_path (the blanket pin in
-- 20260627000000 is pg_catalog, public only).
create extension if not exists vector with schema extensions;

-- 1536 = text-embedding-3-small's native width. Generated via OpenRouter
-- (openai/text-embedding-3-small) using the same OPENROUTER_API_KEY as the rest
-- of the repo — it proxies OpenAI's embedding models on the standard /embeddings
-- path even though they're absent from its /models catalog. Anthropic publishes
-- no embedding model at all, so there is no Claude option for this slot; GLM in
-- ai_config is the *chat* model and is unrelated.
-- scripts/backfill-embeddings.mjs is the only writer.
alter table questions
  add column if not exists embedding extensions.vector(1536);

-- pgvector defaults vector columns to EXTERNAL storage, so every 6148-byte
-- embedding lands out-of-line in TOAST and an exact scan pays a detoast per row.
-- Measured on this bank (1247 active): EXTERNAL = 75ms / 15119 buffers,
-- PLAIN = 12ms / 7667 buffers — 6x, for one ALTER. PLAIN is safe here because
-- 6148 bytes still fits a single 8KB page.
--
-- This only governs rows written AFTER it, which is why it sits next to the ADD
-- COLUMN: on a fresh deploy the backfill then writes inline from the start. On a
-- database that already has embeddings, rewrite them once:
--   update questions set embedding = embedding where embedding is not null;
--   vacuum questions;
alter table questions
  alter column embedding set storage plain;

comment on column questions.embedding is
  'openai/text-embedding-3-small (via OpenRouter) over `body` — see embedInput() in scripts/backfill-embeddings.mjs; query-time embedding MUST use the same shape or the query vector lands in a different space. NULL = needs (re)embedding; the backfill script picks up NULLs. Nulled automatically when body changes.';

-- ── staleness ────────────────────────────────────────────
-- A body edit invalidates the embedding. One trigger on the table beats a
-- re-embed call in admin_upsert_questions + admin_update_question_options +
-- every future writer, and it cannot be forgotten. The backfill script only
-- selects NULLs and is idempotent, so re-running it after an edit session is
-- the entire repair path.
--
-- `before update of body` does not fire for submit_answer's elo/times_seen
-- UPDATE, so the match hot path pays nothing for this.
create or replace function questions_null_stale_embedding()
returns trigger
language plpgsql
set search_path = pg_catalog, public as $$
begin
  -- `update of body` fires when body is *mentioned*, not only when it changes.
  if new.body is distinct from old.body then
    new.embedding := null;
  end if;
  return new;
end; $$;

drop trigger if exists questions_null_stale_embedding_trg on questions;
create trigger questions_null_stale_embedding_trg
  before update of body on questions
  for each row execute function questions_null_stale_embedding();

-- ── search primitive ─────────────────────────────────────
-- ponytail: exact scan, no HNSW index. Measured at ~12ms for 1247 active rows
-- (with the PLAIN storage above; it was 75ms before), and exact search has no
-- recall loss, whereas HNSW is approximate. Not worth an index at this size.
-- When the bank outgrows it, add:
--   create index questions_embedding_idx on questions
--     using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;
-- HNSW helps for a second reason beyond the distance math: it reads its own
-- graph instead of every row's vector, so it sidesteps the per-row fetch that
-- dominates this scan.
--
-- Cosine (<=>) not L2: OpenAI embeddings are normalized, so cosine is the
-- documented pairing and is scale-free.
create or replace function search_questions(
  p_embedding extensions.vector(1536),
  p_section   cat_section default null,
  p_limit     int default 5,
  p_exclude   uuid default null
)
returns table (id uuid, similarity real)
language sql
stable
security definer
set search_path = pg_catalog, public, extensions as $$
  select q.id, (1 - (q.embedding <=> p_embedding))::real
  from questions q
  where q.embedding is not null
    and q.is_active
    and (p_section is null or q.section = p_section)
    and (p_exclude is null or q.id <> p_exclude)
  order by q.embedding <=> p_embedding
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

-- No consumer calls this yet, so `authenticated` is deliberately NOT granted —
-- an unused grant is pure attack surface. Add it when a feature needs it, and
-- read the SECURITY note at the top first: even ids-only, the similarity score
-- is a "how close is my guess" oracle, so a user-facing consumer should pass a
-- server-derived embedding rather than caller-supplied text.
--
-- `authenticated` must be revoked EXPLICITLY, not just public/anon: Supabase
-- ships `alter default privileges ... grant execute on functions to postgres,
-- anon, authenticated, service_role`, so every new function is born callable by
-- logged-in users and revoking public alone leaves that grant standing. Verified
-- the hard way — the first cut of this migration did exactly that. This matches
-- the server-only pattern used by try_match_internal, broadcast_spectator_update,
-- and apply_rated_result.
revoke execute on function search_questions(extensions.vector, cat_section, int, uuid) from public, anon, authenticated;
grant  execute on function search_questions(extensions.vector, cat_section, int, uuid) to service_role;
