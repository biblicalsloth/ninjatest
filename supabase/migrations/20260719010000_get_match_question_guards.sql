-- ─────────────────────────────────────────────────────────────────────────────
-- get_match_question: found + status guards (2026-07-19 live-matchmaking debug).
--
-- The self-paced def (20260718010000) had no status check and no `if not found`
-- guard. Two consequences, both observed adjacent to the live 2-player failure:
--   • An abandoned/completed match still served questions — a player whose
--     realtime channel missed the terminal UPDATE kept "playing" a dead match;
--     every submit_answer then raised 'match not active' with no way for the
--     client to distinguish "retry" from "route to result".
--   • A bogus match id made `auth.uid() not in (null, null)` evaluate NULL (not
--     true), skipping the forbidden raise and failing later with a garbage
--     error from the null question row.
-- Raising 'match not active' here lets the client's rehydrate path (which
-- checks status) route to the result screen instead of retrying forever.
--
-- Body otherwise identical to 20260718010000 (its latest definition, per
-- migration discipline #1). Same signature → create or replace, grants kept.
-- Never reached while 'pending': every client path awaits start_match (or
-- gates on status) before fetching, and the stress harness inserts 'active'.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function get_match_question(p_match_id uuid, p_index smallint)
returns table(question_id uuid, section cat_section, body text, options jsonb,
              qtype text, cap_ms integer, started_at timestamptz,
              passage text, image_url text, passage_image_url text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  perm      integer[];
  shuffled  jsonb;
  v_passage text;
  v_pimage  text;
  v_bot     boolean;
  v_myidx   int;
  v_started timestamptz;
begin
  select * into m from matches where id = p_match_id;
  if not found then raise exception 'forbidden'; end if;
  if auth.uid() not in (m.player_a, m.player_b) then raise exception 'forbidden'; end if;
  if m.status <> 'active' then raise exception 'match not active'; end if;

  v_bot := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  if v_bot then
    -- shared path (bot match): the single current_index + shared clock
    if p_index <> m.current_index then raise exception 'not current question'; end if;
    v_started := m.question_started_at;
  else
    -- self-paced: the caller's own progress = their answer count, own clock
    select count(*) into v_myidx from match_answers
    where match_id = p_match_id and user_id = auth.uid();
    if p_index <> v_myidx then raise exception 'not current question'; end if;
    -- q_started_* is always set by start_match/submit_answer in production; the
    -- coalesce is a fallback for direct-inserted test matches.
    v_started := coalesce(case when auth.uid() = m.player_a then m.q_started_a else m.q_started_b end,
                          m.question_started_at);
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.qtype = 'tita' then
    shuffled := '[]'::jsonb;
  else
    perm := option_perm(p_match_id, auth.uid(), p_index, jsonb_array_length(q.options));
    select jsonb_agg(q.options -> p order by ord) into shuffled
    from unnest(perm) with ordinality as u(p, ord);
  end if;

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id, q.section, q.body, shuffled, q.qtype,
    question_cap_ms(m.question_ids, p_index::int),
    v_started,
    v_passage, q.image_url, v_pimage;
end;
$$;
