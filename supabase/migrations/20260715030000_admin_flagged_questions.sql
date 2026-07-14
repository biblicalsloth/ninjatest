-- ─────────────────────────────────────────────────────────
-- Question quality auditor: heuristic flags for likely-broken bank questions.
--
-- Signals (cheap, from play data — no LLM):
--   · elo at clamp        — question ELO ran to the [400,2800] clamp: either
--                           absurdly mis-keyed (everyone "wrong") or trivial.
--   · elo far from seed   — drifted ≥600 from its difficulty seed with enough
--                           evidence (times_seen ≥ 8): difficulty label is wrong.
--   · ~never correct      — ≥10 real attempts, ≤5% correct: suspect wrong key.
--   · ~always correct     — ≥10 real attempts, ≥98% correct: trivial or leaked.
--
-- Skips (selected_index is null) — skips say nothing about the key.
-- The AI audit layer (/api/ninja/audit) runs on top of this list in the admin UI.
-- ─────────────────────────────────────────────────────────

create or replace function admin_flagged_questions()
returns table (
  id           uuid,
  section      cat_section,
  body         text,
  difficulty   smallint,
  elo          integer,
  times_seen   integer,
  attempts     bigint,
  correct_rate numeric,
  reasons      text[]
)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select p.is_admin from profiles p where p.id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  return query
  with stats as (
    select ma.question_id,
           count(*)::bigint as attempts,
           avg(case when ma.is_correct then 1.0 else 0.0 end) as correct_rate
    from match_answers ma
    where ma.selected_index is not null
    group by ma.question_id
  ),
  flagged as (
    select q.id, q.section, q.body, q.difficulty, q.elo, q.times_seen,
           coalesce(s.attempts, 0) as attempts,
           s.correct_rate,
           array_remove(array[
             case when q.elo <= 450 or q.elo >= 2750
                  then 'ELO at clamp (' || q.elo || ')' end,
             case when q.times_seen >= 8
                   and abs(q.elo - (1000 + q.difficulty * 100)) >= 600
                  then 'ELO far from difficulty seed' end,
             case when coalesce(s.attempts, 0) >= 10 and s.correct_rate <= 0.05
                  then 'almost never answered correctly — suspect key' end,
             case when coalesce(s.attempts, 0) >= 10 and s.correct_rate >= 0.98
                  then 'almost always correct — trivial or leaked' end
           ], null) as reasons
    from questions q
    left join stats s on s.question_id = q.id
    where q.is_active
  )
  select f.id, f.section, f.body, f.difficulty, f.elo, f.times_seen,
         f.attempts, round(f.correct_rate, 3), f.reasons
  from flagged f
  where cardinality(f.reasons) > 0
  order by cardinality(f.reasons) desc, f.attempts desc
  limit 100;
end; $$;

revoke execute on function admin_flagged_questions() from public, anon;
grant  execute on function admin_flagged_questions() to authenticated, service_role;
