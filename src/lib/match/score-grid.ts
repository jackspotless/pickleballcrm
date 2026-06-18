// Score-entry view model: maps persisted match_line + line_game rows into the
// pure scoring engine's Game[] and a read-only live preview. The preview imports
// the ONE verified scoreMatch (same engine the seed + CI anchor-verify use), so
// the running display can never drift from the scorer. Nothing here persists.

import { scoreMatch } from "../scoring/engine";
import type { Game, MatchOutcome, ScoringConfig } from "../scoring/types";

export interface MatchLineRow {
  id: string;
  round_number: number;
  home_pair_index: number;
  away_pair_index: number;
  home_player1_id: string | null;
  home_player2_id: string | null;
  away_player1_id: string | null;
  away_player2_id: string | null;
}

export interface LineGameRow {
  match_line_id: string;
  game_number: number;
  home_score: number | null;
  away_score: number | null;
  is_forfeit: boolean;
}

/**
 * Scorable iff both lineups are fully submitted — every match_line row has all 8
 * player columns non-null. Mirrors the DB is_match_scorable(); the screen guards
 * on this for UX, the trigger enforces it for real.
 */
export function isScorable(lines: MatchLineRow[]): boolean {
  return (
    lines.length > 0 &&
    lines.every(
      (l) =>
        l.home_player1_id &&
        l.home_player2_id &&
        l.away_player1_id &&
        l.away_player2_id,
    )
  );
}

/**
 * Persisted rows -> engine Game[]. Mirrors the CI verify-anchor query exactly:
 * round_number -> roundNumber, home_pair_index -> lineNumber, game_number ->
 * gameNumber. Games still missing a score are SKIPPED, so mid-entry the engine
 * receives a partial set and returns running totals — it never throws on a
 * partial array.
 */
export function toEngineGames(
  lines: MatchLineRow[],
  games: LineGameRow[],
): Game[] {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const out: Game[] = [];
  for (const g of games) {
    if (g.home_score === null || g.away_score === null) continue;
    const ml = lineById.get(g.match_line_id);
    if (!ml) continue;
    out.push({
      roundNumber: ml.round_number,
      lineNumber: ml.home_pair_index,
      gameNumber: g.game_number,
      homeScore: g.home_score,
      awayScore: g.away_score,
    });
  }
  return out;
}

export interface MatchPreview {
  /** Running headline totals (the engine's match points). */
  homePoints: number;
  awayPoints: number;
  homeRoundsWon: number;
  awayRoundsWon: number;
  /** Running raw points per round, for the live summary. */
  perRound: { round: number; home: number; away: number }[];
  /** Games entered vs. expected. */
  entered: number;
  expected: number;
  complete: boolean;
  /**
   * Declared match winner — ONLY when every expected game is in. Null mid-entry:
   * we never surface the VI.E outcome (tiebreaker-decided winner) on a partial
   * scoresheet, even though scoreMatch computes one internally.
   */
  winner: MatchOutcome | null;
}

/**
 * Read-only live preview. Computes running totals + per-round summary from the
 * games entered so far via the verified engine. The declared winner is withheld
 * until the scoresheet is complete (all lines * games_per_line games present).
 */
export function buildPreview(
  lines: MatchLineRow[],
  games: LineGameRow[],
  config: ScoringConfig,
  gamesPerLine: number,
): MatchPreview {
  const engineGames = toEngineGames(lines, games);
  const result = scoreMatch(engineGames, config);

  const expected = lines.length * gamesPerLine;
  const entered = engineGames.length;
  const complete = expected > 0 && entered === expected;

  const perRoundMap = new Map<number, { home: number; away: number }>();
  for (const g of engineGames) {
    const pr = perRoundMap.get(g.roundNumber) ?? { home: 0, away: 0 };
    pr.home += g.homeScore;
    pr.away += g.awayScore;
    perRoundMap.set(g.roundNumber, pr);
  }
  const perRound = [...perRoundMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, v]) => ({ round, home: v.home, away: v.away }));

  return {
    homePoints: result.matchTotals.home.points,
    awayPoints: result.matchTotals.away.points,
    homeRoundsWon: result.matchTotals.home.roundsWon,
    awayRoundsWon: result.matchTotals.away.roundsWon,
    perRound,
    entered,
    expected,
    complete,
    winner: complete ? result.matchWinner : null,
  };
}
