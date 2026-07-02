-- Seasons (spec v2 social/engagement). Leagues (Bronze/Silver/Gold/etc.) are
-- pure computed ELO tiers — lib/leagues.ts — nothing to store there. Seasons
-- are periodic full-leaderboard resets with an archived standings snapshot.
-- Modeled on rematch_waiting()'s "internal fn triggered by pg_cron" pattern.
--
-- Cadence: monthly. Reset: soft (halve each player's distance from the
-- starting ELO of 1000) rather than a hard wipe to 1000 — preserves skill
-- signal instead of discarding it, standard for rating-based seasons.

create table seasons (
  id         serial primary key,
  name       text not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now()
);

create table season_results (
  season_id  int not null references seasons(id),
  user_id    uuid not null references profiles(id),
  final_elo  int not null,
  final_rank int not null,
  primary key (season_id, user_id)
);

alter table seasons enable row level security;
alter table season_results enable row level security;
create policy seasons_read on seasons for select using (true);
create policy season_results_read on season_results for select using (true);

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

select cron.unschedule('end-season-sweep')
where exists (select 1 from cron.job where jobname = 'end-season-sweep');
select cron.schedule('end-season-sweep', '0 * * * *', 'select end_current_season()');

-- Seed the first season so there's always an active one to show.
insert into seasons(name, starts_at, ends_at)
values ('Season 1', now(), now() + interval '1 month');

create or replace function get_current_season()
returns table (name text, ends_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select name, ends_at from seasons
  where starts_at <= now() and ends_at > now()
  order by ends_at desc limit 1;
$$;
