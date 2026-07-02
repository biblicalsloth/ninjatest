-- Daily challenges (spec v2 social/engagement) — a checklist of today's
-- match activity, not a new solo/non-matched question mode. The app has no
-- question-serving path outside an active 1v1 match; a real solo quiz would
-- need its own RPC + scoring path, out of scope for this batch. Computed
-- from existing matches data, no new game mode.

create or replace function get_daily_progress()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'matches_today', (
      select count(*) from matches
      where (player_a = auth.uid() or player_b = auth.uid())
        and status = 'completed'
        and created_at::date = current_date
    ),
    'wins_today', (
      select count(*) from matches
      where winner_id = auth.uid()
        and created_at::date = current_date
    )
  );
$$;

revoke execute on function get_daily_progress() from public, anon, authenticated;
grant execute on function get_daily_progress() to authenticated, service_role;
