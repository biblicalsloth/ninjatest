-- Public match history for any profile page (no auth required)
create or replace function get_profile_matches(p_username text, p_limit int default 10)
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
language sql stable security definer as $$
  select
    m.id                                                                  as match_id,
    coalesce(pb.display_name, pb.username)                               as opponent,
    pb.avatar_url                                                         as opponent_avatar,
    case when m.player_a = p.id then m.score_a else m.score_b end        as my_score,
    case when m.player_a = p.id then m.score_b else m.score_a end        as opp_score,
    case
      when m.winner_id = p.id                              then 'win'
      when m.winner_id is null and m.status = 'completed' then 'draw'
      else 'loss'
    end                                                                   as result,
    case
      when m.player_a = p.id
        then coalesce(m.elo_a_after, m.elo_a_before) - m.elo_a_before
      else
        coalesce(m.elo_b_after, m.elo_b_before) - m.elo_b_before
    end                                                                   as elo_delta,
    m.ended_at                                                            as played_at
  from profiles p
  join matches m  on m.player_a = p.id or m.player_b = p.id
  join profiles pb on pb.id = case when m.player_a = p.id then m.player_b else m.player_a end
  where p.username = p_username
    and m.status in ('completed', 'abandoned')
    and m.ended_at is not null
  order by m.ended_at desc
  limit p_limit
$$;
