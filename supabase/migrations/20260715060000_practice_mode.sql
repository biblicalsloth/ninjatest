-- ─────────────────────────────────────────────────────────
-- Weakness-targeted practice mode: solo 9-question drills, no ELO, no timers.
--
-- Composition is adaptive: the caller's real per-section accuracy (from rated
-- + unrated match answers) orders sections weakest-first → 5/3/1 questions.
-- No play history → 3/3/3. Question choice biases toward the player's ELO
-- with jitter (same idea as pick_section_question_ids, simplified: practice
-- has no passage-group requirement).
--
-- Bank protection: correct_index/explanation are revealed only AFTER the
-- answer is locked in (submit returns them); questions are served one at a
-- time in order; 5 sessions/user/day caps exposure at 45 questions/day.
-- Practice answers never touch question ELO or player ELO.
-- ─────────────────────────────────────────────────────────

create table if not exists practice_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  question_ids  uuid[] not null,
  current_index int  not null default 0,
  correct_count int  not null default 0,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists practice_sessions_user_idx on practice_sessions (user_id, created_at desc);

create table if not exists practice_answers (
  session_id     uuid not null references practice_sessions(id) on delete cascade,
  question_index int  not null,
  selected_index smallint,
  is_correct     boolean not null default false,
  answered_at    timestamptz not null default now(),
  primary key (session_id, question_index)
);

-- RLS on, zero policies: definer-only.
alter table practice_sessions enable row level security;
alter table practice_answers  enable row level security;

-- ── start a session ──
create or replace function start_practice()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid         uuid := (select auth.uid());
  player_elo  int;
  today_count int;
  ordered     text[];
  wanted      int[] := array[5, 3, 1];
  ids         uuid[] := '{}';
  sec_ids     uuid[];
  i           int;
  sid         uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform check_rate_limit('start_practice', 5, 60);

  select count(*) into today_count
  from practice_sessions
  where user_id = uid and created_at >= date_trunc('day', now());
  if today_count >= 5 then
    raise exception 'daily practice limit reached';
  end if;

  select elo into player_elo from profiles where id = uid;

  -- Sections ordered weakest-first by the caller's real accuracy; sections
  -- with <5 real answers count as neutral 0.5 so newcomers get 3/3/3-ish.
  select array_agg(s.sec order by s.acc asc, s.sec) into ordered
  from (
    select sec.sec,
           coalesce((
             select case when count(*) >= 5
                         then avg(case when a.is_correct then 1.0 else 0.0 end) end
             from match_answers a
             join questions q on q.id = a.question_id
             where a.user_id = uid and a.selected_index is not null
               and q.section = sec.sec::cat_section
           ), 0.5) as acc
    from (values ('VARC'), ('DILR'), ('QUANT')) sec(sec)
  ) s;

  for i in 1..3 loop
    select array_agg(t.id) into sec_ids
    from (
      select q.id
      from questions q
      where q.section = ordered[i]::cat_section and q.is_active
      order by abs(q.elo - (player_elo + (random() * 300 - 150)::int)), random()
      limit wanted[i]
    ) t;
    ids := ids || coalesce(sec_ids, '{}');
  end loop;

  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'no practice questions available';
  end if;

  insert into practice_sessions (user_id, question_ids)
  values (uid, ids)
  returning id into sid;

  return jsonb_build_object('session_id', sid, 'total', array_length(ids, 1));
end; $$;

-- ── serve the CURRENT question (no key, no explanation) ──
create or replace function get_practice_question(p_session uuid, p_index int)
returns table(section text, body text, options jsonb, image_url text,
              passage_body text, passage_image_url text)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare s practice_sessions%rowtype;
begin
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  if p_index <> s.current_index or p_index >= array_length(s.question_ids, 1) then
    raise exception 'bad index';
  end if;

  return query
    select q.section::text, q.body, q.options, q.image_url,
           p.body, p.image_url
    from questions q
    left join passages p on p.id = q.passage_id
    where q.id = s.question_ids[p_index + 1];
end; $$;

-- ── submit (or skip with null) → instant reveal ──
create or replace function submit_practice_answer(p_session uuid, p_index int, p_selected int)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s practice_sessions%rowtype;
  q questions%rowtype;
  v_correct boolean;
  total int;
begin
  select * into s from practice_sessions where id = p_session for update;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;
  total := array_length(s.question_ids, 1);
  if p_index <> s.current_index or p_index >= total then raise exception 'bad index'; end if;

  select * into q from questions where id = s.question_ids[p_index + 1];
  if p_selected is not null
     and (p_selected < 0 or p_selected > jsonb_array_length(q.options) - 1) then
    raise exception 'bad option';
  end if;

  v_correct := p_selected is not null and p_selected = q.correct_index;

  insert into practice_answers (session_id, question_index, selected_index, is_correct)
  values (p_session, p_index, p_selected, v_correct);

  update practice_sessions set
    current_index = p_index + 1,
    correct_count = correct_count + (v_correct::int),
    completed_at  = case when p_index + 1 >= total then now() else completed_at end
  where id = p_session;

  return jsonb_build_object(
    'is_correct', v_correct,
    'correct_index', q.correct_index,
    'explanation', q.explanation,
    'done', p_index + 1 >= total
  );
end; $$;

-- ── resume/summary state (session row + per-question outcomes + sections) ──
create or replace function get_practice_state(p_session uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare s practice_sessions%rowtype;
begin
  select * into s from practice_sessions where id = p_session;
  if not found or s.user_id <> (select auth.uid()) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'current_index', s.current_index,
    'total', array_length(s.question_ids, 1),
    'correct_count', s.correct_count,
    'completed', s.completed_at is not null,
    'sections', (
      select jsonb_agg(q.section::text order by gs.i)
      from generate_subscripts(s.question_ids, 1) gs(i)
      join questions q on q.id = s.question_ids[gs.i]
    ),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'index', a.question_index,
        'skipped', a.selected_index is null,
        'is_correct', a.is_correct) order by a.question_index)
      from practice_answers a where a.session_id = p_session
    ), '[]'::jsonb)
  );
end; $$;

revoke execute on function start_practice()                          from public, anon;
revoke execute on function get_practice_question(uuid, int)          from public, anon;
revoke execute on function submit_practice_answer(uuid, int, int)    from public, anon;
revoke execute on function get_practice_state(uuid)                  from public, anon;

grant execute on function start_practice()                           to authenticated, service_role;
grant execute on function get_practice_question(uuid, int)           to authenticated, service_role;
grant execute on function submit_practice_answer(uuid, int, int)     to authenticated, service_role;
grant execute on function get_practice_state(uuid)                   to authenticated, service_role;
