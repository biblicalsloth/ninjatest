-- ─────────────────────────────────────────────────────────
-- Ninja AI: OpenRouter is the only provider.
--
-- WHY: ai_config.provider let /admin route to OpenAI direct, which meant two
-- API keys, two billing surfaces, and a switch nobody exercised — the live row
-- has been 'openrouter' since it was seeded. OpenRouter is OpenAI-compatible
-- and also proxies OpenAI's embedding models, so nothing is lost by dropping
-- the branch. One key (OPENROUTER_API_KEY), one bill, one code path.
--
-- z-ai/glm-5.2 is the ONLY model powering Ninja. fallback_model_id is null by
-- intent, not by omission: OpenRouter already load-balances and fails over
-- across 28 upstream providers for that one model id (Novita, DeepInfra,
-- Baidu, Z.AI, Fireworks, …), so a cross-model fallback adds no availability —
-- it only adds a second model whose answers differ from the one that was
-- evaluated. The fallback loops in the routes stay: they iterate
-- [model_id, fallback_model_id].filter(Boolean), so a null is simply a
-- one-element list. Setting a fallback again is a config write, not a deploy.
--
-- Also repairs two live-verified defects in the seeded row:
--   1. fallback_model_id 'google/gemini-2.0-flash-001' is DELISTED from
--      OpenRouter's catalog (checked against /api/v1/models: 342 models, absent).
--      Every fallback loop in the app had a second iteration that could only
--      throw, so a primary-model failure was a 502, not a fallback. Nulling it
--      makes that explicit instead of pretending a dead model is a safety net.
--   2. max_tokens 1200 does not fit z-ai/glm-5.2's reasoning tokens. They bill
--      as completion AND consume the output budget before the answer starts.
--      Measured: a trivial "2+2" burns 83 reasoning tokens; a real CAT quant
--      solve burns 224. A 300-token cap returned content=null outright. 4000
--      leaves room for the reasoning trace plus the answer.
-- ─────────────────────────────────────────────────────────

-- Functions first: both depend on the ai_config composite type, so the column
-- drop fails while they exist.
drop function if exists get_ai_config();
drop function if exists admin_set_ai_config(text, text, text, boolean, text, numeric, int);

alter table ai_config drop column if exists provider;

-- Repair the live row. Explicit values, not defaults — the row already exists,
-- so column defaults would not touch it.
update ai_config set
  model_id          = 'z-ai/glm-5.2',
  fallback_model_id = null,
  max_tokens        = greatest(max_tokens, 4000),
  updated_at        = now()
where id;

-- Re-seed defaults for a fresh deploy so a new environment starts on live model
-- ids rather than the 2026-07 originals (which named a since-delisted model).
alter table ai_config alter column model_id set default 'z-ai/glm-5.2';
alter table ai_config alter column max_tokens set default 4000;

-- ── read config (non-secret) — routes + admin panel ──
create or replace function get_ai_config()
returns ai_config
language sql stable security definer
set search_path = pg_catalog, public as $$
  select * from ai_config where id;
$$;

-- ── admin: update config (p_provider gone) ──
create or replace function admin_set_ai_config(
  p_model_id text, p_fallback_model_id text,
  p_enabled boolean, p_system_prompt text, p_temperature numeric, p_max_tokens int
) returns ai_config
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare cfg ai_config;
begin
  if not coalesce((select is_admin from profiles where id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;
  update ai_config set
    model_id          = p_model_id,
    fallback_model_id = nullif(btrim(p_fallback_model_id), ''),
    enabled           = p_enabled,
    system_prompt     = p_system_prompt,
    temperature       = p_temperature,
    max_tokens        = p_max_tokens,
    updated_at        = now()
  where id
  returning * into cfg;
  return cfg;
end; $$;

-- ── grants: revoke from anon/public, allow authenticated ──
revoke execute on function get_ai_config()                                       from public, anon;
revoke execute on function admin_set_ai_config(text,text,boolean,text,numeric,int) from public, anon;

grant execute on function get_ai_config()                                        to authenticated, service_role;
grant execute on function admin_set_ai_config(text,text,boolean,text,numeric,int)  to authenticated, service_role;
