-- Rate-limit submit_answer/join_queue per spec §9 ("Rate-limit submit_answer
-- and join_queue (per-user) to prevent abuse"). Neither RPC had any throttle;
-- both are called directly via PostgREST so the app-layer lib/rate-limit.ts
-- (which only guards Next.js route handlers) never sees these calls.
--
-- Modeled on the existing rated_pair_count_today() pattern: a small counter
-- table + a security definer helper, called as the first line of each RPC.

create table rpc_rate_limit (
  user_id      uuid not null,
  fn_name      text not null,
  window_start timestamptz not null default now(),
  count        int not null default 1,
  primary key (user_id, fn_name)
);

alter table rpc_rate_limit enable row level security;
-- No policies: only ever touched by security definer functions (bypass RLS).

create or replace function check_rate_limit(p_fn text, p_limit int, p_window_seconds int)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid uuid := auth.uid();
  existing rpc_rate_limit%rowtype;
begin
  select * into existing from rpc_rate_limit
  where user_id = uid and fn_name = p_fn
  for update;

  if not found then
    insert into rpc_rate_limit(user_id, fn_name) values (uid, p_fn);
    return;
  end if;

  if now() > existing.window_start + (p_window_seconds || ' seconds')::interval then
    update rpc_rate_limit set window_start = now(), count = 1
    where user_id = uid and fn_name = p_fn;
    return;
  end if;

  if existing.count >= p_limit then
    raise exception 'rate limit exceeded';
  end if;

  update rpc_rate_limit set count = count + 1
  where user_id = uid and fn_name = p_fn;
end;
$$;

revoke execute on function check_rate_limit(text, int, int) from public, anon, authenticated;

-- submit_answer: a real match answers each question once; 20 calls / 5s is
-- generous headroom for retries but stops hammering.
create or replace function submit_answer(
  p_match_id       uuid,
  p_question_index smallint,
  p_selected_index smallint
)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m        matches%rowtype;
  q        questions%rowtype;
  cfg      section_config%rowtype;
  uid      uuid := auth.uid();
  is_a     boolean;
  cap      integer;
  taken_ms integer;
  correct  boolean;
  grace    integer;
  pts      integer;
begin
  perform check_rate_limit('submit_answer', 20, 5);

  select * into m from matches where id = p_match_id for update;

  if not found or m.status <> 'active' then raise exception 'match not active'; end if;
  if uid not in (m.player_a, m.player_b) then raise exception 'not a participant'; end if;
  if p_question_index <> m.current_index then raise exception 'stale question'; end if;
  if exists (
    select 1 from match_answers
    where match_id = p_match_id and user_id = uid and question_index = p_question_index
  ) then raise exception 'already answered'; end if;

  select * into q   from questions where id = m.question_ids[p_question_index + 1];
  select * into cfg from section_config where section = q.section;
  cap := coalesce(q.duration_ms, cfg.cap_ms);

  taken_ms := greatest(0, least(cap,
    (extract(epoch from (now() - m.question_started_at)) * 1000)::int));

  correct := (p_selected_index is not null and p_selected_index = q.correct_index);
  grace   := cfg.speed_mult * floor((cap - taken_ms)::numeric / cfg.grace_block_ms)::int;
  pts     := case
    when correct                  then cfg.base_points + grace
    when p_selected_index is null then 0
    else                               -cfg.wrong_penalty
  end;

  insert into match_answers(
    match_id, user_id, question_id, question_index,
    selected_index, is_correct, points_awarded, time_taken_ms
  ) values (
    p_match_id, uid, q.id, p_question_index,
    p_selected_index, correct, pts, taken_ms
  );

  is_a := (uid = m.player_a);
  update matches set
    score_a   = score_a   + case when is_a then pts else 0 end,
    score_b   = score_b   + case when is_a then 0 else pts end,
    correct_a = correct_a + case when is_a and correct then 1 else 0 end,
    correct_b = correct_b + case when (not is_a) and correct then 1 else 0 end,
    time_a_ms = time_a_ms + case when is_a and correct then taken_ms else 0 end,
    time_b_ms = time_b_ms + case when (not is_a) and correct then taken_ms else 0 end
  where id = p_match_id;

  perform maybe_advance(p_match_id, p_question_index);
end;
$$;

-- join_queue: normal usage is one call per queue attempt; 10 calls / 10s
-- covers rapid cancel/rejoin without allowing a spam loop.
create or replace function join_queue()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare my_elo int;
begin
  perform check_rate_limit('join_queue', 10, 10);

  select elo into my_elo from profiles where id = auth.uid();
  insert into matchmaking_queue(user_id, elo)
  values (auth.uid(), my_elo)
  on conflict (user_id) where status='waiting' do nothing;
  perform try_match();
end;
$$;
