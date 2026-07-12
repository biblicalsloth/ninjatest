-- Seasons soft-reset (end_current_season) halved every profile's ELO but wrote
-- nothing to rating_history, leaving an unexplained cliff in the profile ELO
-- graph each month. Record the reset as a match_id-null history row per player
-- so the timeline stays continuous. Skip elo=1000 accounts (no-op reset).
--
-- Only the rating_history insert is new; the rest is unchanged from
-- 20260702000300_seasons.sql.
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

  insert into season_results(season_id, user_id, final_elo, final_rank)
  select s.id, id, elo, rank() over (order by elo desc) from profiles;

  -- Record the soft reset in each player's ELO timeline (elo_before captured
  -- pre-update). match_id null = not a match-driven change.
  insert into rating_history(user_id, match_id, elo_before, elo_after, delta)
  select id, null, elo, 1000 + ((elo - 1000) / 2), (1000 + ((elo - 1000) / 2)) - elo
  from profiles
  where elo <> 1000;

  update profiles set elo = 1000 + ((elo - 1000) / 2);

  -- Roll straight into the next monthly season so there's always exactly one
  -- active season for the UI to show.
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

-- Banner-gap fix: between a season's real end and the hourly cron reseeding the
-- next one (up to ~1h), no season satisfied `ends_at > now()`, so the leaderboard
-- banner vanished. Drop that filter and return the latest already-started season;
-- daysLeft clamps to 0 ("Ends today") until the next season is seeded.
create or replace function get_current_season()
returns table (name text, ends_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select name, ends_at from seasons
  where starts_at <= now()
  order by ends_at desc limit 1;
$$;
