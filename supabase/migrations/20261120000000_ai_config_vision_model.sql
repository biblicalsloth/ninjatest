-- Vision model for /ninja "Share your screen" snapshots. ai_config.model_id
-- (glm-5.2) is text-only, so image turns on /api/ninja/coach route here
-- instead. Same rule as the other ids: switch by SQL, no deploy; check the id
-- against https://openrouter.ai/api/v1/models first (nothing validates it).
-- NULL disables screen share (the route answers 503).
-- get_ai_config() is `select * from ai_config`, so it returns the new column
-- with no redefinition.
alter table ai_config
  add column if not exists vision_model_id text default 'google/gemini-2.5-flash-lite';
