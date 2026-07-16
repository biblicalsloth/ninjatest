-- =========================================================
-- The bot stays out of every list of real users. 20260716140000 did the two
-- ladders (get_leaderboard, the end_current_season snapshot); these are the
-- other two surfaces that enumerate profiles:
--
--   · search_profiles    — Ninja Bot was friend-searchable, and a request sent
--                          to it sits pending forever (it never responds).
--   · get_active_matches — every bot practice match showed up in the public
--                          /spectate browser as "someone vs Ninja Bot".
--
-- Not touched: get_spectator_match. It needs a match id, and with the bot gone
-- from get_active_matches there is no way to discover one — the player's own
-- bot match is already rejected there ('participants must use
-- get_match_question'). ponytail: filter the list, not every reader of it.
--
-- get_recent_matches is deliberately left alone: it is caller-scoped
-- (uid in (player_a, player_b)), so a bot match in YOUR history is correct —
-- you played it.
--
-- Recreated from their latest definitions:
--   search_profiles    <- 20260702000400_friend_lists
--   get_active_matches <- 20260702000600_spectate_mode
-- Signatures unchanged, so CREATE OR REPLACE retains the grant matrix.
-- =========================================================

create or replace function search_profiles(p_query text, p_limit int default 10)
returns table (id uuid, username text, display_name text, avatar_url text, elo int)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select id, username, display_name, avatar_url, elo
  from profiles
  where (username ilike '%' || p_query || '%' or display_name ilike '%' || p_query || '%')
    and id <> auth.uid()
    and not is_bot
  order by elo desc
  limit p_limit;
$$;

create or replace function get_active_matches(p_limit int default 20)
returns table (
  match_id      uuid,
  player_a_username text,
  player_a_elo       int,
  player_b_username text,
  player_b_elo       int,
  score_a       int,
  score_b       int,
  current_index smallint,
  started_at    timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    m.id, pa.username, pa.elo, pb.username, pb.elo,
    m.score_a, m.score_b, m.current_index, m.started_at
  from matches m
  join profiles pa on pa.id = m.player_a
  join profiles pb on pb.id = m.player_b
  where m.status = 'active'
    and not pa.is_bot and not pb.is_bot
  order by m.started_at desc
  limit p_limit;
$$;

-- CREATE OR REPLACE keeps the existing ACL, but restate it: these two have been
-- recreated from a stale base before, and anon must never get back in.
revoke execute on function search_profiles(text, int)  from public, anon;
revoke execute on function get_active_matches(int)     from public, anon;
grant  execute on function search_profiles(text, int)  to authenticated, service_role;
grant  execute on function get_active_matches(int)     to authenticated, service_role;
