-- supabase/migrations/20260618120000_lineup.sql
-- Lineup submission: a side-validated submit_lineup() RPC becomes the ONLY
-- captain path to match_line; captains lose direct match_line write.

-- ============================================================
-- 1. Captains can no longer write match_line directly — the RPC is the only
--    door, so the column-ownership boundary can't be bypassed with a raw write.
--    (Commissioner direct-write stays for corrections.)
-- ============================================================
drop policy match_line_write on match_line;
create policy match_line_write on match_line for all to authenticated
  using      (is_commissioner(match_league_id(match_line.match_id)))
  with check (is_commissioner(match_league_id(match_line.match_id)));

-- ============================================================
-- 2. submit_lineup(): validate side-ownership, generate the 9 rows from the
--    season's rule_set rotation, write ONLY this side's player columns.
--    security definer (bypasses RLS) -> the in-function auth check is the only
--    gate, so it runs FIRST, before any row generation or column write.
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

  -- Row creation is idempotent (existence only). Re-submit must still update
  -- columns below, so the pairing values are NOT skipped on conflict.
  for r in 1..v_rounds loop
    for hp in 1..v_lines loop
      ap := (v_rotation -> (r::text) ->> (hp::text))::int;
      insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
      values (p_match, r, hp, ap)
      on conflict (match_id, round_number, home_pair_index) do nothing;
    end loop;
  end loop;

  -- Unconditional column write -> a re-submit (corrected six before lock)
  -- overwrites the prior pairing. Per pair index: pair k uses p_pairs[2k-1], [2k].
  -- The match_line_players_same_league trigger validates these on update.
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

revoke all on function submit_lineup(uuid, text, uuid[]) from public;
grant execute on function submit_lineup(uuid, text, uuid[]) to authenticated;
