-- ─────────────────────────────────────────────────────────
-- Ninja Chat: modern-LLM-style saved conversations.
--
-- Coach turns were bucketed only by match_id (null = one giant "General"
-- bucket), so every freeform chat collapsed into a single thread. A ChatGPT-
-- style page needs MANY distinct conversations, so we add a conversation_id.
-- No new table — a conversation is just the group of ninja_coach_messages
-- sharing a conversation_id; the title is derived from its first question.
-- Legacy rows keep conversation_id = null and stay visible in /ninja history.
--
-- Follows the ninja_coach_history idioms: RLS-on / zero-policy table, definer-
-- only RPCs, inline search_path pin, revoke public/anon + grant authenticated.
-- ─────────────────────────────────────────────────────────

alter table ninja_coach_messages add column if not exists conversation_id uuid;

create index if not exists ninja_coach_messages_conversation_idx
  on ninja_coach_messages (user_id, conversation_id, created_at);

-- ── save one answered coach turn (now conversation-aware) ──
-- Recreated with p_conversation_id appended (default null keeps the floating
-- coach + match-tagged callers working unchanged). Drop the old 4-arg first so
-- no stale overload lingers; named-arg callers rebind to this signature.
drop function if exists save_ninja_coach_turn(uuid, text, text, text);
create or replace function save_ninja_coach_turn(
  p_match_id uuid, p_question text, p_answer text, p_model text,
  p_conversation_id uuid default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'unauthorized'; end if;
  if coalesce(btrim(p_answer), '') = '' then raise exception 'empty answer'; end if;

  -- If tagged to a match, the caller must be a participant.
  if p_match_id is not null and not exists (
    select 1 from matches m
    where m.id = p_match_id and uid in (m.player_a, m.player_b)
  ) then
    raise exception 'forbidden';
  end if;

  insert into ninja_coach_messages (user_id, match_id, conversation_id, question, answer, model_id)
  values (uid, p_match_id, p_conversation_id, left(p_question, 2000), left(p_answer, 20000), left(p_model, 200));
end; $$;

-- ── list the caller's conversations, newest-first ──
-- title = the conversation's first (oldest) question, trimmed client-side.
create or replace function list_coach_conversations()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'conversation_id', c.conversation_id,
    'title', c.title,
    'last_at', c.last_at,
    'turns', c.cnt
  ) order by c.last_at desc), '[]'::jsonb)
  from (
    select conversation_id,
           max(created_at) as last_at,
           count(*)        as cnt,
           (array_agg(question order by created_at asc))[1] as title
    from ninja_coach_messages
    where user_id = (select auth.uid()) and conversation_id is not null
    group by conversation_id
  ) c;
$$;

-- ── full turn history of one conversation, oldest-first (own rows only) ──
-- Used both to render the thread and (last N sliced server-side) for memory.
create or replace function get_coach_conversation(p_conversation_id uuid)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'question', question,
    'answer', answer,
    'created_at', created_at
  ) order by created_at asc), '[]'::jsonb)
  from ninja_coach_messages
  where user_id = (select auth.uid()) and conversation_id = p_conversation_id;
$$;

-- ── delete a whole conversation (own rows only) ──
create or replace function delete_coach_conversation(p_conversation_id uuid)
returns void
language sql security definer
set search_path = pg_catalog, public as $$
  delete from ninja_coach_messages
  where user_id = (select auth.uid()) and conversation_id = p_conversation_id;
$$;

revoke execute on function save_ninja_coach_turn(uuid, text, text, text, uuid) from public, anon;
revoke execute on function list_coach_conversations()                          from public, anon;
revoke execute on function get_coach_conversation(uuid)                        from public, anon;
revoke execute on function delete_coach_conversation(uuid)                     from public, anon;

grant execute on function save_ninja_coach_turn(uuid, text, text, text, uuid) to authenticated, service_role;
grant execute on function list_coach_conversations()                          to authenticated, service_role;
grant execute on function get_coach_conversation(uuid)                        to authenticated, service_role;
grant execute on function delete_coach_conversation(uuid)                     to authenticated, service_role;
