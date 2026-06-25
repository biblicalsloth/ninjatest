create table if not exists waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  created_at timestamptz not null default now()
);

alter table waitlist enable row level security;

-- Anyone can add their email; nobody can read via client
create policy "waitlist_insert" on waitlist
  for insert with check (true);