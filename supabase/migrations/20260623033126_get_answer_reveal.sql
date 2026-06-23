-- Returns correct_index + explanation + points after a question closes.
-- Allowed only when: question is past (current_index > p_index) or match is over.
create or replace function get_answer_reveal(p_match_id uuid, p_index smallint)
returns table (
  correct_index  smallint,
  explanation    text,
  points_awarded integer,
  is_correct     boolean
)
language plpgsql stable security definer as $$
declare
  m matches%rowtype;
  q questions%rowtype;
begin
  select * into m from matches where id = p_match_id;

  if auth.uid() not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  -- Only reveal once the question has closed
  if m.status = 'active' and m.current_index <= p_index then
    raise exception 'question still active';
  end if;

  select * into q from questions where id = m.question_ids[p_index + 1];

  return query
    select
      q.correct_index,
      q.explanation,
      coalesce(a.points_awarded, 0)::integer,
      coalesce(a.is_correct, false)
    from (select 1) _dummy
    left join match_answers a
      on a.match_id = p_match_id
     and a.user_id  = auth.uid()
     and a.question_index = p_index;
end;
$$;
