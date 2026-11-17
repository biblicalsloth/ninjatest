-- ─────────────────────────────────────────────────────────────────────────────
-- Embedding consumers, round 2.
--   1. start_practice_similar: skip already-seen questions, serve passage hits
--      as whole groups, never drill the miss's own passage.
--   2. get_mistake_patterns (new): topic clusters over the caller's OWN recent
--      misses, for the Ninja coach. Answered questions only -> no bank leak.
--   3. question_near_duplicates (new): service_role-only report backing
--      scripts/find-near-duplicates.mjs. Report only; nothing deactivates.
-- All three read embeddings server-side; none accepts a caller vector and none
-- returns a similarity score to a client (see 20260716180000's security note).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. start_practice_similar ──
-- Recreated from 20260719000000 (its only definition). Guards unchanged:
-- participant-only, finished match only, shares start_practice's 5/day cap and
-- rate bucket, so total bank exposure stays 45 questions/day.
-- Changes:
--   * seen = every question the caller was served in a match or a drill. Before,
--     a drill could re-serve questions from the very match it was built from.
--   * a hit inside a passage pulls its whole active group (<=3, in order) —
--     before, a DILR/RC sub-question arrived without its siblings. A group that
--     doesn't fit in the remaining slots is skipped, never truncated.
--   * the miss's own passage is excluded: under embedding input v2
--     (20261118000000) the passage text is part of the vector, so siblings
--     would otherwise win every slot and the "similar" drill would just be the
--     rest of the caselet.
create or replace function start_practice_similar(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid         uuid := (select auth.uid());
  m           matches%rowtype;
  today_count int;
  misses      uuid[];
  v_seen      uuid[];
  src         record;
  hit         record;
  qid         uuid;
  ids         uuid[] := '{}';
  grp         uuid[];
  added       int;
  per         int;
  sid         uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('start_practice', 5, 60);

  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if m.status not in ('completed', 'abandoned') then raise exception 'match not finished'; end if;

  select count(*) into today_count
  from practice_sessions
  where user_id = uid and created_at >= date_trunc('day', now());
  if today_count >= 5 then
    raise exception 'daily practice limit reached';
  end if;

  -- Misses = the caller's wrong, skipped, and timed-out questions in this match.
  select coalesce(array_agg(a.question_id), '{}') into misses
  from match_answers a
  where a.match_id = p_match_id and a.user_id = uid and not a.is_correct;

  if coalesce(array_length(misses, 1), 0) = 0 then
    raise exception 'no mistakes to drill';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_seen from (
    select a.question_id x from match_answers a where a.user_id = uid
    union
    select unnest(s.question_ids) from practice_sessions s where s.user_id = uid
  ) t;

  per := greatest(1, (9 / array_length(misses, 1))::int);

  foreach qid in array misses loop
    exit when cardinality(ids) >= 9;
    select q.embedding, q.section, q.elo, q.passage_id into src from questions q where q.id = qid;
    added := 0;

    for hit in
      select c.id, c.passage_id from (
        -- Server-derived vector: the missed question's own stored embedding.
        -- No embedding (fresh local stack, mid-backfill) -> same-section,
        -- nearest-difficulty fallback, same exclusions.
        select q.id, q.passage_id, sq.similarity::float8 as rank_key
        from search_questions(src.embedding, src.section, 50, qid) sq
        join questions q on q.id = sq.id
        where src.embedding is not null
        union all
        select q.id, q.passage_id, -abs(q.elo - src.elo) - random()
        from questions q
        where src.embedding is null
          and q.section = src.section and q.is_active and q.id <> qid
      ) c
      where c.id <> all(ids) and c.id <> all(v_seen)
        -- NOT `c.passage_id is distinct from src.passage_id` alone: for a
        -- standalone miss that is null-vs-null = false and excludes every
        -- standalone hit (caught by elo-stress-test §18f).
        and (src.passage_id is null or c.passage_id is distinct from src.passage_id)
      order by c.rank_key desc
      limit 50
    loop
      exit when added >= per or cardinality(ids) >= 9;
      continue when hit.id = any(ids); -- pulled in earlier as a group sibling

      if hit.passage_id is null then
        grp := array[hit.id];
      else
        select coalesce(array_agg(g.id order by g.created_at), '{}') into grp from (
          select id, created_at from questions
          where passage_id = hit.passage_id and is_active and id <> all(ids)
          order by created_at limit 3
        ) g;
      end if;

      continue when cardinality(ids) + cardinality(grp) > 9;
      ids := ids || grp;
      added := added + cardinality(grp);
    end loop;
  end loop;

  if cardinality(ids) = 0 then
    raise exception 'no similar questions available';
  end if;

  insert into practice_sessions (user_id, question_ids)
  values (uid, ids)
  returning id into sid;

  return jsonb_build_object('session_id', sid, 'total', cardinality(ids));
end; $$;

revoke execute on function start_practice_similar(uuid) from public, anon;
grant  execute on function start_practice_similar(uuid) to authenticated, service_role;

-- ── 2. get_mistake_patterns ──
-- The caller's last 30 distinct missed match questions (wrong or skipped;
-- cron timeouts — time_taken_ms NULL — excluded, same rule as
-- get_learner_profile), greedily clustered by cosine similarity >= 0.85, a
-- topic-level bar well below the 0.95 near-dup bar in pick_spread.
-- Returns at most 3 clusters of >= 2 misses: {section, misses, example}.
-- FIXED SIZE BY CONSTRUCTION: runCoach replays every tool result on each of its
-- 6 steps (see trimCurve in lib/ai/model.ts), so never add a rows array here.
-- Leak-free by construction: every question in the output was already answered
-- by the caller, and no answer key or explanation is returned.
create or replace function get_mistake_patterns()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  uid   uuid := (select auth.uid());
  r     record;
  seeds extensions.vector[] := '{}';
  info  jsonb[] := '{}';
  hits  int[] := '{}';
  i     int;
  found_i int;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  for r in
    select q.section, q.embedding,
           left(regexp_replace(coalesce(p.body || ' … ', '') || q.body, '\s+', ' ', 'g'), 160) as example
    from (
      select distinct on (a.question_id) a.question_id, a.answered_at
      from match_answers a
      where a.user_id = uid and not a.is_correct and a.time_taken_ms is not null
      order by a.question_id, a.answered_at desc
    ) mm
    join questions q on q.id = mm.question_id
    left join passages p on p.id = q.passage_id
    where q.embedding is not null
    order by mm.answered_at desc
    limit 30
  loop
    found_i := null;
    for i in 1 .. cardinality(seeds) loop
      if (info[i]->>'section') = r.section::text and (seeds[i] <=> r.embedding) < 0.15 then
        found_i := i; exit;
      end if;
    end loop;
    if found_i is null then
      seeds := seeds || r.embedding;
      info  := info || jsonb_build_object('section', r.section, 'example', r.example);
      hits  := hits || 1;
    else
      hits[found_i] := hits[found_i] + 1;
    end if;
  end loop;

  return coalesce((
    select jsonb_agg(c.j order by c.n desc)
    from (
      select info[k] || jsonb_build_object('misses', hits[k]) as j, hits[k] as n
      from generate_subscripts(hits, 1) k
      where hits[k] >= 2
      order by hits[k] desc
      limit 3
    ) c
  ), '[]'::jsonb);
end; $$;

revoke execute on function get_mistake_patterns() from public, anon;
grant  execute on function get_mistake_patterns() to authenticated, service_role;

-- ── 3. question_near_duplicates ──
-- Every active pair in the same section, NOT the same passage (siblings share
-- the caselet text and are near-identical under v2 by design), with cosine
-- similarity >= p_min_sim. p_since limits to pairs touching a row created after
-- it (post-ingest runs). Exact lateral scan, ~10s on the full bank — a script
-- tool, never a request path, hence service_role only.
create or replace function question_near_duplicates(
  p_min_sim real default 0.95,
  p_since   timestamptz default null
)
returns table (a uuid, b uuid, section cat_section, similarity real)
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select q.id, n.id, q.section, n.sim::real
  from questions q
  cross join lateral (
    select q2.id, 1 - (q2.embedding <=> q.embedding) as sim
    from questions q2
    where q2.section = q.section and q2.is_active and q2.embedding is not null
      and q2.id > q.id
      and (q.passage_id is null or q2.passage_id is distinct from q.passage_id)
      and (p_since is null or q.created_at >= p_since or q2.created_at >= p_since)
    order by q2.embedding <=> q.embedding
    limit 5
  ) n
  where q.is_active and q.embedding is not null and n.sim >= p_min_sim
  order by n.sim desc;
$$;

revoke all on function question_near_duplicates(real, timestamptz) from public, anon, authenticated;
grant execute on function question_near_duplicates(real, timestamptz) to service_role;
