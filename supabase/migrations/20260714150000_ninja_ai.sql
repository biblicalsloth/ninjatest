-- ─────────────────────────────────────────────────────────
-- Ninja AI layer: admin-switchable model config + per-question saved answers.
--
-- API keys live in env (OPENROUTER_API_KEY / OPENAI_API_KEY), never the DB.
-- ai_config holds only non-secret routing (provider, model id, prompt, dials);
-- the app reads it at request time so an admin model switch takes effect on the
-- next request with no deploy.
--
-- Guards reuse the get_answer_reveal pattern: Ninja may only see a question in a
-- match the caller participated in, and never an unreached question on a live
-- match (RLS keeps `questions` unreadable by clients — served via definer only).
-- ─────────────────────────────────────────────────────────

-- ── singleton config row ──
create table if not exists ai_config (
  id               boolean primary key default true check (id),   -- one row only
  provider         text    not null default 'openrouter' check (provider in ('openrouter', 'openai')),
  model_id         text    not null default 'openai/gpt-4o-mini',
  fallback_model_id text,
  enabled          boolean not null default true,
  system_prompt    text    not null default
    'You are Ninja, an expert CAT (Common Admission Test) tutor. Solve the question step by step with concise reasoning, then state your final answer on its own line as "Answer: <option>". If the correct answer is provided, compare yours to it and briefly explain any difference.',
  temperature      numeric not null default 0.3 check (temperature >= 0 and temperature <= 2),
  max_tokens       int     not null default 1200 check (max_tokens > 0 and max_tokens <= 8000),
  updated_at       timestamptz not null default now()
);
insert into ai_config (id) values (true) on conflict (id) do nothing;

-- RLS on, zero policies: reachable only through the definer RPCs below.
alter table ai_config enable row level security;

-- ── saved Ninja answers, one row per ask (history kept) ──
create table if not exists ninja_responses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  match_id       uuid not null references matches(id) on delete cascade,
  question_index int  not null check (question_index >= 0 and question_index <= 8),
  model_id       text not null,
  content        text not null,
  created_at     timestamptz not null default now()
);
create index if not exists ninja_responses_lookup_idx
  on ninja_responses (user_id, match_id, question_index, created_at desc);

-- RLS on, zero policies: definer-only (matches friendships/match_events).
alter table ninja_responses enable row level security;

-- ── read config (non-secret) — route + admin panel ──
create or replace function get_ai_config()
returns ai_config
language sql stable security definer
set search_path = pg_catalog, public as $$
  select * from ai_config where id;
$$;

-- ── admin: update config ──
create or replace function admin_set_ai_config(
  p_provider text, p_model_id text, p_fallback_model_id text,
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
    provider          = p_provider,
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

-- ── fetch full question for Ninja (participant-only, never unreached) ──
create or replace function get_question_for_ninja(p_match_id uuid, p_index int)
returns table(section text, body text, options jsonb,
              correct_index smallint, explanation text, passage_body text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype; q questions%rowtype;
begin
  if p_index < 0 or p_index > 8 then raise exception 'bad index'; end if;
  select * into m from matches where id = p_match_id;
  if not found or (select auth.uid()) not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];
  return query
    select q.section::text, q.body, q.options, q.correct_index, q.explanation,
           (select p.body from passages p where p.id = q.passage_id);
end; $$;

-- ── save a Ninja answer (participant-only) ──
create or replace function save_ninja_response(
  p_match_id uuid, p_index int, p_model text, p_content text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype; uid uuid := (select auth.uid()); new_id uuid;
begin
  if p_index < 0 or p_index > 8 then raise exception 'bad index'; end if;
  if coalesce(btrim(p_content), '') = '' then raise exception 'empty content'; end if;
  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;

  insert into ninja_responses (user_id, match_id, question_index, model_id, content)
  values (uid, p_match_id, p_index, left(p_model, 200), left(p_content, 20000))
  returning id into new_id;
  return new_id;
end; $$;

-- ── read caller's own saved answers for a question ──
create or replace function get_ninja_responses(p_match_id uuid, p_index int)
returns table(id uuid, model_id text, content text, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select r.id, r.model_id, r.content, r.created_at
  from ninja_responses r
  where r.match_id = p_match_id and r.question_index = p_index
    and r.user_id = (select auth.uid())
  order by r.created_at desc;
$$;

-- ── grants: revoke from anon/public, allow authenticated ──
revoke execute on function get_ai_config()                                     from public, anon;
revoke execute on function admin_set_ai_config(text,text,text,boolean,text,numeric,int) from public, anon;
revoke execute on function get_question_for_ninja(uuid,int)                    from public, anon;
revoke execute on function save_ninja_response(uuid,int,text,text)             from public, anon;
revoke execute on function get_ninja_responses(uuid,int)                       from public, anon;

grant execute on function get_ai_config()                                      to authenticated, service_role;
grant execute on function admin_set_ai_config(text,text,text,boolean,text,numeric,int)  to authenticated, service_role;
grant execute on function get_question_for_ninja(uuid,int)                     to authenticated, service_role;
grant execute on function save_ninja_response(uuid,int,text,text)              to authenticated, service_role;
grant execute on function get_ninja_responses(uuid,int)                        to authenticated, service_role;
