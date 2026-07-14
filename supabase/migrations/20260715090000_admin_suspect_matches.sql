-- ─────────────────────────────────────────────────────────
-- Cheat-pattern classifier (heuristic layer): score recent rated matches for
-- external-solver patterns using data we already log:
--   · blur→correct  — tab_hidden/window_blur on a question the player then got
--                     right after >15s (left, consulted something, came back).
--                     Strongest signal, weight 3.
--   · fast_correct  — server-logged fast_answer events (correct <2s), weight 2.
--   · hard_correct  — correct on questions ≥400 ELO above the player, weight 1.
--
-- Flags for ADMIN REVIEW only — nothing is auto-punished. Window is 14 days
-- (match_events are pruned on a similar horizon). The bot is excluded.
-- The AI layer (/api/ninja/anticheat) narrates these rows; it adds no new data.
-- ─────────────────────────────────────────────────────────

create or replace function admin_suspect_matches()
returns table (
  match_id     uuid,
  username     text,
  ended_at     timestamptz,
  blur_correct bigint,
  fast_correct bigint,
  hard_correct bigint,
  score        bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce((select p.is_admin from profiles p where p.id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  return query
  with recent as (
    select m.id, m.ended_at, u.user_id
    from matches m
    cross join lateral (values (m.player_a), (m.player_b)) u(user_id)
    where m.status = 'completed' and m.is_rated
      and m.ended_at > now() - interval '14 days'
  ),
  scored as (
    select r.id as m_id, r.user_id, r.ended_at,
      (select count(*) from match_answers a
        where a.match_id = r.id and a.user_id = r.user_id
          and a.is_correct and a.time_taken_ms > 15000
          and exists (select 1 from match_events e
                      where e.match_id = r.id and e.user_id = r.user_id
                        and e.question_index = a.question_index
                        and e.event_type in ('tab_hidden', 'window_blur'))
      ) as blur_correct,
      (select count(*) from match_events e
        where e.match_id = r.id and e.user_id = r.user_id
          and e.event_type = 'fast_answer'
      ) as fast_correct,
      (select count(*) from match_answers a
        join questions q on q.id = a.question_id
        where a.match_id = r.id and a.user_id = r.user_id
          and a.is_correct
          and q.elo >= (select p.elo from profiles p where p.id = r.user_id) + 400
      ) as hard_correct
    from recent r
    where not coalesce((select p.is_bot from profiles p where p.id = r.user_id), false)
  )
  select s.m_id, p.username, s.ended_at,
         s.blur_correct, s.fast_correct, s.hard_correct,
         (s.blur_correct * 3 + s.fast_correct * 2 + s.hard_correct) as score
  from scored s
  join profiles p on p.id = s.user_id
  where (s.blur_correct * 3 + s.fast_correct * 2 + s.hard_correct) >= 3
  order by (s.blur_correct * 3 + s.fast_correct * 2 + s.hard_correct) desc, s.ended_at desc
  limit 50;
end; $$;

revoke execute on function admin_suspect_matches() from public, anon;
grant  execute on function admin_suspect_matches() to authenticated, service_role;
