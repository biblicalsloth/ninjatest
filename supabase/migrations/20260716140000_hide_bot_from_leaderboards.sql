-- Ninja Bot is a real profiles row (20260715070000) so every FK/RLS path works,
-- which also means it ranks in every query that orders profiles by elo.
-- Exclude it from both ladders: the live leaderboard and the season snapshot.

-- Base: 20260713100000_audit_round3_fixes.sql
create or replace function get_leaderboard(p_limit int default 50, p_offset int default 0)
returns table (
  rank         bigint,
  username     text,
  display_name text,
  elo          int,
  wins         int,
  losses       int,
  draws        int,
  avatar_url   text
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select
    rank() over (order by elo desc, wins desc, username asc),
    username,
    display_name,
    elo,
    wins,
    losses,
    draws,
    avatar_url
  from profiles
  where not is_bot
  order by elo desc, wins desc, username asc
  limit  least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Base: 20260713090000_audit_round2_fixes.sql (L4)
create or replace function end_current_season()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s seasons%rowtype;
  next_starts timestamptz;
begin
  select * into s from seasons
  where ends_at <= now() and id not in (select season_id from season_results)
  order by ends_at limit 1;

  if not found then return; end if;

  -- With zero profiles the season_results insert is empty, so the same season
  -- would be re-selected (and 'Season N+1' re-inserted) every hourly tick.
  if not exists (select 1 from profiles where not is_bot) then return; end if;

  -- Lock every profile in id order (the same order apply_rated_result/apply_draw
  -- lock their pair) so an in-flight rated finalization either fully precedes or
  -- fully follows the reset — no split snapshot, no deadlock.
  perform 1 from profiles order by id for update;

  insert into season_results(season_id, user_id, final_elo, final_rank)
  select s.id, id, elo, rank() over (order by elo desc)
  from profiles where not is_bot;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta)
  select id, null, elo, 1000 + ((elo - 1000) / 2), (1000 + ((elo - 1000) / 2)) - elo
  from profiles
  where elo <> 1000 and not is_bot;

  update profiles set elo = 1000 + ((elo - 1000) / 2) where not is_bot;

  next_starts := s.ends_at;
  insert into seasons(name, starts_at, ends_at)
  values (
    'Season ' || (s.id + 1),
    next_starts,
    next_starts + interval '1 month'
  );
end;
$$;

revoke execute on function end_current_season() from public, anon, authenticated;
