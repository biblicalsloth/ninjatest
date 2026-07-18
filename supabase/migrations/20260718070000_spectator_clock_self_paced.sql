-- ─────────────────────────────────────────────────────────────────────────────
-- get_match_question_spectator: self-paced clock.
--
-- Same omission class as 20260718060000: the self-paced migration
-- (20260718010000) stopped updating matches.question_started_at for
-- human-vs-human matches (each player runs on q_started_a/q_started_b), but
-- this function still returned it. A spectator therefore saw the match-start
-- timestamp for every question after the first — a countdown that always read
-- expired. Scoring was never affected (spectators are read-only).
--
-- Fix: current_index = least(idx_a, idx_b) is the LAGGING player's question,
-- so serve that player's own clock. On a tie (both players on this index)
-- serve the later of the two starts — the countdown a viewer can still watch
-- run. Bot matches keep the shared question_started_at, which their path still
-- maintains.
--
-- Body otherwise identical to 20260716130000. Same signature → create or
-- replace, grants retained (authenticated + service_role; anon revoked).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function get_match_question_spectator(p_match_id uuid, p_index smallint)
returns table (
  question_id       uuid,
  section           cat_section,
  body              text,
  options           jsonb,
  qtype             text,
  cap_ms            integer,
  started_at        timestamptz,
  passage           text,
  image_url         text,
  passage_image_url text
)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  m         matches%rowtype;
  q         questions%rowtype;
  v_passage text;
  v_pimage  text;
  v_bot     boolean;
  v_cnt_a   int;
  v_cnt_b   int;
  v_started timestamptz;
begin
  select * into m from matches where id = p_match_id;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if auth.uid() in (m.player_a, m.player_b) then
    raise exception 'participants must use get_match_question';
  end if;
  if p_index <> m.current_index then raise exception 'not current question'; end if;

  v_bot := exists (select 1 from profiles p where p.id in (m.player_a, m.player_b) and p.is_bot);

  if v_bot then
    v_started := m.question_started_at;
  else
    select count(*) into v_cnt_a from match_answers where match_id = p_match_id and user_id = m.player_a;
    select count(*) into v_cnt_b from match_answers where match_id = p_match_id and user_id = m.player_b;
    v_started := coalesce(
      case
        when v_cnt_a < v_cnt_b then m.q_started_a
        when v_cnt_b < v_cnt_a then m.q_started_b
        else greatest(m.q_started_a, m.q_started_b)
      end,
      m.question_started_at);
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  if q.passage_id is not null then
    select p.body, p.image_url into v_passage, v_pimage from passages p where p.id = q.passage_id;
  end if;

  return query select
    q.id, q.section, q.body,
    case when q.qtype = 'tita' then '[]'::jsonb else q.options end,
    q.qtype,
    question_cap_ms(m.question_ids, p_index::int),
    v_started,
    v_passage,
    q.image_url,
    v_pimage;
end;
$$;
