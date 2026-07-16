-- ─────────────────────────────────────────────────────────
-- Question selection prefers questions the players have not already seen.
--
-- WHY. No picker anywhere excluded already-answered questions — verified across
-- all of pick_quant_question_ids / pick_section_question_ids / start_practice /
-- accept_challenge / try_match_internal / match_with_bot. So a player could be
-- re-served a question they had already answered, and simply remember it.
--
-- That is a scoring exploit, not just repetition. And it is strictly worse for
-- TITA than for MCQ: MCQ options are shuffled per player per match by
-- option_perm, so remembering an MCQ gives you the answer TEXT but not its
-- position — you still have to read the options. A TITA has no such shuffle.
-- Remembering a TITA gives you the exact string to type, for the full
-- base+bonus. submit_answer's <2s `suspect` guard does not help: it only
-- suppresses the question-ELO nudge and logs telemetry, it still awards points.
--
-- It is also asymmetric — matchmaking pairs on rating, never on history — so
-- when one player has seen the question and the other has not, the first wins
-- that question outright. With 52 TITA at 1-in-3 (20260716212848) a repeat
-- lands around match ~9, vs ~21 for QUANT MCQ out of 1090.
--
-- HOW. Rank, do not filter. `unseen first, then ELO proximity + jitter` can
-- never return a short array, which a hard `not in (...)` filter would once a
-- player exhausted the pool — and question_ids must hold 9 or the match
-- silently truncates. When everything is seen, every row ties at 1 and the
-- order collapses to exactly today's ELO behaviour.
--
-- The trade is deliberate: freshness outranks difficulty fit. A player deep into
-- the bank may get an unseen question further from their rating than a seen one.
-- That is the right call while the bank is small (52 TITA) — a perfectly-pitched
-- question you already know the answer to teaches nothing and scores wrong.
--
-- p_users defaults to '{}' so an un-passed caller keeps the old behaviour
-- exactly: `user_id = any('{}')` is false for every row, seen is empty, all rows
-- tie at 0, pure ELO ordering.
--
-- ponytail: "seen" is forever and unweighted — no recency decay, no
-- least-recently-seen tiebreak. A question met once six months ago outranks
-- nothing. Add decay if players start exhausting sections; the ceiling here is
-- 52 TITA, so this buys ~52 matches of freshness, not infinity. The real fix for
-- that ceiling is more questions.
--
-- Bodies recreated from their LATEST live definitions per CLAUDE.md migration
-- discipline; only the p_users plumbing changes. search_path pinned inline;
-- grants mirror the originals.
-- ─────────────────────────────────────────────────────────

-- Covering index: the seen-set probe is (user_id -> question_id) and nothing
-- else, so this makes it index-only. match_answers_user_id_idx alone would fetch
-- the heap for every row.
create index if not exists match_answers_user_question_idx
  on match_answers (user_id, question_id);

-- ── QUANT: TITA quota (20260716212848) + unseen preference ──
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
  n_tita int := greatest(1, round(p_total / 3.0)::int);
  v_seen uuid[];
  v_tita uuid[];
  v_mcq  uuid[];
  v_ids  uuid[];
begin
  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = any(p_users);

  select array_agg(t.id) into v_tita from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'tita'
    order by (q.id = any(v_seen))::int,
             abs(q.elo - p_target_elo) + random() * 300
    limit n_tita
  ) t;
  v_tita := coalesce(v_tita, '{}');

  -- Fill the remainder with MCQ, and absorb any TITA shortfall here too: if the
  -- TITA pool is drained or fully deactivated this degrades to all-MCQ rather
  -- than handing back a short match.
  select array_agg(t.id) into v_mcq from (
    select q.id from questions q
    where q.section = 'QUANT' and q.is_active and q.qtype = 'mcq'
    order by (q.id = any(v_seen))::int,
             abs(q.elo - p_target_elo) + random() * 300
    limit p_total - coalesce(array_length(v_tita, 1), 0)
  ) t;
  v_mcq := coalesce(v_mcq, '{}');

  -- Shuffle: without this the TITA is always the first QUANT question, i.e. a
  -- fixed index in every match, which is both predictable and a tell.
  select array_agg(x order by random()) into v_ids
  from unnest(v_tita || v_mcq) x;

  return coalesce(v_ids, '{}');
end $$;

revoke all on function pick_quant_question_ids(integer, integer, uuid[]) from public, anon, authenticated;
grant execute on function pick_quant_question_ids(integer, integer, uuid[]) to service_role;

-- ── pick_section_question_ids: QUANT delegates; VARC/DILR gain the same preference ──
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
  v_ids  uuid[];
  v_pid  uuid;
  v_seen uuid[];
begin
  if p_section = 'QUANT' then
    return pick_quant_question_ids(p_target_elo, 3, p_users);
  end if;

  select coalesce(array_agg(distinct a.question_id), '{}')
    into v_seen
  from match_answers a
  where a.user_id = any(p_users);

  -- Passage groups rank by how much of the group is already seen, so a wholly
  -- fresh passage beats a half-seen one before ELO fit is considered. The group
  -- is still served whole and in order — sub-questions are never split.
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

-- ── Callers: pass who is actually playing ──

create or replace function try_match_internal(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  my_band      integer;
  new_match_id uuid;
  q_ids        uuid[];
  target       integer;
  players      uuid[];
begin
  select * into me
  from matchmaking_queue
  where user_id = p_user_id and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  my_band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and heartbeat_at > now() - interval '90 seconds'
    and abs(elo - me.elo) <= greatest(
          my_band,
          least(1000, 100 + extract(epoch from (now() - enqueued_at))::int * 20)
        )
    and rated_pair_count_today(me.user_id, user_id) < 3
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  target  := ((me.elo + opp.elo) / 2)::int;
  -- Both players: a question either has seen is a repeat for that one and an
  -- asymmetric advantage over the other, which is the whole point of the rule.
  players := array[me.user_id, opp.user_id];

  q_ids := coalesce(pick_section_question_ids('VARC',  target, players), '{}')
        || coalesce(pick_section_question_ids('DILR',  target, players), '{}')
        || coalesce(pick_section_question_ids('QUANT', target, players), '{}');

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids, me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

revoke all on function try_match_internal(uuid) from public, anon, authenticated;
grant execute on function try_match_internal(uuid) to service_role;

create or replace function match_with_bot()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  uid      uuid := (select auth.uid());
  bot_id   uuid := '00000000-0000-0000-0000-00000000b071';
  me       matchmaking_queue%rowtype;
  my_elo   int;
  q_ids    uuid[];
  new_match_id uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('match_with_bot', 5, 60);

  select * into me from matchmaking_queue
  where user_id = uid and status = 'waiting'
  order by enqueued_at desc limit 1
  for update;
  if not found then raise exception 'not in queue'; end if;
  if me.enqueued_at > now() - interval '15 seconds' then
    raise exception 'bot not available yet';
  end if;

  select elo into my_elo from profiles where id = uid;

  -- The HUMAN only, deliberately. The bot answers every match it is in, so
  -- folding its history into the seen set would mark most of the bank as seen
  -- for everyone and collapse the preference to noise.
  q_ids := coalesce(pick_section_question_ids('VARC',  my_elo, array[uid]), '{}')
        || coalesce(pick_section_question_ids('DILR',  my_elo, array[uid]), '{}')
        || coalesce(pick_section_question_ids('QUANT', my_elo, array[uid]), '{}');
  if coalesce(array_length(q_ids, 1), 0) = 0 then
    raise exception 'no questions available';
  end if;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, started_at, question_started_at)
  values (uid, bot_id, 'active', false, q_ids,
          my_elo, my_elo,
          now(), now() + interval '3 seconds')
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id = me.id;

  return new_match_id;
end; $$;

revoke all on function match_with_bot() from public, anon;
grant execute on function match_with_bot() to authenticated, service_role;

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
  players   uuid[];
  v_seen    uuid[];
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
  target  := ((host_elo + me_elo) / 2)::int;
  players := array[ch.host_id, auth.uid()];

  if ch.section_mode is null then
    q_ids := coalesce(pick_section_question_ids('VARC',  target, players), '{}')
          || coalesce(pick_section_question_ids('DILR',  target, players), '{}')
          || coalesce(pick_section_question_ids('QUANT', target, players), '{}');
  elsif ch.section_mode = 'QUANT' then
    -- Same 1-in-3 quota as a mixed match: 3 TITA of 9.
    q_ids := coalesce(pick_quant_question_ids(target, 9, players), '{}');
  else
    select coalesce(array_agg(distinct a.question_id), '{}')
      into v_seen
    from match_answers a
    where a.user_id = any(players);

    select array_agg(t.id) into q_ids from (
      select q.id from questions q
      where q.section = ch.section_mode and q.is_active
      order by (q.id = any(v_seen))::int,
               abs(q.elo - target) + random() * 300
      limit 9
    ) t;
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
