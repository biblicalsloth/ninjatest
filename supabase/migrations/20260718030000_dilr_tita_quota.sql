-- DILR TITA quota: reserve 1 of 3 standalone slots for TITA.
--
-- DILR has 34 TITA seeded at 1300-1600 (TITA sits +100 above the MCQ scale) but
-- the DILR branch of pick_section_question_ids picked standalone questions by ELO
-- alone. Same starvation cliff pick_quant_question_ids (20260716212848) was built
-- to fix for QUANT: at a normal player rating the high-seeded TITA never win an
-- ELO-nearest slot, so they are effectively never served — and a question never
-- served never gets its ELO nudged, so the dead zone is self-sealing.
--
-- Fix: DILR's standalone fill now mirrors the QUANT quota — reserve n_tita = 1 of
-- 3 for TITA (prefer-unseen + ELO fit preserved), fill the rest with MCQ, shuffle.
-- coalesce guards the degenerate cases (no unseen TITA -> MCQ fills the slot).
-- VARC and any other non-QUANT section are unchanged: they have no TITA, so the
-- old ELO-only standalone pick still applies via the else branch.
--
-- While DILR has zero passages the standalone branch always fires, so this
-- guarantees TITA delivery today. Once caselets are grouped, TITA that live inside
-- a caselet are served whole with their group; standalone TITA stay covered here.
--
-- Starts from the latest def (20260718020000_varc_standalone_picker.sql), disc #1.
-- Signature unchanged (cat_section, integer, uuid[]) so no overload forks (disc #6).
-- Guarded by scripts/elo-stress-test.sql — re-run it after applying.

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
  if p_section = 'QUANT' then
    return pick_quant_question_ids(p_target_elo, 3, p_users);
  end if;

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

  -- Standalone fill. DILR reserves 1 of 3 for TITA (mirrors pick_quant_question_ids)
  -- so its high-seeded TITA bank isn't starved by ELO-only selection.
  if p_section = 'DILR' then
    select array_agg(t.id) into v_tita from (
      select q.id from questions q
      where q.section = 'DILR' and q.is_active and q.passage_id is null and q.qtype = 'tita'
      order by (q.id = any(v_seen))::int,
               abs(q.elo - p_target_elo) + random() * 300
      limit 1
    ) t;
    v_tita := coalesce(v_tita, '{}');

    select array_agg(t.id) into v_mcq from (
      select q.id from questions q
      where q.section = 'DILR' and q.is_active and q.passage_id is null and q.qtype = 'mcq'
      order by (q.id = any(v_seen))::int,
               abs(q.elo - p_target_elo) + random() * 300
      limit 3 - coalesce(array_length(v_tita, 1), 0)
    ) t;
    v_mcq := coalesce(v_mcq, '{}');

    select array_agg(x order by random()) into v_ids from unnest(v_tita || v_mcq) x;
    return coalesce(v_ids, '{}');
  end if;

  -- VARC and any other non-QUANT section: standalone by ELO (unchanged).
  select array_agg(id) into v_ids from (
    select q.id from questions q
    where q.section = p_section and q.is_active and q.passage_id is null
    order by (q.id = any(v_seen))::int,
             abs(q.elo - p_target_elo) + random() * 300
    limit 3
  ) s;
  return v_ids;
end;
$$;

revoke all on function pick_section_question_ids(cat_section, integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_section_question_ids(cat_section, integer, uuid[]) to service_role;
