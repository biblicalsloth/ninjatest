-- =========================================================
-- get_profile_deep_stats: match-derived stats for the profile page.
--
-- One RPC, one jsonb payload:
--   form      last 10 results, most recent first ('W' | 'L' | 'D')
--   scoring   avg/best match score, avg victory & defeat margins
--   elo       best single-match gain, worst drop, net delta last 30 days,
--             timestamp the peak rating was reached
--   sections  per-section wrong/skipped counts, avg & fastest answer times,
--             penalty points conceded, speed-bonus points earned
--   rivals    top 3 most-played opponents with head-to-head W/L/D
--
-- security definer: match_answers/matches RLS only exposes a viewer's own
-- matches, but profile pages are public — this returns aggregates only,
-- never raw answers or question ids. Like get_profile / get_section_stats,
-- the default PUBLIC execute grant is intentionally kept so logged-out
-- profile views work.
-- =========================================================

create or replace function public.get_profile_deep_stats(p_username text)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public
as $$
with p as (
  select id from profiles where username = p_username
),
mm as (
  select
    m.ended_at,
    case when m.player_a = p.id then m.score_a else m.score_b end as my_score,
    case when m.player_a = p.id then m.score_b else m.score_a end as opp_score,
    case when m.winner_id = p.id then 'W'
         when m.winner_id is null and m.status = 'completed' then 'D'
         else 'L' end as res,
    case when m.player_a = p.id then m.player_b else m.player_a end as opp_id
  from matches m
  join p on p.id in (m.player_a, m.player_b)
  where m.status in ('completed', 'abandoned')
    and m.ended_at is not null
),
sect as (
  select
    q.section,
    count(*) filter (where ma.selected_index is not null and not ma.is_correct)::int as wrong,
    count(*) filter (where ma.selected_index is null)::int                           as skipped,
    round(avg(ma.time_taken_ms) filter (where ma.selected_index is not null))::int   as avg_time_ms,
    min(ma.time_taken_ms) filter (where ma.is_correct)::int                          as fastest_correct_ms,
    coalesce(sum(-ma.points_awarded) filter (where ma.points_awarded < 0), 0)::int   as penalty_points,
    coalesce(sum(ma.points_awarded - sc.base_points) filter (where ma.is_correct), 0)::int as speed_bonus_points
  from match_answers ma
  join p on p.id = ma.user_id
  join questions q on q.id = ma.question_id
  join section_config sc on sc.section = q.section
  join matches m on m.id = ma.match_id
  where m.status in ('completed', 'abandoned')
  group by q.section
),
rv as (
  select
    pr.username,
    pr.display_name,
    pr.avatar_url,
    count(*)::int                              as played,
    count(*) filter (where mm.res = 'W')::int  as wins,
    count(*) filter (where mm.res = 'L')::int  as losses,
    count(*) filter (where mm.res = 'D')::int  as draws
  from mm
  join profiles pr on pr.id = mm.opp_id
  group by pr.username, pr.display_name, pr.avatar_url
  order by count(*) desc, pr.username
  limit 3
)
select jsonb_build_object(
  'form', (
    select coalesce(jsonb_agg(f.res order by f.ended_at desc), '[]'::jsonb)
    from (select res, ended_at from mm order by ended_at desc limit 10) f
  ),
  'scoring', (
    select jsonb_build_object(
      'avg_points',      round(avg(my_score))::int,
      'best_score',      max(my_score),
      'avg_margin_win',  round(avg(my_score - opp_score) filter (where res = 'W'))::int,
      'avg_margin_loss', round(avg(opp_score - my_score) filter (where res = 'L'))::int
    )
    from mm
  ),
  'elo', (
    select jsonb_build_object(
      'best_gain',  max(rh.delta)::int,
      'worst_loss', min(rh.delta)::int,
      'delta_30d',  coalesce(sum(rh.delta) filter (where rh.created_at > now() - interval '30 days'), 0)::int,
      'peak_at', (
        select rh2.created_at
        from rating_history rh2
        join p on p.id = rh2.user_id
        order by rh2.elo_after desc, rh2.created_at asc
        limit 1
      )
    )
    from rating_history rh
    join p on p.id = rh.user_id
  ),
  'sections', (select coalesce(jsonb_agg(to_jsonb(sect) order by sect.section), '[]'::jsonb) from sect),
  'rivals',   (select coalesce(jsonb_agg(to_jsonb(rv) order by rv.played desc), '[]'::jsonb) from rv)
)
from p;
$$;
