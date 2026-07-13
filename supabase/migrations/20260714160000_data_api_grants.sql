-- =========================================================
-- Data API grants — make migrations self-contained.
--
-- These migrations never granted table privileges to the Data API roles
-- (anon / authenticated / service_role); the app relied entirely on Supabase's
-- `auto_expose_new_tables`, which auto-granted SELECT/INSERT/UPDATE/DELETE on
-- tables created by `postgres`. That flag's implicit default flipped to `false`
-- on 2026-05-30 to match the new cloud default, so a project provisioned after
-- that date deploys these migrations clean but has ZERO table access for
-- anon/authenticated — every non-RPC path breaks with `permission denied`
-- (20+ `.from("profiles")`, matches/queue/challenges reads, realtime
-- postgres_changes). Existing prod is safe only because its grants were baked
-- into the catalog at table-creation time under the old default; a DR restore
-- or fresh clone is not.
--
-- This reproduces exactly what auto-expose granted (RLS remains the real gate:
-- tables with zero policies still deny all despite the grant), and sets DEFAULT
-- PRIVILEGES so tables created by future migrations inherit the same access
-- without depending on the deprecated flag.
--
-- Idempotent: GRANT is a no-op where the privilege already exists (prod).
-- =========================================================

-- ── existing tables + sequences ─────────────────────────────────────────────
grant select, insert, update, delete on all tables    in schema public to anon, authenticated, service_role;
grant usage, select                 on all sequences in schema public to anon, authenticated, service_role;

-- ── future tables/sequences created by postgres (migrations run as postgres) ─
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select                 on sequences to anon, authenticated, service_role;
