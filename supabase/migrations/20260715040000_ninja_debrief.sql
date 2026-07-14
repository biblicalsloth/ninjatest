-- ─────────────────────────────────────────────────────────
-- Post-match Ninja debrief: AI "why you won/lost" on the result page.
--
-- One debrief per player per match (PK match_id,user_id) — generated once,
-- cached forever, so revisits never re-bill the LLM. get_debrief_data
-- assembles the numeric story (per-question timing/points/sections for BOTH
-- players, question ELO as difficulty context) server-side because questions
-- and the opponent's rows aren't client-readable. It deliberately excludes
-- question bodies/keys — the debrief is about performance, not content.
-- ─────────────────────────────────────────────────────────

create table if not exists ninja_debriefs (
  match_id   uuid not null references matches(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  model_id   text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

-- RLS on, zero policies: definer-only (matches ninja_responses).
alter table ninja_debriefs enable row level security;

-- ── numeric match story for the debrief prompt (participant, finished only) ──
create or replace function get_debrief_data(p_match_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  m   matches%rowtype;
  uid uuid := (select auth.uid());
  opp uuid;
  res jsonb;
begin
  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;
  if m.status not in ('completed', 'abandoned') then
    raise exception 'match not finished';
  end if;
  opp := case when uid = m.player_a then m.player_b else m.player_a end;

  select jsonb_build_object(
    'status',    m.status,
    'is_rated',  m.is_rated,
    'result',    case when m.winner_id is null and m.status = 'completed' then 'draw'
                      when m.winner_id = uid then 'win'
                      when m.winner_id is null then 'unresolved'
                      else 'loss' end,
    'my_score',  case when uid = m.player_a then m.score_a else m.score_b end,
    'opp_score', case when uid = m.player_a then m.score_b else m.score_a end,
    'my_elo',    (select p.elo from profiles p where p.id = uid),
    'opp_elo',   (select p.elo from profiles p where p.id = opp),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'q',            gs.i,
        'section',      q.section,
        'question_elo', q.elo,
        'cap_ms',       coalesce(q.duration_ms, sc.cap_ms),
        'mine', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null,
                   'points',  a.points_awarded,
                   'time_ms', a.time_taken_ms)
                 from match_answers a
                 where a.match_id = m.id and a.user_id = uid and a.question_index = gs.i - 1),
        'opp', (select jsonb_build_object(
                   'correct', a.is_correct,
                   'skipped', a.selected_index is null,
                   'points',  a.points_awarded,
                   'time_ms', a.time_taken_ms)
                 from match_answers a
                 where a.match_id = m.id and a.user_id = opp and a.question_index = gs.i - 1)
      ) order by gs.i)
      from generate_subscripts(m.question_ids, 1) gs(i)
      join questions q on q.id = m.question_ids[gs.i]
      join section_config sc on sc.section = q.section
    ), '[]'::jsonb)
  ) into res;
  return res;
end; $$;

-- ── caller's saved debrief for a match ──
create or replace function get_ninja_debrief(p_match_id uuid)
returns table(content text, model_id text, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select d.content, d.model_id, d.created_at
  from ninja_debriefs d
  where d.match_id = p_match_id and d.user_id = (select auth.uid());
$$;

-- ── save (first write wins — the route treats an existing row as the answer) ──
create or replace function save_ninja_debrief(p_match_id uuid, p_model text, p_content text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare m matches%rowtype; uid uuid := (select auth.uid());
begin
  if coalesce(btrim(p_content), '') = '' then raise exception 'empty content'; end if;
  select * into m from matches where id = p_match_id;
  if not found or uid not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if m.status not in ('completed', 'abandoned') then raise exception 'match not finished'; end if;

  insert into ninja_debriefs (match_id, user_id, model_id, content)
  values (p_match_id, uid, left(p_model, 200), left(p_content, 8000))
  on conflict (match_id, user_id) do nothing;
end; $$;

revoke execute on function get_debrief_data(uuid)                  from public, anon;
revoke execute on function get_ninja_debrief(uuid)                 from public, anon;
revoke execute on function save_ninja_debrief(uuid, text, text)    from public, anon;

grant execute on function get_debrief_data(uuid)                   to authenticated, service_role;
grant execute on function get_ninja_debrief(uuid)                  to authenticated, service_role;
grant execute on function save_ninja_debrief(uuid, text, text)     to authenticated, service_role;
