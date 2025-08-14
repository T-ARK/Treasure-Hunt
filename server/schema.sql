-- Admins
create table if not exists admins (
  id serial primary key,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz default now()
);

-- Teams
create table if not exists teams (
  id text primary key,
  name text not null,
  started_at timestamptz,
  finished_at timestamptz,
  current_index int not null default 0,
  created_at timestamptz default now()
);

-- Locations
create table if not exists locations (
  id text primary key,
  title text not null,
  block text not null,
  type  text not null
);

-- Tasks (server-only PINs)
create table if not exists tasks (
  id serial primary key,
  location_id text not null references locations(id) on delete cascade,
  name text not null,
  instructions text not null,
  proof text not null,
  pin text not null,
  unique (location_id, name)
);

-- Team routes
create table if not exists team_routes (
  team_id text not null references teams(id) on delete cascade,
  position int not null,
  location_id text not null references locations(id),
  primary key (team_id, position)
);

-- Progress
create table if not exists progress (
  id serial primary key,
  team_id text not null references teams(id) on delete cascade,
  position int not null,
  location_id text not null references locations(id),
  pin_last4 text not null,
  created_at timestamptz default now()
);

create index if not exists idx_progress_team_time on progress(team_id, created_at desc);
