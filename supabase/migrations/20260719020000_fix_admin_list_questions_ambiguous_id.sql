-- admin_list_questions has thrown 42702 ("column reference \"id\" is ambiguous")
-- on EVERY call since 20260716212156: its is_admin guard reads
--   where id = (select auth.uid())
-- and in plpgsql the RETURNS TABLE column `id` is an in-scope variable, so the
-- unqualified `id` is ambiguous and the function fails before the guard even
-- evaluates. The admin console's question bank rendered empty ("No questions
-- match the filter", every section STARVED) the whole time. Qualify the column.
-- Same signature, so create-or-replace is safe (grants preserved); the rest of
-- the body is unchanged from 20260716212156.

create or replace function admin_list_questions(p_section text default null, p_active boolean default null)
returns table (
  id uuid, section cat_section, body text, options jsonb, correct_index smallint,
  difficulty smallint, explanation text, is_active boolean, passage_id uuid,
  passage_body text, passage_is_active boolean, created_at timestamptz,
  qtype text, answer_value text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not coalesce((select profiles.is_admin from profiles where profiles.id = (select auth.uid())), false) then
    raise exception 'not authorized';
  end if;

  return query
    select q.id, q.section, q.body, q.options, q.correct_index, q.difficulty,
           q.explanation, q.is_active, q.passage_id, p.body, p.is_active, q.created_at,
           q.qtype, q.answer_value
    from questions q
    left join passages p on p.id = q.passage_id
    where (p_section is null or q.section = p_section::cat_section)
      and (p_active  is null or q.is_active = p_active)
    order by q.section, q.passage_id nulls last, q.created_at;
end; $$;
