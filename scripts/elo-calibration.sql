-- ELO calibration report — READ-ONLY, safe on prod.
--   psql "$DB_URL" -f scripts/elo-calibration.sql
--
-- Buckets completed rated matches by pre-match rating gap and compares the
-- Elo-predicted win probability of the higher-rated player against the
-- actual outcome. Well-calibrated ratings => predicted ~ actual per bucket,
-- and a low Brier score. Use this to tune K and the 0.3/0.7 margin-factor
-- split from data instead of vibes (needs a few hundred rated matches to
-- say anything; ignore buckets with n < 30).

with rated as (
  select
    elo_a_before, elo_b_before, winner_id, player_a, player_b,
    abs(elo_a_before - elo_b_before) as gap,
    -- higher-rated player's Elo expectation
    1.0 / (1.0 + power(10, -abs(elo_a_before - elo_b_before)::numeric / 400.0)) as e_fav,
    -- actual score from the favorite's perspective (1 win / 0.5 draw / 0 loss)
    case
      when winner_id is null then 0.5
      when (elo_a_before >= elo_b_before and winner_id = player_a)
        or (elo_b_before >  elo_a_before and winner_id = player_b) then 1.0
      else 0.0
    end as s_fav
  from matches
  where is_rated and status = 'completed'
    and elo_a_before is not null and elo_b_before is not null
)
select
  format('%s-%s', (width_bucket(gap, 0, 500, 10) - 1) * 50,
                   width_bucket(gap, 0, 500, 10) * 50)      as gap_bucket,
  count(*)                                                  as n,
  round(avg(e_fav)::numeric, 3)                             as predicted_fav_winrate,
  round(avg(s_fav)::numeric, 3)                             as actual_fav_winrate,
  round(avg(s_fav)::numeric - avg(e_fav)::numeric, 3)       as calibration_error,
  round(avg((s_fav - e_fav) ^ 2)::numeric, 4)               as brier
from rated
group by width_bucket(gap, 0, 500, 10)
order by min(gap);

-- Overall Brier (lower = better; 0.25 = coin-flip baseline at even ratings)
with rated as (
  select
    1.0 / (1.0 + power(10, -abs(elo_a_before - elo_b_before)::numeric / 400.0)) as e_fav,
    case
      when winner_id is null then 0.5
      when (elo_a_before >= elo_b_before and winner_id = player_a)
        or (elo_b_before >  elo_a_before and winner_id = player_b) then 1.0
      else 0.0
    end as s_fav
  from matches
  where is_rated and status = 'completed'
    and elo_a_before is not null and elo_b_before is not null
)
select count(*) as n_matches,
       round(avg((s_fav - e_fav) ^ 2)::numeric, 4) as overall_brier
from rated;
