-- Fix: 20260702000600_spectate_mode.sql re-created advance_timed_out from a
-- stale base to add the spectator broadcast, silently reverting two earlier
-- fixes:
--   - 20260623070438: abandon 'pending' matches stuck > 5 min
--   - 20260623063244: insert null (skipped) answer rows on timeout
-- Restore both; keep the broadcast_spectator_update call.
create or replace function advance_timed_out()
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r   record;
  cap integer;
  pid uuid;
begin
  -- Abandon stale pending matches (nobody loaded the match page in 5 min)
  update matches
  set status = 'abandoned', ended_at = now()
  where status = 'pending'
    and created_at < now() - interval '5 minutes';

  for r in
    select m.*, q.section, q.id as q_id, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      -- Record null answers for players who never answered this question,
      -- so completed matches keep one match_answers row per player per question.
      foreach pid in array array[r.player_a, r.player_b] loop
        insert into match_answers (
          match_id, user_id, question_id, question_index,
          selected_index, is_correct, points_awarded, time_taken_ms
        )
        values (r.id, pid, r.q_id, r.current_index, null, false, 0, cap)
        on conflict (match_id, user_id, question_index) do nothing;
      end loop;

      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id;
      end if;

      perform broadcast_spectator_update(r.id);
    end if;
  end loop;
end;
$$;

revoke execute on function advance_timed_out() from public, anon, authenticated;
