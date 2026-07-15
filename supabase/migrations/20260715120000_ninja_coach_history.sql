-- ─────────────────────────────────────────────────────────
-- Ninja AI history: persist Coach chat turns + a unified read that groups
-- every piece of Ninja output (coach chat, match debriefs, in-match hints)
-- into per-match sessions for the /ninja screen.
--
-- Coach chat was ephemeral (React state only). Now each answered turn is
-- saved. match_id is optional — the floating coach is global-stats Q&A
-- (null = "General"); result/match pages may pass a match to tag the turn.
-- Structure mirrors ninja_debriefs / ninja_responses verbatim (RLS on, zero
-- policies, definer-only RPCs).
-- ─────────────────────────────────────────────────────────

create table if not exists ninja_coach_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  match_id   uuid references matches(id) on delete set null,  -- null = general chat
  question   text not null,
  answer     text not null,
  model_id   text not null,
  created_at timestamptz not null default now()
);
create index if not exists ninja_coach_messages_lookup_idx
  on ninja_coach_messages (user_id, created_at desc);

-- RLS on, zero policies: definer-only (matches ninja_responses/ninja_debriefs).
alter table ninja_coach_messages enable row level security;

-- ── save one answered coach turn (route calls after runCoach succeeds) ──
create or replace function save_ninja_coach_turn(
  p_match_id uuid, p_question text, p_answer text, p_model text
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

  insert into ninja_coach_messages (user_id, match_id, question, answer, model_id)
  values (uid, p_match_id, left(p_question, 2000), left(p_answer, 20000), left(p_model, 200));
end; $$;

-- ── unified history for /ninja, grouped into per-match sessions ──
-- Returns a jsonb array of sessions newest-first; each session has its match
-- context (null match_id = the "General" coach bucket) and its items asc by time.
create or replace function get_ninja_history()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  with items as (
    select match_id, 'coach'::text as kind, null::int as question_index,
           question, answer as content, created_at
    from ninja_coach_messages where user_id = (select auth.uid())
    union all
    select match_id, 'debrief', null, null, content, created_at
    from ninja_debriefs where user_id = (select auth.uid())
    union all
    select match_id, 'response', question_index, null, content, created_at
    from ninja_responses where user_id = (select auth.uid())
  ),
  sessions as (
    select
      i.match_id,
      max(i.created_at) as last_at,
      jsonb_agg(jsonb_build_object(
        'kind', i.kind,
        'question_index', i.question_index,
        'question', i.question,
        'content', i.content,
        'created_at', i.created_at
      ) order by i.created_at) as session_items
    from items i
    group by i.match_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'match_id', s.match_id,
    'opponent', case
      when s.match_id is null then null
      else (select p.username from profiles p
            where p.id = case when m.player_a = (select auth.uid()) then m.player_b else m.player_a end)
    end,
    'result', case
      when m.id is null then null
      when m.winner_id = (select auth.uid()) then 'win'
      when m.winner_id is null and m.status = 'completed' then 'draw'
      when m.status in ('completed','abandoned') then 'loss'
      else null end,
    'played_at', m.created_at,
    'last_at', s.last_at,
    'items', s.session_items
  ) order by s.last_at desc), '[]'::jsonb)
  from sessions s
  left join matches m on m.id = s.match_id;
$$;

revoke execute on function save_ninja_coach_turn(uuid, text, text, text) from public, anon;
revoke execute on function get_ninja_history()                          from public, anon;

grant execute on function save_ninja_coach_turn(uuid, text, text, text) to authenticated, service_role;
grant execute on function get_ninja_history()                           to authenticated, service_role;
