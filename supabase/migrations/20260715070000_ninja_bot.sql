-- ─────────────────────────────────────────────────────────
-- Ninja Bot: server-driven practice opponent for queue cold-start.
--
-- Design:
--   · One real profiles row (fixed uuid, is_bot = true) so every FK, RLS
--     policy, and UI path works unchanged. Display name "Ninja Bot" — always
--     disclosed, and bot matches are ALWAYS unrated (ELO integrity).
--   · No scheduler exists for sub-minute actions (no Edge Functions; pg_cron
--     is 1-min), so the HUMAN's client drives the bot via bot_act(). The RPC
--     is safe to poll: everything (answer time, correctness, picked option)
--     is a deterministic hash of (match_id, question_index) — the caller
--     controls only WHEN it's evaluated, never the outcome, and the answer
--     time acts as a not-before gate.
--   · Bot skill = the human's own ELO: correct-probability is the standard
--     expectation of a player at your rating vs the question's ELO, so the
--     bot stays competitive at every level.
--   · If the human vanishes, nothing polls bot_act — the advance_timed_out
--     cron null-skips both sides and finalizes/abandons as usual.
--   · No question-ELO nudges, no fast_answer telemetry: unrated matches never
--     touch the bank's ratings (collusion-channel rule).
-- ─────────────────────────────────────────────────────────

-- ── bot identity ──
alter table profiles add column if not exists is_bot boolean not null default false;

do $$
begin
  if not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000b071') then
    insert into auth.users (id, aud, role, email)
    values ('00000000-0000-0000-0000-00000000b071', 'authenticated', 'authenticated', 'ninja-bot@ninjatest.internal');
  end if;
  -- direct auth.users insert may or may not fire handle_new_user; ensure profile
  insert into profiles (id, username, display_name)
  values ('00000000-0000-0000-0000-00000000b071', 'ninja_bot', 'Ninja Bot')
  on conflict (id) do nothing;
  update profiles
  set username = 'ninja_bot', display_name = 'Ninja Bot', is_bot = true, elo = 1200
  where id = '00000000-0000-0000-0000-00000000b071';
end $$;

-- ── uniform [0,1) from a hash seed — deterministic bot randomness ──
create or replace function bot_hash_unit(p_seed text, p_offset int)
returns float8
language sql immutable
set search_path = pg_catalog, public as $$
  select ((('x' || substr(md5(p_seed), p_offset, 8))::bit(32)::int & 2147483647)::float8)
         / 2147483647.0;
$$;
revoke execute on function bot_hash_unit(text, int) from public, anon, authenticated;

-- ── pair the caller with the bot (caller must be genuinely waiting) ──
create or replace function match_with_bot()
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
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

  -- Must hold a live waiting row ≥15s old: the bot is a fallback after real
  -- matchmaking has had a chance, not an instant farm button.
  select * into me from matchmaking_queue
  where user_id = uid and status = 'waiting'
  order by enqueued_at desc limit 1
  for update;
  if not found then raise exception 'not in queue'; end if;
  if me.enqueued_at > now() - interval '15 seconds' then
    raise exception 'bot not available yet';
  end if;

  select elo into my_elo from profiles where id = uid;

  q_ids := coalesce(pick_section_question_ids('VARC',  my_elo), '{}')
        || coalesce(pick_section_question_ids('DILR',  my_elo), '{}')
        || coalesce(pick_section_question_ids('QUANT', my_elo), '{}');
  if coalesce(array_length(q_ids, 1), 0) = 0 then
    raise exception 'no questions available';
  end if;

  -- Created directly active (no presence handshake — the bot is always
  -- "present"); 3s-ahead question_started_at gives the shared lead-in the
  -- client already renders.
  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before, started_at, question_started_at)
  values (uid, bot_id, 'active', false, q_ids,
          my_elo, (select elo from profiles where id = bot_id),
          now(), now() + interval '3 seconds')
  returning id into new_match_id;

  update matchmaking_queue
  set status = 'matched', match_id = new_match_id
  where id = me.id;

  return new_match_id;
end; $$;

-- ── advance the bot for the current question (poll-safe, deterministic) ──
create or replace function bot_act(p_match_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid      uuid := (select auth.uid());
  m        matches%rowtype;
  bot_id   uuid;
  q        questions%rowtype;
  sc       section_config%rowtype;
  idx      int;
  seed     text;
  cap      int;
  t_ans_ms int;
  deadline timestamptz;
  human_elo int;
  expectation float8;
  v_correct boolean;
  n_opts   int;
  sel      int;
  bonus    int;
  pts      int;
begin
  perform check_rate_limit('bot_act', 30, 10);

  select * into m from matches where id = p_match_id for update;
  if not found or uid not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status <> 'active' then
    return jsonb_build_object('acted', false, 'reason', 'not active');
  end if;

  -- Identify the bot side; reject non-bot matches.
  if (select p.is_bot from profiles p where p.id = m.player_b) then
    bot_id := m.player_b;
  elsif (select p.is_bot from profiles p where p.id = m.player_a) then
    bot_id := m.player_a;
  else
    raise exception 'not a bot match';
  end if;

  idx := m.current_index;
  if m.question_started_at is null then
    return jsonb_build_object('acted', false, 'reason', 'not started');
  end if;
  if exists (select 1 from match_answers a
             where a.match_id = p_match_id and a.user_id = bot_id and a.question_index = idx) then
    return jsonb_build_object('acted', false, 'answered', true);
  end if;

  select * into q from questions where id = m.question_ids[idx + 1];
  select * into sc from section_config where section = q.section;
  cap := coalesce(q.duration_ms, sc.cap_ms);
  n_opts := jsonb_array_length(q.options);

  -- Deterministic plan for this (match, question).
  seed := p_match_id::text || ':' || idx;
  t_ans_ms := (cap * (0.30 + 0.50 * bot_hash_unit(seed, 1)))::int;
  deadline := m.question_started_at + make_interval(secs => t_ans_ms / 1000.0);
  if now() < deadline then
    return jsonb_build_object('acted', false,
      'eta_ms', (extract(epoch from (deadline - now())) * 1000)::int);
  end if;

  -- Bot skill = the human's current rating vs the question's ELO.
  select p.elo into human_elo from profiles p
  where p.id = case when bot_id = m.player_a then m.player_b else m.player_a end;
  expectation := 1.0 / (1.0 + power(10.0, (q.elo - human_elo) / 400.0));
  v_correct := bot_hash_unit(seed, 9) < expectation;

  if v_correct then
    sel := q.correct_index;
  else
    -- floor, NOT ::int (which rounds): the offset must stay in [1, n-1] so a
    -- "wrong" pick can never wrap onto the correct option.
    sel := (q.correct_index + 1 + floor(bot_hash_unit(seed, 17) * (n_opts - 1))::int) % n_opts;
  end if;

  -- Same scoring curve as submit_answer (derived EV-neutral wrong penalty).
  bonus := round(sc.speed_mult * floor((cap - least(t_ans_ms, cap))::numeric / sc.grace_block_ms))::int;
  if v_correct then
    pts := sc.base_points + bonus;
  else
    pts := -round((sc.base_points + bonus)::numeric / (n_opts - 1))::int;
  end if;

  insert into match_answers (match_id, user_id, question_id, question_index,
                             selected_index, is_correct, points_awarded, time_taken_ms)
  values (p_match_id, bot_id, q.id, idx, sel, v_correct, pts, t_ans_ms)
  on conflict (match_id, user_id, question_index) do nothing;
  -- Lost the race against the cron's null-skip insert (it doesn't hold this
  -- match's row lock): the skip stands; adding points without a row would
  -- drift the score.
  if not found then
    return jsonb_build_object('acted', false, 'answered', true);
  end if;

  if bot_id = m.player_b then
    update matches set
      score_b   = score_b + pts,
      correct_b = correct_b + v_correct::int
    where id = p_match_id;
  else
    update matches set
      score_a   = score_a + pts,
      correct_a = correct_a + v_correct::int
    where id = p_match_id;
  end if;

  -- Both sides may now be in → advance/finalize exactly like a human submit.
  perform maybe_advance(p_match_id, idx::smallint);

  return jsonb_build_object('acted', true);
end; $$;

revoke execute on function match_with_bot() from public, anon;
revoke execute on function bot_act(uuid)    from public, anon;
grant  execute on function match_with_bot() to authenticated, service_role;
grant  execute on function bot_act(uuid)    to authenticated, service_role;
