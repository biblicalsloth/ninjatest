-- CRITICAL FIX: get_match_question has been broken since it was first
-- created in 002_rpc_functions.sql. `returns table (... section cat_section
-- ...)` makes `section` an implicit PL/pgSQL variable in scope; the query
-- `select * into cfg from section_config where section = q.section` is then
-- ambiguous between that variable and section_config.section, and Postgres
-- raises `42702: column reference "section" is ambiguous` on every call —
-- meaning the very first question of every match has always failed to load.
--
-- Never surfaced: zero real matches have been played on this project (the
-- app has been in waitlist-only mode this whole time). Confirmed live: the
-- identical unqualified pattern in submit_answer is NOT affected, since
-- submit_answer has no `section`-named variable in scope (its declare block
-- has no returns-table column shadowing it) — only get_match_question (and
-- the get_match_question_spectator added alongside this migration) hit it.
--
-- Fix: alias section_config so the reference is unambiguous.
create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table (
  question_id uuid,
  section     cat_section,
  body        text,
  options     jsonb,
  cap_ms      integer,
  started_at  timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m   matches%rowtype;
  q   questions%rowtype;
  cfg section_config%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  select * into q   from questions where id = m.question_ids[p_index + 1];
  select * into cfg from section_config sc where sc.section = q.section;

  return query select
    q.id,
    q.section,
    q.body,
    q.options,
    coalesce(q.duration_ms, cfg.cap_ms),
    m.question_started_at;
end;
$$;
