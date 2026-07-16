-- ─────────────────────────────────────────────────────────
-- QUANT reserves a TITA slot instead of letting ELO decide the question mix.
--
-- WHY. Selection was ELO-only, so which *type* a player met was an accident of
-- what the bank happened to contain near their rating. Measured on the live
-- bank (1090 active QUANT MCQ at 1100-1500, 52 TITA at 1300-1600), TITA per
-- 3-question QUANT block:
--     player 1000 -> 0.00   player 1400 -> 0.21   player 1600 -> 1.58
--     player 1200 -> 0.00   player 1500 -> 1.39   player 1800 -> 1.55
-- A cliff, not a gradient: invisible below ~1400, then ~50% of QUANT above
-- 1500 — because MCQ tops out at 1500 while TITA reaches 1600, so past that
-- point TITA is simply the nearest content left. Real CAT QUANT is ~36% TITA.
-- Neither end of that curve is a design; both are artifacts of bank
-- composition, and the 0% floor is self-sealing — a question that is never
-- served never gets its ELO corrected by submit_answer, so it can never
-- migrate out of the dead zone on its own.
--
-- WHAT. One TITA slot per 3 QUANT questions (~33%, near CAT's ~36%), at every
-- rating. ELO still chooses WHICH TITA and WHICH MCQ — the quota governs the
-- mix only, so adaptive difficulty is untouched within each type.
--
-- Known cost, accepted: 52 TITA serving ~1-in-3 QUANT means each TITA is drawn
-- ~7x as often as each MCQ, so repeats surface within ~10 matches until the
-- TITA bank grows. The fix for that is more TITA, not fewer served.
--
-- WHERE. The quota lives in ONE helper because there were two independent
-- QUANT pickers: pick_section_question_ids (mixed 3-3-3) and an inline
-- `limit 9` inside accept_challenge's section_mode branch, which never called
-- the former. Both now route through pick_quant_question_ids, so the mix cannot
-- drift between a mixed match and a QUANT section-mode challenge.
--
-- Bodies recreated from their LATEST live definitions per CLAUDE.md migration
-- discipline; only the QUANT branch changes. VARC/DILR passage logic and the
-- non-QUANT section_mode path are byte-for-byte unchanged. search_path pinned
-- inline; grants mirror the originals (pick_* helpers are service_role-only and
-- deliberately NOT granted to authenticated).
-- ─────────────────────────────────────────────────────────

-- ── The single source of truth for the QUANT type mix ──
create or replace function pick_quant_question_ids(p_target_elo integer, p_total integer)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n_tita int := greatest(1, round(p_total / 3.0)::int);
  v_tita uuid[];
  v_mcq  uuid[];
  v_ids  uuid[];
begin
  select array_agg(t.id) into v_tita from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'tita'
    order by abs(q.elo - p_target_elo) + random() * 300
    limit n_tita
  ) t;
  v_tita := coalesce(v_tita, '{}');

  -- Fill the remainder with MCQ, and absorb any TITA shortfall here too: if the
  -- TITA pool is drained or fully deactivated this degrades to the old all-MCQ
  -- behaviour rather than handing back a short match (question_ids must hold 9,
  -- and a short array silently truncates the match).
  select array_agg(t.id) into v_mcq from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'mcq'
    order by abs(q.elo - p_target_elo) + random() * 300
    limit p_total - coalesce(array_length(v_tita, 1), 0)
  ) t;
  v_mcq := coalesce(v_mcq, '{}');

  -- Shuffle: without this the TITA is always the first QUANT question, i.e. a
  -- fixed index in every match, which is both predictable and a tell.
  select array_agg(x order by random()) into v_ids
  from unnest(v_tita || v_mcq) x;

  return coalesce(v_ids, '{}');
end $$;

revoke all on function pick_quant_question_ids(integer, integer) from public, anon, authenticated;
grant execute on function pick_quant_question_ids(integer, integer) to service_role;

-- ── pick_section_question_ids: QUANT branch delegates; VARC/DILR untouched ──
create or replace function pick_section_question_ids(p_section cat_section, p_target_elo integer)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids  uuid[];
  v_pid  uuid;
begin
  if p_section = 'QUANT' then
    return pick_quant_question_ids(p_target_elo, 3);
  end if;

  select p.id into v_pid
  from passages p
  join questions q on q.passage_id = p.id and q.is_active
  where p.section = p_section and p.is_active
  group by p.id
  having count(*) >= 3
  order by abs(avg(q.elo) - p_target_elo) + random() * 300
  limit 1;

  if v_pid is not null then
    select array_agg(id order by created_at) into v_ids from (
      select id, created_at from questions
      where passage_id = v_pid and is_active
      order by created_at limit 3
    ) s;
    return v_ids;
  end if;

  select array_agg(id) into v_ids from (
    select id from questions
    where section = p_section and is_active and passage_id is null
    order by abs(elo - p_target_elo) + random() * 300 limit 3
  ) s;
  return v_ids;
end;
$$;

revoke all on function pick_section_question_ids(cat_section, integer) from public, anon, authenticated;
grant execute on function pick_section_question_ids(cat_section, integer) to service_role;

-- ── accept_challenge: a QUANT section-mode challenge gets the same quota ──
create or replace function accept_challenge(p_code text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ch        challenges%rowtype;
  q_ids     uuid[];
  new_id    uuid;
  host_elo  int;
  me_elo    int;
  target    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();
  target := ((host_elo + me_elo) / 2)::int;

  if ch.section_mode is null then
    q_ids := coalesce(pick_section_question_ids('VARC',  target), '{}')
          || coalesce(pick_section_question_ids('DILR',  target), '{}')
          || coalesce(pick_section_question_ids('QUANT', target), '{}');
  elsif ch.section_mode = 'QUANT' then
    -- Same 1-in-3 quota as a mixed match: 3 TITA of 9.
    q_ids := coalesce(pick_quant_question_ids(target, 9), '{}');
  else
    select array_agg(id) into q_ids from (
      select id from questions
      where section = ch.section_mode and is_active
      order by abs(elo - target) + random() * 300 limit 9
    ) s;
  end if;

  insert into matches(player_a, player_b, status, is_rated, question_ids,
                      elo_a_before, elo_b_before)
  values (ch.host_id, auth.uid(), 'pending', ch.is_rated, q_ids, host_elo, me_elo)
  returning id into new_id;

  update challenges set guest_id = auth.uid(), match_id = new_id where id = ch.id;
  return new_id;
end;
$$;

revoke all on function accept_challenge(text) from public, anon;
grant execute on function accept_challenge(text) to authenticated, service_role;
