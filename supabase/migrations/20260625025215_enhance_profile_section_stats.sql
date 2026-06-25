-- =========================================================
-- 1. get_section_stats: per-section performance for any profile
--    Joins match_answers → questions to compute VARC/DILR/Quant stats.
--    security definer bypasses questions RLS (client read blocked).
-- =========================================================
create or replace function get_section_stats(p_username text)
returns table (
  section            cat_section,
  questions_answered int,
  correct            int,
  accuracy           numeric,
  avg_points         numeric
)
language sql stable security definer as $$
  select
    q.section,
    count(*)::int                                                       as questions_answered,
    sum(case when ma.is_correct then 1 else 0 end)::int                as correct,
    round(avg(case when ma.is_correct then 1.0 else 0.0 end) * 100, 1) as accuracy,
    round(avg(ma.points_awarded::numeric), 1)                          as avg_points
  from profiles p
  join match_answers ma on ma.user_id = p.id
  join questions     q  on q.id = ma.question_id
  join matches       m  on m.id = ma.match_id
  where p.username  = p_username
    and m.status   in ('completed', 'abandoned')
  group by q.section
  order by q.section
$$;

-- =========================================================
-- 2. Update get_profile to include leaderboard rank
-- =========================================================
create or replace function get_profile(p_username text)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'rank', (
      select count(*) + 1
      from profiles p2
      where p2.elo > p.elo
    ),
    'curve', (
      select coalesce(jsonb_agg(
        jsonb_build_object('elo', rh.elo_after, 'at', rh.created_at, 'delta', rh.delta)
        order by rh.created_at
      ), '[]')
      from rating_history rh where rh.user_id = p.id
    )
  )
  from profiles p where p.username = p_username;
$$;