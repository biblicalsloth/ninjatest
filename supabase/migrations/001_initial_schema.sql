-- =========================================================
-- NINJATEST: Full Initial Schema Migration
-- =========================================================

-- =========================================================
-- ENUMS
-- =========================================================
create type cat_section as enum ('VARC', 'DILR', 'QUANT');
create type match_status as enum ('pending', 'active', 'completed', 'abandoned');
create type queue_status as enum ('waiting', 'matched', 'cancelled');

-- =========================================================
-- PROFILES  (extends auth.users)
-- =========================================================
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text unique not null,
  display_name    text,
  avatar_url      text,
  elo             integer not null default 1000,
  peak_elo        integer not null default 1000,
  matches_played  integer not null default 0,
  wins            integer not null default 0,
  losses          integer not null default 0,
  draws           integer not null default 0,
  created_at      timestamptz not null default now()
);

create index profiles_elo_idx on profiles (elo desc);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- =========================================================
-- QUESTIONS
-- =========================================================
create table questions (
  id            uuid primary key default gen_random_uuid(),
  section       cat_section not null,
  difficulty    smallint not null default 3,
  body          text not null,
  options       jsonb not null,
  correct_index smallint not null,
  explanation   text,
  duration_ms   integer,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index questions_section_idx on questions (section) where is_active;

-- =========================================================
-- SECTION SCORING CONFIG
-- =========================================================
create table section_config (
  section        cat_section primary key,
  cap_ms         integer  not null,
  base_points    integer  not null default 100,
  speed_mult     smallint not null,
  grace_block_ms integer  not null default 5000,
  wrong_penalty  integer  not null default 30
);

insert into section_config (section, cap_ms, base_points, speed_mult, wrong_penalty) values
  ('VARC',   90000, 100, 1, 30),
  ('QUANT', 105000, 100, 2, 30),
  ('DILR',  120000, 100, 2, 30);

-- =========================================================
-- MATCHES
-- =========================================================
create table matches (
  id                  uuid primary key default gen_random_uuid(),
  player_a            uuid not null references profiles(id),
  player_b            uuid not null references profiles(id),
  status              match_status not null default 'pending',
  is_rated            boolean not null default true,
  question_ids        uuid[] not null,
  current_index       smallint not null default 0,
  question_started_at timestamptz,
  score_a             integer not null default 0,
  score_b             integer not null default 0,
  correct_a           smallint not null default 0,
  correct_b           smallint not null default 0,
  time_a_ms           integer not null default 0,
  time_b_ms           integer not null default 0,
  winner_id           uuid references profiles(id),
  elo_a_before        integer,
  elo_b_before        integer,
  elo_a_after         integer,
  elo_b_after         integer,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  ended_at            timestamptz,
  constraint distinct_players check (player_a <> player_b)
);

create index matches_status_idx on matches (status);
create index matches_players_idx on matches (player_a, player_b);

-- =========================================================
-- MATCH ANSWERS
-- =========================================================
create table match_answers (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references matches(id) on delete cascade,
  user_id        uuid not null references profiles(id),
  question_id    uuid not null references questions(id),
  question_index smallint not null,
  selected_index smallint,
  is_correct     boolean not null default false,
  points_awarded integer not null default 0,
  time_taken_ms  integer,
  answered_at    timestamptz not null default now(),
  unique (match_id, user_id, question_index)
);

-- =========================================================
-- RATING HISTORY
-- =========================================================
create table rating_history (
  id          bigserial primary key,
  user_id     uuid not null references profiles(id),
  match_id    uuid references matches(id) on delete set null,
  elo_before  integer not null,
  elo_after   integer not null,
  delta       integer not null,
  created_at  timestamptz not null default now()
);

create index rating_history_user_idx on rating_history (user_id, created_at);

-- =========================================================
-- MATCHMAKING QUEUE
-- =========================================================
create table matchmaking_queue (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id),
  elo         integer not null,
  status      queue_status not null default 'waiting',
  match_id    uuid references matches(id),
  enqueued_at timestamptz not null default now()
);

create unique index queue_user_waiting_idx on matchmaking_queue (user_id)
  where status = 'waiting';

create index queue_waiting_idx on matchmaking_queue (status, elo, enqueued_at)
  where status = 'waiting';

-- =========================================================
-- FRIEND CHALLENGES
-- =========================================================
create table challenges (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  host_id     uuid not null references profiles(id),
  guest_id    uuid references profiles(id),
  is_rated    boolean not null default true,
  match_id    uuid references matches(id),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  created_at  timestamptz not null default now()
);

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
alter table profiles          enable row level security;
alter table matches           enable row level security;
alter table match_answers     enable row level security;
alter table matchmaking_queue enable row level security;
alter table challenges        enable row level security;
alter table questions         enable row level security;
alter table section_config    enable row level security;
alter table rating_history    enable row level security;

-- profiles: world-readable; self-update (elo/stats written by server fns only)
create policy profiles_read   on profiles for select using (true);
create policy profiles_insert on profiles for insert with check (id = auth.uid());
create policy profiles_update on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- matches: visible only to participants
create policy matches_read on matches for select
  using (auth.uid() in (player_a, player_b));

-- answers: visible only to participants
create policy answers_read on match_answers for select
  using (exists (select 1 from matches m
                 where m.id = match_id and auth.uid() in (m.player_a, m.player_b)));

-- queue / challenges: own rows only
create policy queue_self on matchmaking_queue for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy challenge_host_read on challenges for select
  using (auth.uid() in (host_id, coalesce(guest_id, auth.uid())));
create policy challenge_host_insert on challenges for insert
  with check (auth.uid() = host_id);

-- questions: no direct client read (served via get_match_question RPC)
create policy questions_none on questions for select using (false);

-- section_config: public read-only
create policy config_read on section_config for select using (true);

-- rating history: own records only
create policy rating_self_read on rating_history for select using (user_id = auth.uid());
