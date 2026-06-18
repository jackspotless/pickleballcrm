-- supabase/migrations/20260619000000_flag_review.sql
-- Flag review (PR #6): the commissioner-side surface for flagged matches.
-- Owns the result-correction lifecycle PR #5 parked:
--   * auto-finalize on scoring completion (closes the captain score-lock gap
--     without a manual step or a 4th status — uses match.status = 'final'),
--   * captains lose line_game write at 'final'; the commissioner stays exempt
--     (the in-place correction escape hatch, A1),
--   * resolve_flag() records resolution (B2) decoupled from any score edit,
--   * correct_lineup(): commissioner-only, LOCK-EXEMPT pairing correction.

-- ============================================================
-- 1. Scoring-complete helper: every expected game determined (both scores set,
--    or a forfeit). Expected = (# match_line rows) * games_per_line, from the
--    season's rule_set. Forfeits count as determined (a forfeited match completes).
-- ============================================================
create or replace function is_scoring_complete(p_match uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  with gpl as (
    select (rs.structure ->> 'games_per_line')::int as n
    from match m
    join division d  on d.id = m.division_id
    join season   s  on s.id = d.season_id
    join rule_set rs on rs.id = s.rule_set_id
    where m.id = p_match
  ),
  lines as (select id from match_line where match_id = p_match)
  select (select n from gpl) > 0
     and exists (select 1 from lines)
     and ( select count(*) from line_game lg
           join lines l on l.id = lg.match_line_id
           where (lg.home_score is not null and lg.away_score is not null)
              or lg.is_forfeit )
         >= (select count(*) from lines) * (select n from gpl);
$$;

-- ============================================================
-- 2. Extend the line_game AFTER-write trigger with the completion rung.
--    Gate-on-status / transition-in-trigger (the #5 split): the COMPLETING write
--    passes WITH CHECK because status is still 'in_progress' when the policy runs;
--    this trigger then flips it to 'final', locking the NEXT captain write.
-- ============================================================
create or replace function line_game_after_write() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_match  uuid;
  v_status match_status;
begin
  select ml.match_id into v_match from match_line ml where ml.id = new.match_line_id;

  -- Scorability boundary (PR #5). Forfeits exempt (absent/short side).
  if not new.is_forfeit and not is_match_scorable(v_match) then
    raise exception 'match not scorable: both lineups required';
  end if;

  -- Lifecycle on a determined result (both scores set, or a forfeit):
  if new.is_forfeit or (new.home_score is not null and new.away_score is not null) then
    select status into v_status from match where id = v_match;

    -- First determined result: scheduled -> in_progress (PR #5 lineup-lock).
    if v_status = 'scheduled' then
      update match set status = 'in_progress' where id = v_match;
      v_status := 'in_progress';
    end if;

    -- Scoring complete: in_progress -> final (PR #6 auto-finalize; the captain
    -- score-lock engages on the normal close, no manual finalize required).
    if v_status = 'in_progress' and is_scoring_complete(v_match) then
      update match set status = 'final' where id = v_match;
    end if;
  end if;

  return null; -- AFTER trigger: return value ignored
end;
$$;
-- (line_game_after_write_trg already bound to this function in PR #5.)

-- ============================================================
-- 3. Captain final-lock. Extend line_game_write WITH CHECK only (not `using`),
--    so a captain write to a 'final' match throws 42501 + row-level security
--    (consistent deny mechanism), while the commissioner stays exempt (in-place
--    correction). `using` is unchanged -> the PR #5 deny mechanisms are preserved.
-- ============================================================
create or replace function can_score_line_game(p_match_line uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select can_write_match(m.id)
     and ( m.status <> 'final' or is_commissioner(division_league_id(m.division_id)) )
  from match m
  join match_line ml on ml.match_id = m.id
  where ml.id = p_match_line;
$$;

drop policy line_game_write on line_game;
create policy line_game_write on line_game for all to authenticated
  using      (can_write_match((select ml.match_id from match_line ml where ml.id = line_game.match_line_id)))
  with check (can_score_line_game(line_game.match_line_id));

-- ============================================================
-- 4. Flag resolution record (B2): single mutable record on match.
--    flag_comment stays the original dispute; resolving stamps the rest.
--    (A re-flag via flag_match() does NOT clear these — they are authoritative
--    only when is_flagged = false; see the harness "re-flag" case.)
-- ============================================================
alter table match
  add column flag_resolution  text,
  add column flag_resolved_at timestamptz,
  add column flag_resolved_by uuid references member(id) on delete set null;

-- ============================================================
-- 5. resolve_flag(): commissioner clears a flag and records how it was resolved.
--    Decoupled from correction — touches ONLY the flag fields, never line_game /
--    match_line. (A commissioner can resolve without editing a score, and correct
--    without resolving.)
-- ============================================================
create or replace function resolve_flag(p_match uuid, p_resolution text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_commissioner(match_league_id(p_match)) then
    raise exception 'not authorized to resolve flags for this match';
  end if;
  update match
     set is_flagged       = false,
         flag_resolution  = p_resolution,
         flag_resolved_at = now(),
         flag_resolved_by = (current_member()).id
   where id = p_match;
end;
$$;

-- ============================================================
-- 6. correct_lineup(): commissioner-only pairing correction, LOCK-EXEMPT (no
--    status guard — unlike submit_lineup) so a disputed pairing can be re-set
--    after the match locks. Generates the rounds-aware rows and writes one side's
--    columns; the match_line_players_same_league trigger still validates the
--    member league (dropping the lock guard does NOT drop the FK-value guard).
-- ============================================================
create or replace function correct_lineup(p_match uuid, p_side text, p_pairs uuid[]) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
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

  -- AUTHORIZATION FIRST: commissioner only (this is the post-lock correction path).
  if not is_commissioner(match_league_id(p_match)) then
    raise exception 'not authorized to correct lineup for this match';
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
-- 7. Grants (mirror the existing helper/RPC pattern). Finalize / re-open stay
--    direct match updates gated by match_write (commissioner-only) — no RPC.
-- ============================================================
revoke all on function is_scoring_complete(uuid)        from public;
revoke all on function can_score_line_game(uuid)        from public;
revoke all on function resolve_flag(uuid, text)         from public;
revoke all on function correct_lineup(uuid, text, uuid[]) from public;
grant execute on function is_scoring_complete(uuid)      to authenticated;
grant execute on function can_score_line_game(uuid)      to authenticated;
grant execute on function resolve_flag(uuid, text)       to authenticated;
grant execute on function correct_lineup(uuid, text, uuid[]) to authenticated;
