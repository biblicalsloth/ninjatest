-- Admin console was removed from the app on 2026-07-19 (b585065), but its nine
-- definer RPCs stayed granted to `authenticated` — dead attack surface guarded
-- only by an inline is_admin check. Nothing in app/, lib/ or scripts/ calls
-- them (bank writes go through service_role ingest scripts, which bypass these).
--
-- ponytail: profiles.is_admin is KEPT. profiles_insert/profiles_update WITH
-- CHECK freeze it and the question-assets storage write policies read it; with
-- no RPC left that honours it, the column is inert. Dropping it means rewriting
-- four policies for no security gain.
--
-- ai_config is now changed by SQL only (was admin_set_ai_config):
--   update ai_config set model_id = '…' where id;

drop function if exists public.admin_upsert_questions(jsonb);
drop function if exists public.admin_list_questions(text, boolean);
drop function if exists public.admin_set_question_active(uuid, boolean);
drop function if exists public.admin_set_passage_active(uuid, boolean);
drop function if exists public.admin_update_question_options(uuid, jsonb, integer, text);
drop function if exists public.admin_flagged_questions();
drop function if exists public.admin_suspect_matches();
drop function if exists public.admin_set_ai_config(text, text, boolean, text, numeric, integer);
drop function if exists public.get_waitlist_admin();
