-- ─────────────────────────────────────────────────────────
-- Ninja learns from every match, without an LLM call per match.
--
-- The signal already exists: match_answers × questions × rating_history. What
-- was missing was a rollup Ninja could read. get_learner_profile is that — one
-- stable read over the caller's last N RATED matches, returning aggregates only.
--
-- Aggregates ONLY, and that is a cost rule, not a style preference. runCoach
-- replays every tool result at each of stepCountIs(6) steps, so this payload is
-- billed 6x per turn on the priciest route in the app. The return is bounded by
-- construction — 3 sections × 2 qtypes × 3 ELO bands + one trend object — so it
-- costs the same for a 5-match player and a 5000-match one. Never add a rows
-- array here; that is the trap trimCurve exists to undo (see lib/ai/model.ts).
--
-- Three notions this gets right, each of which reads as a bug if inverted:
--
--   * TIMEOUTS ARE NOT SKIPS. advance_timed_out inserts null skip-rows with
--     time_taken_ms = NULL — the cron marker; a client submission always
--     records a time. Counting those as skips reports "you keep choosing to
--     skip" at a player who ran out of clock, which is the opposite advice.
--     They are excluded from every rate and surfaced as their own count.
--
--   * PER-QTYPE ACCURACY IS REAL SIGNAL. TITA has no guess floor (an MCQ blind
--     guess lands 1/n_opts of the time), so identical content yields a lower
--     p(correct). A TITA gap is not noise — see CLAUDE.md, Question ELO.
--
--   * ELO BAND ≠ SECTION. "Loses on hard Quant" and "loses on easy Quant" are
--     different diagnoses with different plans; only the band split separates
--     them. Bands are on questions.elo, the bank's own learned difficulty.
--
-- Trend, not snapshot: current profiles.elo against the mean and slope of the
-- caller's last N rating points. Season-reset rows (match_id is null) are
-- excluded — CLAUDE.md's end_current_season halves the distance to 1000, an
-- artificial step that would read as a collapse in skill.
--
-- Also: study plans get their own home. ninja_study_plans is a cost cache in
-- the ninja_debriefs/ninja_daily_focus mould — a repeat read returns the stored
-- row and never re-bills a $0.007–0.043 coach-class call. Regenerate is bounded
-- to one rewrite per week IN THE RPC, because a limit the route alone enforces
-- is a limit one missing `if` removes.
-- ─────────────────────────────────────────────────────────

-- ── the learner profile: what Ninja knows about you, no LLM involved ──
create or replace function get_learner_profile(p_limit int default 50)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public as $$
  with uid as (select (select auth.uid()) as id),
  -- Rated only: unrated matches don't move ELO, so mixing them in would
  -- decouple the accuracy story from the trend story it's meant to explain.
  recent as (
    select m.id, m.question_ids
    from matches m, uid
    where m.is_rated
      and m.status in ('completed', 'abandoned')
      and (m.player_a = uid.id or m.player_b = uid.id)
    order by m.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ),
  ans as (
    select
      q.section::text as section,
      q.qtype,
      q.elo as q_elo,
      a.is_correct,
      a.time_taken_ms,
      -- question_cap_ms is the single cap source (CLAUDE.md, Scoring): it adds
      -- the passage reading window on the first question of a group. An inline
      -- coalesce(duration_ms, cap_ms) here would under-report the cap and make
      -- every VARC/DILR opener look slow.
      question_cap_ms(r.question_ids, a.question_index) as cap_ms,
      (a.selected_index is null and a.answer_text is null) as no_answer,
      (a.time_taken_ms is null) as timed_out
    from recent r
    join match_answers a
      on a.match_id = r.id and a.user_id = (select uid.id from uid)
    join questions q
      on q.id = r.question_ids[a.question_index + 1]
  ),
  -- Everything the player actually faced with a real submission. The cron's
  -- timeout rows are held out here once, so no rate below can double-count them.
  graded as (select * from ans where not timed_out),
  by_section as (
    select jsonb_object_agg(s.section, jsonb_build_object(
      'answered',     s.n,
      'accuracy',     round(s.correct::numeric / nullif(s.n, 0), 3),
      'skip_rate',    round(s.skips::numeric / nullif(s.n, 0), 3),
      'timeouts',     s.timeouts,
      'mean_time_ms', s.mean_time_ms,
      'mean_cap_ms',  s.mean_cap_ms
    )) as j
    from (
      select
        g.section,
        count(*) as n,
        count(*) filter (where g.is_correct) as correct,
        count(*) filter (where g.no_answer)  as skips,
        -- Time on ATTEMPTED questions only: a skip's ~0ms would drag the mean
        -- down and hide the slowness it's usually caused by.
        round(avg(g.time_taken_ms) filter (where not g.no_answer)) as mean_time_ms,
        round(avg(g.cap_ms)) as mean_cap_ms,
        (select count(*) from ans t where t.section = g.section and t.timed_out) as timeouts
      from graded g
      group by g.section
    ) s
  ),
  by_qtype as (
    select jsonb_object_agg(s.qtype, jsonb_build_object(
      'answered', s.n,
      'accuracy', round(s.correct::numeric / nullif(s.n, 0), 3)
    )) as j
    from (
      select g.qtype, count(*) as n, count(*) filter (where g.is_correct) as correct
      from graded g group by g.qtype
    ) s
  ),
  by_band as (
    select jsonb_object_agg(s.band, jsonb_build_object(
      'answered', s.n,
      'accuracy', round(s.correct::numeric / nullif(s.n, 0), 3)
    )) as j
    from (
      select
        case when g.q_elo < 1200 then 'lt_1200'
             when g.q_elo < 1400 then '1200_1400'
             else 'gte_1400' end as band,
        count(*) as n,
        count(*) filter (where g.is_correct) as correct
      from graded g group by 1
    ) s
  ),
  -- Season resets excluded: a null match_id row is end_current_season halving
  -- the distance to 1000, not a loss. Leaving it in inverts the slope.
  hist as (
    select rh.elo_after, row_number() over (order by rh.created_at desc) as rn
    from rating_history rh, uid
    where rh.user_id = uid.id and rh.match_id is not null
    order by rh.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ),
  trend as (
    -- regr_slope(y, x) with x = -rn: rn=1 is the NEWEST point, so negating it
    -- makes x increase with recency and the slope read forward in time. Using
    -- rn directly would report a rising player as sliding.
    select count(*) as n,
           round(avg(elo_after)) as mean_elo,
           round(regr_slope(elo_after, -rn)::numeric, 2) as slope_per_match
    from hist
  )
  select jsonb_build_object(
    'matches_analyzed',   (select count(*) from recent),
    'questions_answered', (select count(*) from graded),
    'timeouts',           (select count(*) from ans where timed_out),
    'by_section',    coalesce((select j from by_section), '{}'::jsonb),
    'by_qtype',      coalesce((select j from by_qtype),   '{}'::jsonb),
    'by_question_elo_band', coalesce((select j from by_band), '{}'::jsonb),
    'elo_trend', jsonb_build_object(
      'current_elo',     (select p.elo from profiles p, uid where p.id = uid.id),
      'window_mean_elo', (select mean_elo from trend),
      'deviation',       (select p.elo from profiles p, uid where p.id = uid.id)
                           - (select mean_elo from trend),
      'slope_per_match', (select slope_per_match from trend),
      'points',          (select n from trend)
    ),
    'notes', 'Rates exclude cron timeout rows (time_taken_ms is null): those are '
             || 'the clock running out, not a decision to skip. TITA has no guess '
             || 'floor, so a TITA-vs-MCQ accuracy gap is real, not noise.'
  );
$$;

-- ── study plans: one per user per week, cached like the debrief ──
create table if not exists ninja_study_plans (
  user_id    uuid not null references auth.users(id) on delete cascade,
  week_start date not null default (date_trunc('week', now())::date),
  plan       jsonb not null,
  model_id   text not null,
  regens     int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

-- RLS on, zero policies: definer-only, matching ninja_debriefs/ninja_daily_focus.
alter table ninja_study_plans enable row level security;

-- Always returns exactly one row, plan null when nothing is cached yet. That
-- way the route learns the server's notion of "this week" without the client
-- ever computing a date in its own timezone.
create or replace function get_ninja_study_plan(p_week_start date default null)
returns table(week_start date, plan jsonb, regens int, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select w.ws, s.plan, coalesce(s.regens, 0), s.created_at
  from (select coalesce(p_week_start, date_trunc('week', now())::date) as ws) w
  left join ninja_study_plans s
    on s.user_id = (select auth.uid()) and s.week_start = w.ws;
$$;

create or replace function save_ninja_study_plan(
  p_plan jsonb, p_model text, p_week_start date default null, p_replace boolean default false
) returns void
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  uid uuid := (select auth.uid());
  ws  date := coalesce(p_week_start, date_trunc('week', now())::date);
begin
  if uid is null then raise exception 'forbidden'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then raise exception 'empty plan'; end if;

  if p_replace then
    -- Bounded regenerate: one rewrite per week, enforced HERE. The route checks
    -- regens before spending (so an over-budget user is never billed), but the
    -- route's check is an optimization — this is the limit.
    update ninja_study_plans
       set plan = p_plan, model_id = left(p_model, 200), regens = regens + 1, created_at = now()
     where user_id = uid and week_start = ws and regens < 1;
    if not found then raise exception 'regenerate limit reached'; end if;
  else
    -- First-write-wins: a race or a hammered page returns the stored plan and
    -- never re-bills. Same contract as save_ninja_debrief.
    insert into ninja_study_plans (user_id, week_start, plan, model_id)
    values (uid, ws, p_plan, left(p_model, 200))
    on conflict (user_id, week_start) do nothing;
  end if;
end; $$;

revoke execute on function get_learner_profile(int)                              from public, anon;
revoke execute on function get_ninja_study_plan(date)                            from public, anon;
revoke execute on function save_ninja_study_plan(jsonb, text, date, boolean)     from public, anon;

grant execute on function get_learner_profile(int)                               to authenticated, service_role;
grant execute on function get_ninja_study_plan(date)                             to authenticated, service_role;
grant execute on function save_ninja_study_plan(jsonb, text, date, boolean)      to authenticated, service_role;
