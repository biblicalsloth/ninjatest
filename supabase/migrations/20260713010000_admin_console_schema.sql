-- =========================================================
-- Admin question-upload console: schema
--   1. passages table (server-only, exactly like `questions`)
--   2. questions.passage_id  (sub-question -> shared passage)
--
-- NOTE: profiles.is_admin, its self-update guard, and the owner seed moved to
-- 20260713000500_unify_admin_is_admin.sql (applied first). Do not re-add them
-- here — the column already exists.
-- =========================================================

-- ── 1. passages ──────────────────────────────────────────
-- passage_id set on a question -> questions.body is the sub-question STEM and
-- passages.body is the shared passage/dataset. passage_id null -> standalone.
create table passages (
  id         uuid primary key default gen_random_uuid(),
  section    cat_section not null,
  body       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Server-only, exactly like `questions`: no direct client read; served via RPCs.
alter table passages enable row level security;
create policy passages_none on passages for select using (false);

-- ── 2. questions.passage_id ──────────────────────────────
alter table questions
  add column passage_id uuid references passages(id) on delete cascade;

create index questions_passage_id_idx on questions (passage_id) where passage_id is not null;
