-- =========================================================
-- SECURITY HARDENING
-- 1. try_match: remove p_user_id param → derive from auth.uid()
-- 2. forfeit_match: remove p_present_player param → derive from auth.uid(), add auth check
-- 3. REVOKE internal helpers from anon/authenticated (clients must not call them directly)
-- =========================================================

-- Fix try_match: parameterless, uses auth.uid()
create or replace function try_match()
returns uuid language plpgsql security definer as $$
declare
  me           matchmaking_queue%rowtype;
  opp          matchmaking_queue%rowtype;
  band         integer;
  new_match_id uuid;
  q_ids        uuid[];
begin
  select * into me
  from matchmaking_queue
  where user_id = auth.uid() and status = 'waiting'
  for update skip locked;

  if not found then return null; end if;

  band := least(1000, 100 + extract(epoch from (now() - me.enqueued_at))::int * 20);

  select * into opp
  from matchmaking_queue
  where status = 'waiting'
    and user_id <> me.user_id
    and abs(elo - me.elo) <= band
  order by abs(elo - me.elo), enqueued_at
  limit 1
  for update skip locked;

  if not found then return null; end if;

  select array_agg(id) into q_ids from (
    (select id from questions where section='VARC'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='DILR'  and is_active order by random() limit 3)
    union all
    (select id from questions where section='QUANT' and is_active order by random() limit 3)
  ) s;

  insert into matches (player_a, player_b, status, is_rated, question_ids,
                       elo_a_before, elo_b_before)
  values (me.user_id, opp.user_id, 'pending', true, q_ids,
          me.elo, opp.elo)
  returning id into new_match_id;

  update matchmaking_queue
    set status='matched', match_id=new_match_id
    where id in (me.id, opp.id);

  return new_match_id;
end;
$$;

-- Update join_queue to call parameterless try_match()
create or replace function join_queue()
returns void language plpgsql security definer as $$
declare my_elo int;
begin
  select elo into my_elo from profiles where id = auth.uid();
  insert into matchmaking_queue(user_id, elo)
  values (auth.uid(), my_elo)
  on conflict (user_id) where status='waiting' do nothing;
  perform try_match();
end;
$$;

-- Fix forfeit_match: derive present player from auth.uid(), verify caller is a participant
create or replace function forfeit_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m               matches%rowtype;
  present_player  uuid := auth.uid();
  quitter         uuid;
  r_win           int;
  r_lose          int;
  e_win           numeric;
  k               int;
  d_win           int;
  win_games       int;
begin
  select * into m from matches where id = p_match_id for update;
  if m.status <> 'active' then return; end if;

  if present_player not in (m.player_a, m.player_b) then
    raise exception 'forbidden';
  end if;

  if present_player = m.player_a then
    quitter := m.player_b; r_win := m.elo_a_before; r_lose := m.elo_b_before;
  else
    quitter := m.player_a; r_win := m.elo_b_before; r_lose := m.elo_a_before;
  end if;

  if not m.is_rated then
    update matches set status='abandoned', ended_at=now(), winner_id=present_player
    where id = p_match_id;
    return;
  end if;

  select matches_played into win_games from profiles where id = present_player;
  k     := case when win_games < 30 then 40 when r_win < 2000 then 24 else 16 end;
  e_win := 1.0 / (1.0 + power(10, (r_lose - r_win)::numeric / 400.0));
  d_win := greatest(1, round(k * (1.0 - e_win) * 1.0))::int;

  perform apply_rated_result(p_match_id, present_player, quitter, d_win);
  update matches set status='abandoned' where id = p_match_id;
end;
$$;

-- Drop old try_match(uuid) overload so clients cannot call it
drop function if exists try_match(uuid);

-- REVOKE internal helpers from all client roles
-- pg_cron runs as postgres superuser — unaffected by these revokes
revoke execute on function maybe_advance(uuid, smallint)             from public, anon, authenticated;
revoke execute on function finalize_match(uuid)                      from public, anon, authenticated;
revoke execute on function apply_draw(uuid)                          from public, anon, authenticated;
revoke execute on function apply_rated_result(uuid, uuid, uuid, int) from public, anon, authenticated;
revoke execute on function advance_timed_out()                       from public, anon, authenticated;
