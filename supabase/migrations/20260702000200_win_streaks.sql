-- Win streaks (spec v2 social/engagement). Extends the existing finalize
-- transaction rather than computing on read — same pattern as ELO/W-L-D,
-- updated atomically alongside them. Draws and unrated matches don't touch
-- streaks (unrated already skips all stats per the existing is_rated=false
-- branch in finalize_match; draws reset both players' streak to 0 — a
-- streak means consecutive wins).

alter table profiles
  add column current_streak int not null default 0,
  add column best_streak    int not null default 0;

create or replace function apply_rated_result(
  p_match_id uuid,
  p_winner   uuid,
  p_loser    uuid,
  p_delta    int
)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m       matches%rowtype;
  a_after int;
  b_after int;
begin
  select * into m from matches where id = p_match_id for update;

  if p_winner = m.player_a then
    a_after := m.elo_a_before + p_delta;
    b_after := greatest(100, m.elo_b_before - p_delta);
  else
    b_after := m.elo_b_before + p_delta;
    a_after := greatest(100, m.elo_a_before - p_delta);
  end if;

  update matches set status='completed', ended_at=now(), winner_id=p_winner,
    elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set
    elo=a_after,
    peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end),
    current_streak = case when p_winner = id then current_streak + 1 else 0 end,
    best_streak    = case when p_winner = id then greatest(best_streak, current_streak + 1) else best_streak end
  where id = m.player_a;

  update profiles set
    elo=b_after,
    peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1,
    wins  =wins  +(case when p_winner = id then 1 else 0 end),
    losses=losses+(case when p_loser  = id then 1 else 0 end),
    current_streak = case when p_winner = id then current_streak + 1 else 0 end,
    best_streak    = case when p_winner = id then greatest(best_streak, current_streak + 1) else best_streak end
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, m.elo_a_before, a_after, a_after - m.elo_a_before),
    (m.player_b, p_match_id, m.elo_b_before, b_after, b_after - m.elo_b_before);
end;
$$;

create or replace function apply_draw(p_match_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m        matches%rowtype;
  k_a      int;
  k_b      int;
  e_a      numeric;
  e_b      numeric;
  d_a      int;
  d_b      int;
  a_after  int;
  b_after  int;
begin
  select * into m from matches where id = p_match_id for update;

  select case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into k_a from profiles where id = m.player_a;
  select case when matches_played < 30 then 40 when elo < 2000 then 24 else 16 end
    into k_b from profiles where id = m.player_b;

  e_a := 1.0 / (1.0 + power(10, (m.elo_b_before - m.elo_a_before)::numeric / 400.0));
  e_b := 1.0 - e_a;

  d_a := round(k_a * (0.5 - e_a))::int;
  d_b := round(k_b * (0.5 - e_b))::int;

  a_after := greatest(100, m.elo_a_before + d_a);
  b_after := greatest(100, m.elo_b_before + d_b);

  update matches set status='completed', ended_at=now(), winner_id=null,
    elo_a_after=a_after, elo_b_after=b_after
  where id = p_match_id;

  update profiles set elo=a_after, peak_elo=greatest(peak_elo, a_after),
    matches_played=matches_played+1, draws=draws+1, current_streak=0
  where id = m.player_a;

  update profiles set elo=b_after, peak_elo=greatest(peak_elo, b_after),
    matches_played=matches_played+1, draws=draws+1, current_streak=0
  where id = m.player_b;

  insert into rating_history(user_id, match_id, elo_before, elo_after, delta) values
    (m.player_a, p_match_id, m.elo_a_before, a_after, a_after - m.elo_a_before),
    (m.player_b, p_match_id, m.elo_b_before, b_after, b_after - m.elo_b_before);
end;
$$;
