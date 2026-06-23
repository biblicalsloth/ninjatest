-- Fix advance_timed_out: insert null (skipped) answer rows for any player
-- who did not answer before the question timed out. Without this, maybe_advance
-- would never fire for that question on a future submit, causing a double-advance.
create or replace function advance_timed_out()
returns void language plpgsql security definer as $$
declare
  r     record;
  cap   integer;
  pid   uuid;
begin
  for r in
    select m.*, q.section, q.id as q_id, q.duration_ms as q_duration
    from matches m
    join questions q on q.id = m.question_ids[m.current_index + 1]
    where m.status = 'active'
  loop
    select coalesce(r.q_duration, sc.cap_ms) into cap
    from section_config sc where sc.section = r.section;

    if now() >= r.question_started_at + (cap || ' milliseconds')::interval then
      -- Insert null answers for players who haven't answered this question
      foreach pid in array array[r.player_a, r.player_b] loop
        insert into match_answers (
          match_id, user_id, question_id, question_index,
          selected_index, is_correct, points_awarded, time_taken_ms
        )
        values (
          r.id, pid, r.q_id, r.current_index,
          null, false, 0, cap
        )
        on conflict (match_id, user_id, question_index) do nothing;
      end loop;

      if r.current_index >= 8 then
        perform finalize_match(r.id);
      else
        update matches
        set current_index = r.current_index + 1, question_started_at = now()
        where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;
