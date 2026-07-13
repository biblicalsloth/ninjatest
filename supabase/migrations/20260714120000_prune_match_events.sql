-- match_events is append-only (one row per fast_answer / tab_hidden / window_blur)
-- and matches are never deleted, so nothing ever reclaims it. Add a daily prune
-- so anti-cheat telemetry can't bloat storage or slow scans over months of play.
-- 30 days is well past any live match; raise if forensic history matters.

create index if not exists idx_match_events_created_at on match_events(created_at);

select cron.schedule(
  'prune-match-events',
  '17 4 * * *',
  $$delete from match_events where created_at < now() - interval '30 days'$$
);
