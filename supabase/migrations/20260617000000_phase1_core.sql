-- supabase/migrations/20260617000000_phase1_core.sql
-- Phase 1: core schema, enums, FKs, RLS + policies, tenancy helpers.

-- ============================================================
-- 1. ENUMS
-- ============================================================
create type roster_position as enum
  ('player','substitute','sub_up','sub_down','frozen','flagged','junior');
create type match_type as enum
  ('match','bye','rain_date','tba','playoff_placeholder','holiday_break','snow_date');
create type match_status as enum ('scheduled','in_progress','final');
create type line_winner as enum ('home','away','unset');
create type season_status as enum ('setup','active','playoffs','complete');

-- ============================================================
-- 2. TABLES  (verbatim from the data-model doc)
-- ============================================================
create table league (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  subdomain     text unique not null,
  theme         text not null default 'classic',
  logo_url      text,
  primary_color text,
  secondary_color text,
  payments_live boolean not null default false,
  created_at    timestamptz not null default now()
);

create table season (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references league(id) on delete cascade,
  name       text not null,
  starts_on  date,
  ends_on    date,
  status     season_status not null default 'setup',
  created_at timestamptz not null default now()
);

create table venue (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references league(id) on delete cascade,
  name         text not null,
  abbreviation text,
  address      text, city text, state text, zip text,
  hard_courts  int default 0,
  indoor_courts int default 0
);

create table scoring_format (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid references league(id) on delete cascade,
  name        text not null,
  config      jsonb not null,
  is_template boolean not null default false
);

create table division (
  id                  uuid primary key default gen_random_uuid(),
  season_id           uuid not null references season(id) on delete cascade,
  name                text not null,
  scoring_format_id   uuid references scoring_format(id),
  lines               int not null default 9,
  games_per_line      int not null default 2,
  doubles_lines       int not null default 9,
  singles_lines       int not null default 0,
  subdivisions_enabled boolean not null default false,
  display_order       int default 0,
  hidden              boolean not null default false
);

create table member (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references league(id) on delete cascade,
  auth_user_id    uuid references auth.users(id),
  first_name      text not null,
  last_name       text not null,
  email           text,
  phone           text,
  address text, city text, state text, zip text,
  birthday        date,
  gender          text,
  rating          numeric(4,2),
  rating_type     text,
  dupr_id         text,
  primary_venue_id uuid references venue(id),
  photo_url       text,
  notes           text,
  created_at      timestamptz not null default now()
);

create table role (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references league(id) on delete cascade,
  name        text not null,
  permissions jsonb not null default '{}'
);

create table member_role (
  member_id uuid not null references member(id) on delete cascade,
  role_id   uuid not null references role(id) on delete cascade,
  primary key (member_id, role_id)
);

create table team (
  id                 uuid primary key default gen_random_uuid(),
  division_id        uuid not null references division(id) on delete cascade,
  name               text not null,
  abbreviation       text,
  logo_url           text,
  home_venue_id      uuid references venue(id),
  captain_member_id  uuid references member(id),
  cocaptain_member_id uuid references member(id),
  registration_code  text,
  subdivision        int default 0,
  default_score      int default 0
);

create table roster_entry (
  id        uuid primary key default gen_random_uuid(),
  team_id   uuid not null references team(id) on delete cascade,
  member_id uuid not null references member(id) on delete cascade,
  position  roster_position not null default 'player',
  created_at timestamptz not null default now(),
  unique (team_id, member_id)
);

create table match (
  id            uuid primary key default gen_random_uuid(),
  division_id   uuid not null references division(id) on delete cascade,
  home_team_id  uuid references team(id),
  away_team_id  uuid references team(id),
  venue_id      uuid references venue(id),
  scheduled_at  timestamptz,
  week_number   int,
  match_type    match_type not null default 'match',
  rain_date     timestamptz,
  is_playoff    boolean not null default false,
  is_flagged    boolean not null default false,
  flag_comment  text,
  status        match_status not null default 'scheduled',
  created_at    timestamptz not null default now()
);

create table match_line (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references match(id) on delete cascade,
  line_number      int not null,
  home_player1_id  uuid references member(id),
  home_player2_id  uuid references member(id),
  away_player1_id  uuid references member(id),
  away_player2_id  uuid references member(id),
  winner           line_winner not null default 'unset',
  unique (match_id, line_number)
);

create table line_game (
  id            uuid primary key default gen_random_uuid(),
  match_line_id uuid not null references match_line(id) on delete cascade,
  game_number   int not null,
  home_score    int,
  away_score    int,
  unique (match_line_id, game_number)
);

-- ============================================================
-- 3. TENANCY HELPERS
-- ============================================================
-- current_member(): resolve auth.uid() -> the caller's member row.
create or replace function public.current_member()
returns public.member
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.* from public.member m
  where m.auth_user_id = auth.uid()
  limit 1;
$$;

-- auth_league_ids(): every league the caller is a member of.
-- security definer => avoids recursive RLS when used inside member policies.
create or replace function public.auth_league_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.league_id from public.member m
  where m.auth_user_id = auth.uid();
$$;

revoke all on function public.current_member()  from public;
revoke all on function public.auth_league_ids() from public;
grant execute on function public.current_member()  to authenticated;
grant execute on function public.auth_league_ids() to authenticated;

-- ============================================================
-- 4. PUBLIC VIEWS
-- ============================================================
-- Non-security_invoker views bypass the underlying table's RLS, exposing ONLY
-- the selected columns to anon. The full rows stay gated by RLS (section 6).

-- 4a. Member privacy: public sees name + rating only.
create view public.public_member as
  select id, league_id, first_name, last_name, rating, rating_type
  from public.member;

grant select on public.public_member to anon, authenticated;

-- 4b. League branding for the public subdomain site (no internal flags).
create view public.public_league as
  select id, name, subdomain, theme, logo_url, primary_color, secondary_color
  from public.league;

grant select on public.public_league to anon, authenticated;

-- ============================================================
-- 5. ENABLE ROW-LEVEL SECURITY ON EVERY TABLE
-- ============================================================
alter table league         enable row level security;
alter table season         enable row level security;
alter table venue          enable row level security;
alter table scoring_format enable row level security;
alter table division       enable row level security;
alter table member         enable row level security;
alter table role           enable row level security;
alter table member_role    enable row level security;
alter table team           enable row level security;
alter table roster_entry   enable row level security;
alter table match          enable row level security;
alter table match_line     enable row level security;
alter table line_game      enable row level security;

-- ============================================================
-- 6. POLICIES
-- ============================================================
-- NOTE: Phase 1 ships SELECT policies only. With RLS enabled and no write
-- policies, anon/authenticated cannot INSERT/UPDATE/DELETE. The seed runs via
-- the service-role key (BYPASSRLS). Role-based write policies are Phase 2.

-- 6a. Public view-layer: anyone (incl. anon) may SELECT.
create policy division_public_select   on division   for select using (true);
create policy team_public_select       on team       for select using (true);
create policy match_public_select      on match      for select using (true);
create policy match_line_public_select on match_line for select using (true);
create policy line_game_public_select  on line_game  for select using (true);

-- 6b. Member privacy: full row only for a logged-in member of the same league.
create policy member_same_league_select on member
  for select to authenticated
  using (league_id in (select auth_league_ids()));

-- 6c. Tenant isolation (tables with a direct league_id).
create policy league_isolation_select on league
  for select to authenticated
  using (id in (select auth_league_ids()));

create policy season_isolation_select on season
  for select to authenticated
  using (league_id in (select auth_league_ids()));

create policy venue_isolation_select on venue
  for select to authenticated
  using (league_id in (select auth_league_ids()));

create policy scoring_format_isolation_select on scoring_format
  for select to authenticated
  using (is_template or league_id in (select auth_league_ids()));

create policy role_isolation_select on role
  for select to authenticated
  using (league_id in (select auth_league_ids()));

-- 6d. Tenant isolation (join tables — league resolved via member).
create policy member_role_isolation_select on member_role
  for select to authenticated
  using (member_id in (
    select id from member where league_id in (select auth_league_ids())
  ));

create policy roster_entry_isolation_select on roster_entry
  for select to authenticated
  using (member_id in (
    select id from member where league_id in (select auth_league_ids())
  ));
