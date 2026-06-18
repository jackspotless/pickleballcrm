-- supabase/migrations/20260618180000_score_entry.sql
-- Score entry (PR #5). Captains enter game scores; writes go to line_game,
-- gated by the existing can_write_match RLS policy (either-captain). This
-- migration adds the two boundaries score entry owns, plus a whole-match
-- forfeit RPC — all enforced IN THE DATABASE so the direct line_game write
-- path can't bypass them.

-- ============================================================
-- 1. Scorability boundary helper.
--    A match is scorable iff BOTH lineups are fully submitted: all 8 player
--    columns non-null across every match_line row (and at least one row exists).
--    A half-submitted match (one side still null) is NOT scorable.
-- ============================================================
create or replace function is_match_scorable(p_match uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from match_line where match_id = p_match)
     and not exists (
       select 1 from match_line ml
       where ml.match_id = p_match
         and ( ml.home_player1_id is null or ml.home_player2_id is null
            or ml.away_player1_id is null or ml.away_player2_id is null )
     );
$$;

-- ============================================================
-- 2. line_game AFTER-write trigger: enforces scorability + flips the lock.
--
--    Why AFTER (not BEFORE): PostgreSQL evaluates RLS WITH CHECK *after*
--    BEFORE-row triggers and *before* AFTER-row triggers. Putting this logic in
--    an AFTER trigger guarantees authorization (RLS) is decided FIRST — a
--    cross-league or non-match write is rejected by the line_game_write policy
--    (42501 + row-level security) before this ever runs, so the deny MECHANISM
--    stays RLS, not a P0001 from here. Only an authorized write reaches this.
--
--    security definer: must read match_line across the whole match (bypassing
--    the caller's row visibility) and update match.status (commissioner-only RLS).
-- ============================================================
create or replace function line_game_after_write() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_match  uuid;
  v_status match_status;
begin
  select ml.match_id into v_match from match_line ml where ml.id = new.match_line_id;

  -- Scorability boundary. Forfeits are EXEMPT: a forfeit is the mechanism for an
  -- absent/short side (incl. a whole-match no-show whose opponent never submitted
  -- a lineup), so an 11-0 forfeit must be writable even when not fully scorable.
  if not new.is_forfeit and not is_match_scorable(v_match) then
    raise exception 'match not scorable: both lineups required';
  end if;

  -- Lineup-lock (Option A: automatic, first score). The first DETERMINED result
  -- — both scores set, or a forfeit — moves the match scheduled -> in_progress,
  -- which closes lineup edits (enforced in submit_lineup, §3). Ties the lock to
  -- exactly "scoring has started", the window in which altering a pairing would
  -- corrupt already-entered scores.
  if new.is_forfeit or (new.home_score is not null and new.away_score is not null) then
    select status into v_status from match where id = v_match;
    if v_status = 'scheduled' then
      update match set status = 'in_progress' where id = v_match;
    end if;
  end if;

  return null; -- AFTER trigger: return value is ignored
end;
$$;

create trigger line_game_after_write_trg
  after insert or update on line_game
  for each row execute function line_game_after_write();

-- ============================================================
-- 3. Lineup-lock enforcement: close the captain lineup path once locked.
--    Recreate submit_lineup with a status guard right after the auth check.
--    (Commissioner keeps DIRECT match_line write — match_line_write policy — as
--    the deliberate correction escape hatch; this only closes the captain RPC.)
-- ============================================================
create or replace function submit_lineup(
  p_match uuid,
  p_side  text,
  p_pairs uuid[]
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team     uuid;
  v_rounds   int;
  v_lines    int;
  v_rotation jsonb;
  r  int;
  hp int;
  ap int;
begin
  if p_side not in ('home', 'away') then
    raise exception 'invalid side: %', p_side;
  end if;

  -- --- AUTHORIZATION FIRST: raise before any generation or write. ---
  select case when p_side = 'home' then m.home_team_id else m.away_team_id end
    into v_team
  from match m
  where m.id = p_match;

  if v_team is null then
    raise exception 'match or % team not found', p_side;
  end if;

  if not (is_commissioner(match_league_id(p_match)) or is_team_captain(v_team)) then
    raise exception 'not authorized to submit % lineup for this match', p_side;
  end if;
  -- --- end auth gate ---

  -- LINEUP-LOCK: once scoring has started (status left 'scheduled'), lineup
  -- edits must close — otherwise a pairing could be altered under an already-
  -- scored match and corrupt the scores.
  if (select status from match where id = p_match) <> 'scheduled' then
    raise exception 'lineup locked: scoring has started';
  end if;

  if array_length(p_pairs, 1) is distinct from 6 then
    raise exception 'expected 6 players (3 pairs), got %',
      coalesce(array_length(p_pairs, 1), 0);
  end if;

  select (rs.structure ->> 'rounds')::int,
         (rs.structure ->> 'lines_per_round')::int,
         rs.structure -> 'rotation'
    into v_rounds, v_lines, v_rotation
  from match m
  join division d on d.id = m.division_id
  join season   s on s.id = d.season_id
  join rule_set rs on rs.id = s.rule_set_id
  where m.id = p_match;

  if v_rotation is null then
    raise exception 'no rule_set rotation for this match''s season';
  end if;

  for r in 1..v_rounds loop
    for hp in 1..v_lines loop
      ap := (v_rotation -> (r::text) ->> (hp::text))::int;
      insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
      values (p_match, r, hp, ap)
      on conflict (match_id, round_number, home_pair_index) do nothing;
    end loop;
  end loop;

  if p_side = 'home' then
    update match_line
       set home_player1_id = p_pairs[home_pair_index * 2 - 1],
           home_player2_id = p_pairs[home_pair_index * 2]
     where match_id = p_match;
  else
    update match_line
       set away_player1_id = p_pairs[away_pair_index * 2 - 1],
           away_player2_id = p_pairs[away_pair_index * 2]
     where match_id = p_match;
  end if;
end;
$$;

-- ============================================================
-- 4. forfeit_match(): whole-match no-show convenience — one call records all
--    games 11-0 against the no-show side with is_forfeit = true, instead of
--    hand-typing eighteen 11-0 games on a phone. security definer, auth-first.
--    Robust to a no-show whose side never submitted: generates the match_line
--    rows from the season's rule_set rotation if missing. Forfeit writes are
--    exempt from the scorability trigger (§2), so this works without an opposing
--    lineup. The first forfeit insert flips the lock (§2), same as a real score.
-- ============================================================
create or replace function forfeit_match(p_match uuid, p_loser_side text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rounds   int;
  v_lines    int;
  v_games    int;
  v_rotation jsonb;
  v_home     int;
  v_away     int;
  r  int;
  hp int;
  ap int;
  g  int;
  ml uuid;
begin
  if p_loser_side not in ('home', 'away') then
    raise exception 'invalid side: %', p_loser_side;
  end if;

  -- --- AUTHORIZATION FIRST (either-captain or commissioner). ---
  if not can_write_match(p_match) then
    raise exception 'not authorized to score this match';
  end if;
  -- --- end auth gate ---

  select (rs.structure ->> 'rounds')::int,
         (rs.structure ->> 'lines_per_round')::int,
         (rs.structure ->> 'games_per_line')::int,
         rs.structure -> 'rotation'
    into v_rounds, v_lines, v_games, v_rotation
  from match m
  join division d on d.id = m.division_id
  join season   s on s.id = d.season_id
  join rule_set rs on rs.id = s.rule_set_id
  where m.id = p_match;

  if v_rotation is null then
    raise exception 'no rule_set rotation for this match''s season';
  end if;

  -- Ensure the rounds-aware match_line rows exist (no-op if already submitted).
  for r in 1..v_rounds loop
    for hp in 1..v_lines loop
      ap := (v_rotation -> (r::text) ->> (hp::text))::int;
      insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
      values (p_match, r, hp, ap)
      on conflict (match_id, round_number, home_pair_index) do nothing;
    end loop;
  end loop;

  if p_loser_side = 'home' then v_home := 0; v_away := 11;
  else                         v_home := 11; v_away := 0; end if;

  for ml in select id from match_line where match_id = p_match loop
    for g in 1..v_games loop
      insert into line_game (match_line_id, game_number, home_score, away_score, is_forfeit)
      values (ml, g, v_home, v_away, true)
      on conflict (match_line_id, game_number)
        do update set home_score = excluded.home_score,
                      away_score = excluded.away_score,
                      is_forfeit = true;
    end loop;
  end loop;
end;
$$;

-- ============================================================
-- 5. Grants (mirror the existing helper/RPC pattern).
-- ============================================================
revoke all on function is_match_scorable(uuid)       from public;
revoke all on function forfeit_match(uuid, text)      from public;
grant execute on function is_match_scorable(uuid)     to authenticated;
grant execute on function forfeit_match(uuid, text)   to authenticated;
-- submit_lineup's grant (to authenticated) is preserved across create or replace.
