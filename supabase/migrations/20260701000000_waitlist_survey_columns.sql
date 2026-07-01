-- The waitlist survey (landing-client.tsx) collects name/phone/year/percentile/
-- section alongside email, but the waitlist table only ever stored email — the
-- rest only reached the Google Sheets webhook, which has been failing with 401s
-- since 2026-06-25. Widen the table so the DB insert (added in the same change
-- that adds this migration) is a complete, durable record on its own.

alter table waitlist
  add column if not exists name       text,
  add column if not exists phone      text,
  add column if not exists year       text,
  add column if not exists percentile text,
  add column if not exists section    text;
