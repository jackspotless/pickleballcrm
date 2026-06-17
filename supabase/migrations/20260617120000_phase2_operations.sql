-- supabase/migrations/20260617120000_phase2_operations.sql
-- Phase 2 (foundation): rule_set, rounds-aware match_line, role-based write
-- policies + FK-chain isolation helpers, flag RPC, player-league hardening.

-- ============================================================
-- 1. rule_set (§6) + season attach
-- ============================================================
create table rule_set (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid references league(id) on delete cascade, -- null = platform template
  name              text not null,
  scoring_format_id uuid references scoring_format(id),
  structure         jsonb not null,              -- rounds/lines/games + rotation map
  human_rules       jsonb not null default '{}', -- displayed/recorded, NOT validated
  is_template       boolean not null default false
);

alter table season add column rule_set_id uuid references rule_set(id);

-- ============================================================
-- 2. division single-source cleanup (§6 — rule_set.structure is authoritative)
-- ============================================================
alter table division
  drop column lines,
  drop column games_per_line,
  drop column doubles_lines,
  drop column singles_lines;

-- ============================================================
-- 3. match_line → rounds-aware (§1)
-- ============================================================
-- Add nullable (NO default), backfill from line_number, THEN enforce + constrain.
alter table match_line
  add column round_number     int,
  add column home_pair_index  int,
  add column away_pair_index  int;

-- Re-tag the historical flat-9 layout into rounds/pairs (data, not a default).
-- line_number 1..9 was written round-major: L1-3 = round 1, L4-6 = round 2,
-- L7-9 = round 3, home_pair_index cycling 1..3 within each round.
-- Mirrors src/lib/match/rotation.ts -> lineNumberToSlot().
update match_line set
  round_number    = ((line_number - 1) / 3) + 1,
  home_pair_index = ((line_number - 1) % 3) + 1;

-- away_pair_index = rotation[round][home_pair_index]
--   r1: 1->1 2->2 3->3   r2: 1->2 2->3 3->1   r3: 1->3 2->1 3->2
update match_line set away_pair_index = case round_number
  when 1 then home_pair_index
  when 2 then (home_pair_index % 3) + 1
  when 3 then ((home_pair_index + 1) % 3) + 1
end;

alter table match_line
  alter column round_number    set not null,
  alter column home_pair_index set not null,
  alter column away_pair_index set not null;

alter table match_line add constraint match_line_round_pair_unique
  unique (match_id, round_number, home_pair_index);

alter table match_line drop column line_number; -- drops the old (match_id, line_number) unique

-- Forfeit (VI.C) display flag; an 11-0 forfeit already scores correctly.
alter table line_game add column is_forfeit boolean not null default false;

-- ============================================================
-- 4. FK-chain league resolvers (security definer => bypass RLS, no recursion)
-- ============================================================
create or replace function season_league_id(p_season uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select league_id from season where id = p_season;
$$;

create or replace function division_league_id(p_division uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select season_league_id(d.season_id) from division d where d.id = p_division;
$$;

create or replace function team_league_id(p_team uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select division_league_id(t.division_id) from team t where t.id = p_team;
$$;

create or replace function match_league_id(p_match uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select division_league_id(m.division_id) from match m where m.id = p_match;
$$;

create or replace function member_league_id(p_member uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select league_id from member where id = p_member;
$$;

-- ============================================================
-- 5. Authority helpers
-- ============================================================
create or replace function has_perm(p_perm text, p_league uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from member m
    join member_role mr on mr.member_id = m.id
    join role r        on r.id = mr.role_id
    where m.auth_user_id = auth.uid()
      and m.league_id = p_league
      and ( coalesce((r.permissions ->> 'commissioner')::boolean, false)
         or coalesce((r.permissions ->> p_perm)::boolean, false) )
  );
$$;

create or replace function is_commissioner(p_league uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select has_perm('commissioner', p_league);
$$;

create or replace function is_team_captain(p_team uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from team t
    join member m on m.id in (t.captain_member_id, t.cocaptain_member_id)
    where t.id = p_team and m.auth_user_id = auth.uid()
  );
$$;

-- Home captain only (ATPL convention) OR league commissioner.
create or replace function can_write_match(p_match uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select is_commissioner(match_league_id(p_match))
      or is_team_captain((select home_team_id from match where id = p_match));
$$;

revoke all on function
  season_league_id(uuid), division_league_id(uuid), team_league_id(uuid),
  match_league_id(uuid), member_league_id(uuid), has_perm(text,uuid),
  is_commissioner(uuid), is_team_captain(uuid), can_write_match(uuid)
  from public;
grant execute on function
  season_league_id(uuid), division_league_id(uuid), team_league_id(uuid),
  match_league_id(uuid), member_league_id(uuid), has_perm(text,uuid),
  is_commissioner(uuid), is_team_captain(uuid), can_write_match(uuid)
  to authenticated;

-- ============================================================
-- 6. Flag RPC (§5) — captains touch match state only through this
-- ============================================================
create or replace function flag_match(p_match uuid, p_comment text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not ( is_commissioner(match_league_id(p_match))
        or is_team_captain((select home_team_id from match where id = p_match))
        or is_team_captain((select away_team_id from match where id = p_match)) ) then
    raise exception 'not authorized to flag this match';
  end if;
  update match set is_flagged = true, flag_comment = p_comment where id = p_match;
end;
$$;
revoke all on function flag_match(uuid, text) from public;
grant execute on function flag_match(uuid, text) to authenticated;

-- ============================================================
-- 7. FK-VALUE league hardening (triggers reuse the resolvers from §4).
--    RLS (§9) answers "can this caller write this row"; these triggers answer
--    "do the member IDs inside the row belong to the right league." They fire
--    for ALL writers (incl. service role), so cross-league FK values can't be
--    stitched in even by a bug in trusted code.
-- ============================================================

-- match_line: every non-null player must belong to the match's league.
create or replace function match_line_players_same_league() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  lg uuid := match_league_id(new.match_id);
begin
  if (new.home_player1_id is not null and member_league_id(new.home_player1_id) is distinct from lg)
  or (new.home_player2_id is not null and member_league_id(new.home_player2_id) is distinct from lg)
  or (new.away_player1_id is not null and member_league_id(new.away_player1_id) is distinct from lg)
  or (new.away_player2_id is not null and member_league_id(new.away_player2_id) is distinct from lg) then
    raise exception 'match_line player must belong to the match league';
  end if;
  return new;
end;
$$;
create trigger match_line_players_same_league_trg
  before insert or update on match_line
  for each row execute function match_line_players_same_league();

-- roster_entry: the member must belong to the team's league.
create or replace function roster_entry_same_league() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if member_league_id(new.member_id) is distinct from team_league_id(new.team_id) then
    raise exception 'roster_entry member must belong to the team league';
  end if;
  return new;
end;
$$;
create trigger roster_entry_same_league_trg
  before insert or update on roster_entry
  for each row execute function roster_entry_same_league();

-- member_role: the member and the role must belong to the same league.
create or replace function member_role_same_league() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if member_league_id(new.member_id)
     is distinct from (select r.league_id from role r where r.id = new.role_id) then
    raise exception 'member_role member and role must belong to the same league';
  end if;
  return new;
end;
$$;
create trigger member_role_same_league_trg
  before insert or update on member_role
  for each row execute function member_role_same_league();

-- ============================================================
-- 8. rule_set RLS (SELECT like scoring_format)
-- ============================================================
alter table rule_set enable row level security;

create policy rule_set_select on rule_set for select to authenticated
  using (is_template or league_id in (select auth_league_ids()));

-- ============================================================
-- 9. Write policies (resolver in BOTH using and with check)
-- ============================================================
-- Match play: scores & lineup — home captain of the match, or commissioner.
create policy line_game_write on line_game for all to authenticated
  using      (can_write_match((select ml.match_id from match_line ml where ml.id = line_game.match_line_id)))
  with check (can_write_match((select ml.match_id from match_line ml where ml.id = line_game.match_line_id)));

create policy match_line_write on match_line for all to authenticated
  using      (can_write_match(match_line.match_id))
  with check (can_write_match(match_line.match_id));

-- Roster: commissioner, or captain of that team. (Member-league integrity is
-- enforced by roster_entry_same_league_trg, §7.)
create policy roster_entry_write on roster_entry for all to authenticated
  using      ( is_commissioner(team_league_id(roster_entry.team_id))
            or is_team_captain(roster_entry.team_id) )
  with check ( is_commissioner(team_league_id(roster_entry.team_id))
            or is_team_captain(roster_entry.team_id) );

-- Scheduling & league config: commissioner within league only.
create policy match_write on match for all to authenticated
  using      (is_commissioner(division_league_id(match.division_id)))
  with check (is_commissioner(division_league_id(match.division_id)));

create policy team_write on team for all to authenticated
  using      (is_commissioner(division_league_id(team.division_id)))
  with check (is_commissioner(division_league_id(team.division_id)));

create policy division_write on division for all to authenticated
  using      (is_commissioner(season_league_id(division.season_id)))
  with check (is_commissioner(season_league_id(division.season_id)));

create policy season_write on season for all to authenticated
  using      (is_commissioner(season.league_id))
  with check (is_commissioner(season.league_id));

create policy venue_write on venue for all to authenticated
  using      (is_commissioner(venue.league_id))
  with check (is_commissioner(venue.league_id));

create policy league_write on league for all to authenticated
  using      (is_commissioner(league.id))
  with check (is_commissioner(league.id));

create policy member_write on member for all to authenticated
  using      (is_commissioner(member.league_id))
  with check (is_commissioner(member.league_id));

create policy role_write on role for all to authenticated
  using      (is_commissioner(role.league_id))
  with check (is_commissioner(role.league_id));

-- (member/role same-league integrity is enforced by member_role_same_league_trg, §7.)
create policy member_role_write on member_role for all to authenticated
  using      (is_commissioner(member_league_id(member_role.member_id)))
  with check (is_commissioner(member_league_id(member_role.member_id)));

-- league-scoped rows only (null-league templates stay service-role-only).
create policy scoring_format_write on scoring_format for all to authenticated
  using      (scoring_format.league_id is not null and is_commissioner(scoring_format.league_id))
  with check (scoring_format.league_id is not null and is_commissioner(scoring_format.league_id));

create policy rule_set_write on rule_set for all to authenticated
  using      (rule_set.league_id is not null and is_commissioner(rule_set.league_id))
  with check (rule_set.league_id is not null and is_commissioner(rule_set.league_id));
