-- VARC/DILR picker: serve standalone questions as well as passage groups.
--
-- Before this, pick_section_question_ids preferred a passage group whenever ANY
-- qualifying group (>=3 active sub-questions) existed, and only fell back to
-- standalone (passage_id is null) when NO group qualified. Once the extracted
-- VARC bank loads ~120 RC passage groups, that fallback never fires, so the 345
-- standalone para-jumble/vocab questions would be dead on arrival — loaded but
-- never served.
--
-- Fix: pick the branch by a coin weighted on availability. Group units = number
-- of qualifying passages; standalone units = floor(active standalone / 3). The
-- group branch is taken with prob groups/(groups+solo_triples); otherwise the
-- standalone branch. Degenerate cases collapse cleanly: no standalone -> always
-- group (old behaviour), no group -> always standalone (old fallback). A section
-- with neither still returns NULL, which the callers coalesce to '{}' — and the
-- 20260718000000 try_match_internal guard already refuses to create a short match.
--
-- Prefer-unseen ordering (20260716220817) is preserved inside BOTH branches, and
-- passage groups are still served whole and in created_at order — sub-questions
-- are never split. Signature unchanged (cat_section, integer, uuid[]) so no
-- overload is forked (migration discipline #6). Starts from the latest def
-- (20260716220817_prefer_unseen_questions.sql), discipline #1.
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
