-- ─────────────────────────────────────────────────────────────────────────────
-- Pickers: (1) never serve two near-identical questions in one pick,
--          (2) QUANT passage groups (sets), (3) QUANT reading window.
--
-- (1) pick_spread(): the one place the near-dup threshold lives. Measured on
--     prod 2026-11-17, ~110 active rows had a same-section neighbour at >=0.98
--     cosine — mostly QUANT set siblings that each carry the full setup text
--     (32 pairs that can't become passage groups: the group branch needs >=3)
--     plus true re-worded duplicates ("Fresh grapes contain 90% water…" ×2).
--     Candidates are still ranked exactly as before (unseen first, then ELO fit
--     + jitter); pick_spread only walks that ranking and skips a candidate
--     within the threshold of one already chosen. If the pool runs dry it
--     back-fills from the skipped ones — a near-dup is better than a short
--     match, which the exactly-9 guards (20260718000000) would refuse outright.
--     NULL embedding = no constraint, so a fresh or mid-backfill bank degrades
--     to the old behaviour rather than failing.
--     Standalone picks only: group-branch questions share a passage by design.
--
-- (2) QUANT had no passages; scripts/group-dilr-caselets.mjs --section QUANT
--     regroups the atomized sets ("Answer the questions based on the following
--     information…"). Grouped stems are setup-less, so they MUST NOT be served
--     standalone: pick_quant_question_ids now filters passage_id is null, and
--     pick_section_question_ids gives QUANT the same weighted group coin VARC/DILR
--     have. Practice and section-mode QUANT-9 call pick_quant_question_ids
--     directly and simply never see sets. THIS MIGRATION MUST BE LIVE BEFORE THE
--     REGROUP IS APPLIED, or the old picker serves orphaned stems.
--
-- (3) reading_ms only applies to the first question of a passage group in a
--     match (question_cap_ms), and QUANT had none, so this changes nothing until
--     sets exist. 60s, same as VARC/DILR.
--
-- Recreated from: pick_quant_question_ids 20260717170000,
-- pick_section_question_ids 20260718030000. Signatures unchanged, so create or
-- replace does not fork an overload.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function pick_spread(
  p_cands uuid[],          -- candidate ids, best first
  p_n     integer,
  p_avoid uuid[] default '{}'  -- already chosen elsewhere in this pick
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  -- cosine distance < 0.05  <=>  similarity > 0.95. Re-measure with
  -- `node scripts/find-near-duplicates.mjs --min 0.9` before moving it.
  max_dist constant float8 := 0.05;
  v_out  uuid[] := '{}';
  v_skip uuid[] := '{}';
  c      uuid;
begin
  foreach c in array coalesce(p_cands, '{}') loop
    exit when cardinality(v_out) >= p_n;
    if exists (
      select 1
      from questions a
      join questions b on b.id = any(v_out || p_avoid)
      where a.id = c
        and a.embedding is not null and b.embedding is not null
        and (a.embedding <=> b.embedding) < max_dist
    ) then
      v_skip := v_skip || c;
    else
      v_out := v_out || c;
    end if;
  end loop;

  if cardinality(v_out) < p_n then
    v_out := v_out || v_skip[1:p_n - cardinality(v_out)];
  end if;
  return v_out;
end $$;

revoke all on function pick_spread(uuid[], integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_spread(uuid[], integer, uuid[]) to service_role;

-- ── pick_quant_question_ids ──
create or replace function pick_quant_question_ids(
  p_target_elo integer,
  p_total integer,
  p_users uuid[] default '{}'
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n_tita int := case when p_total >= 3 then greatest(1, round(p_total / 3.0)::int) else 0 end;
  v_seen uuid[];
  v_tita uuid[];
  v_mcq  uuid[];
  v_ids  uuid[];
begin
  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = any(p_users);

  -- Candidate pools are over-fetched (n×3+10) so pick_spread has room to skip
  -- near-dups without leaving the ELO neighbourhood.
  select array_agg(t.id order by t.ord) into v_tita from (
    select q.id, row_number() over (order by (q.id = any(v_seen))::int,
                                    abs(q.elo - p_target_elo) + random() * 300) ord
    from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'tita' and q.passage_id is null
    order by ord
    limit n_tita * 3 + 10
  ) t;
  v_tita := pick_spread(v_tita, n_tita);

  select array_agg(t.id order by t.ord) into v_mcq from (
    select q.id, row_number() over (order by (q.id = any(v_seen))::int,
                                    abs(q.elo - p_target_elo) + random() * 300) ord
    from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'mcq' and q.passage_id is null
    order by ord
    limit (p_total - cardinality(v_tita)) * 3 + 10
  ) t;
  v_mcq := pick_spread(v_mcq, p_total - cardinality(v_tita), v_tita);

  select array_agg(x order by random()) into v_ids
  from unnest(v_tita || v_mcq) x;

  return coalesce(v_ids, '{}');
end $$;

revoke all on function pick_quant_question_ids(integer, integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_quant_question_ids(integer, integer, uuid[]) to service_role;

-- ── pick_section_question_ids ──
create or replace function pick_section_question_ids(
  p_section cat_section,
  p_target_elo integer,
  p_users uuid[] default '{}'
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids     uuid[];
  v_pid     uuid;
  v_seen    uuid[];
  v_groups  integer;
  v_solo    integer;
  v_use_group boolean;
  v_tita    uuid[];
  v_mcq     uuid[];
begin
  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = any(p_users);

  -- availability of each slot type
  select count(*) into v_groups from (
    select p.id
    from passages p
    join questions q on q.passage_id = p.id and q.is_active
    where p.section = p_section and p.is_active
    group by p.id
    having count(*) >= 3
  ) g;

  select count(*) into v_solo
  from questions
  where section = p_section and is_active and passage_id is null;

  -- weighted coin: group units = v_groups, standalone units = floor(v_solo/3)
  if v_groups = 0 then
    v_use_group := false;
  elsif v_solo < 3 then
    v_use_group := true;
  else
    v_use_group := random() < v_groups::float8 / (v_groups + (v_solo / 3));
  end if;

  if v_use_group then
    -- Passage groups rank by how much of the group is already seen (fresh first),
    -- then ELO fit. Served whole and in order — sub-questions never split.
    select p.id into v_pid
    from passages p
    join questions q on q.passage_id = p.id and q.is_active
    where p.section = p_section and p.is_active
    group by p.id
    having count(*) >= 3
    order by count(*) filter (where q.id = any(v_seen)),
             abs(avg(q.elo) - p_target_elo) + random() * 300
    limit 1;

    if v_pid is not null then
      select array_agg(id order by created_at) into v_ids from (
        select id, created_at from questions
        where passage_id = v_pid and is_active
        order by created_at limit 3
      ) s;
      return v_ids;
    end if;
    -- chosen group vanished (race) — fall through to standalone
  end if;

  -- QUANT standalone: one place decides the QUANT type mix. Now below the group
  -- coin (was an early return) so QUANT sets get served.
  if p_section = 'QUANT' then
    return pick_quant_question_ids(p_target_elo, 3, p_users);
  end if;

  -- Standalone fill. DILR reserves 1 of 3 for TITA (mirrors pick_quant_question_ids)
  -- so its high-seeded TITA bank isn't starved by ELO-only selection.
  if p_section = 'DILR' then
    select array_agg(t.id order by t.ord) into v_tita from (
      select q.id, row_number() over (order by (q.id = any(v_seen))::int,
                                      abs(q.elo - p_target_elo) + random() * 300) ord
      from questions q
      where q.section = 'DILR' and q.is_active and q.passage_id is null and q.qtype = 'tita'
      order by ord
      limit 13
    ) t;
    v_tita := pick_spread(v_tita, 1);

    select array_agg(t.id order by t.ord) into v_mcq from (
      select q.id, row_number() over (order by (q.id = any(v_seen))::int,
                                      abs(q.elo - p_target_elo) + random() * 300) ord
      from questions q
      where q.section = 'DILR' and q.is_active and q.passage_id is null and q.qtype = 'mcq'
      order by ord
      limit 19
    ) t;
    v_mcq := pick_spread(v_mcq, 3 - cardinality(v_tita), v_tita);

    select array_agg(x order by random()) into v_ids from unnest(v_tita || v_mcq) x;
    return coalesce(v_ids, '{}');
  end if;

  -- VARC and any other non-QUANT section: standalone by ELO.
  select array_agg(t.id order by t.ord) into v_ids from (
    select q.id, row_number() over (order by (q.id = any(v_seen))::int,
                                    abs(q.elo - p_target_elo) + random() * 300) ord
    from questions q
    where q.section = p_section and q.is_active and q.passage_id is null
    order by ord
    limit 19
  ) t;
  return pick_spread(v_ids, 3);
end;
$$;

revoke all on function pick_section_question_ids(cat_section, integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_section_question_ids(cat_section, integer, uuid[]) to service_role;

-- ── QUANT reading window (only affects passage groups) ──
update section_config set reading_ms = 60000 where section = 'QUANT';
