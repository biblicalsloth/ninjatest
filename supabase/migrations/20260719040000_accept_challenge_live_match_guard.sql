-- accept_challenge: refuse when either player is already in a live match.
--
-- join_queue (20260714140000) and match_with_bot (20260719030000) both reject
-- a caller with a match in ('active','pending'); accept_challenge never did.
-- Two holes:
--   · the guest accepts a code while mid-match → two live matches for one
--     player, which inLiveMatch, the forfeit path and the queue guard all
--     assume cannot happen.
--   · the host queued (or started a bot match) after creating the code and is
--     now playing → the challenge match is created with a host who can't show
--     up; the guest sits in a pending match until the 2-minute cron abandon.
--
-- Starts from the latest def (20260718050000_challenge_needs_nine_questions),
-- discipline #1. Signature unchanged (text) so no overload fork (#6).
-- search_path pinned inline, grants re-applied (#2).

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
  n_varc    int;
  n_dilr    int;
begin
  select * into ch from challenges where code = p_code for update;

  if not found then raise exception 'challenge not found'; end if;
  if ch.guest_id is not null then raise exception 'challenge already accepted'; end if;
  if now() > ch.expires_at then raise exception 'challenge expired'; end if;
  if ch.host_id = auth.uid() then raise exception 'cannot accept own challenge'; end if;

  -- Mirror join_queue's live-match guard, for both players: the sweep in
  -- advance_timed_out flips stale pending matches to 'abandoned', so any
  -- ('active','pending') row here is genuinely live.
  if exists (
    select 1 from matches
    where (player_a = auth.uid() or player_b = auth.uid())
      and status in ('active', 'pending')
  ) then
    raise exception 'already in a live match';
  end if;
  if exists (
    select 1 from matches
    where (player_a = ch.host_id or player_b = ch.host_id)
      and status in ('active', 'pending')
  ) then
    raise exception 'challenger is in another match';
  end if;

  if ch.is_rated and rated_pair_count_today(ch.host_id, auth.uid()) >= 3 then
    raise exception 'rated match limit reached between these players today';
  end if;

  select elo into host_elo from profiles where id = ch.host_id;
  select elo into me_elo   from profiles where id = auth.uid();
  target  := ((host_elo + me_elo) / 2)::int;
  players := array[ch.host_id, auth.uid()];

  if ch.section_mode is null then
    -- Mixed: a section with < 3 active questions contributes 0 slots that roll
    -- into QUANT (mirrors try_match_internal / match_with_bot).
    n_varc := case when (select count(*) from questions where section = 'VARC' and is_active) >= 3 then 3 else 0 end;
    n_dilr := case when (select count(*) from questions where section = 'DILR' and is_active) >= 3 then 3 else 0 end;

    q_ids := case when n_varc = 3 then coalesce(pick_section_question_ids('VARC', target, players), '{}') else '{}' end
          || case when n_dilr = 3 then coalesce(pick_section_question_ids('DILR', target, players), '{}') else '{}' end
          || coalesce(pick_quant_question_ids(target, 9 - n_varc - n_dilr, players), '{}');
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

  -- Never create a truncated match — a < 9 question_ids array corrupts mid-play.
  if coalesce(array_length(q_ids, 1), 0) <> 9 then
    raise exception 'not enough active questions for this challenge';
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
