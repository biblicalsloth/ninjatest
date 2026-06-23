-- =========================================================
-- 1. get_leaderboard: add display_name to return set
-- 2. get_recent_matches: return coalesce(display_name, username) as opponent
-- 3. advance_timed_out: also abandon 'pending' matches stuck >5 minutes
--    (both players disconnected before match started)
-- =========================================================

drop function if exists get_leaderboard(int, int);
create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (
  rank         bigint,
  username     text,
  display_name text,
  elo          int,
  wins         int,
  losses       int,
  avatar_url   text
)
language sql stable security definer as $$
  select
    rank() over (order by elo desc)::bigint,
    username,
    display_name,
    elo, wins, losses, avatar_url
  from profiles
  order by elo desc
  limit p_limit offset p_offset;
$$;

create or replace function get_recent_matches(p_limit int default 5)
returns table (
  match_id        uuid,
  opponent        text,
  opponent_avatar text,
  my_score        int,
  opp_score       int,
  result          text,
  elo_delta       int,
  played_at       timestamptz
)
language plpgsql stable security definer as $$
declare uid uuid := auth.uid();
begin
  return query
  select
    m.id,
    -- Use display_name when set, fall back to username
    case
      when m.player_a = uid then coalesce(pb.display_name, pb.username)
      else coalesce(pa.display_name, pa.username)
    end,
    case when m.player_a = uid then pb.avatar_url else pa.avatar_url end,
    case when m.player_a = uid then m.score_a else m.score_b end,
    case when m.player_a = uid then m.score_b else m.score_a end,
    case
      when m.winner_id = uid then 'win'
      when m.winner_id is null then 'draw'
      else 'loss'
    end,
    case
      when m.player_a = uid then coalesce(m.elo_a_after - m.elo_a_before, 0)
      else coalesce(m.elo_b_after - m.elo_b_before, 0)
    end,
    m.ended_at
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where uid in (m.player_a, m.player_b)
    and m.status in ('completed', 'abandoned')
  order by m.ended_at desc
  limit p_limit;
end;
$$;

-- Extend advance_timed_out to also clean up stale 'pending' matches.
-- A match is 'pending' when created but neither player has loaded the page
-- (question_started_at is null). If stuck >5 minutes, abandon it and free
-- the queue slots (queue rows are already 'matched' so no queue cleanup needed).
create or replace function advance_timed_out()
returns void language plpgsql security definer as $$
declare
  r     record;
  cap   integer;
  pid   uuid;
begin
  -- Abandon stale pending matches (nobody loaded the match page in 5 min)
  update matches
  set status = 'abandoned', ended_at = now()
  where status = 'pending'
    and created_at < now() - interval '5 minutes';

  -- Advance or finalize active matches where current question has timed out
  for r in
    select m.*, q.section, q.id as q_id, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      foreach pid in array array[r.player_a, r.player_b] loop
        insert into match_answers (
          match_id, user_id, question_id, question_index,
          selected_index, is_correct, points_awarded, time_taken_ms
        )
        values (
          r.id, pid, r.q_id, r.current_index,
          null, false, 0, cap
        )
        on conflict (match_id, user_id, question_index) do nothing;
      end loop;

      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;