-- Per-question ELO for adaptive difficulty selection.
-- Each question carries a rating; correct answers nudge it down, wrong ones up
-- (see submit_answer in 20260713000300). Match question selection biases toward
-- questions near the players' average ELO.
--
-- Backfill from the existing `difficulty` (2..4) so selection is sensible on day
-- one; real answer data then refines it. 156 rows, no index needed — a seq scan
-- over the ORDER BY is instant.

alter table questions
  add column if not exists elo        integer not null default 1200,
  add column if not exists times_seen integer not null default 0;

update questions set elo = 1000 + difficulty * 100;
