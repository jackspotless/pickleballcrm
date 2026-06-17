import type { ScoringConfig } from "./types";

/**
 * ATPL ("Desert ATPL") scoring format config — the value stored in
 * `scoring_format.config` (jsonb) by the seed.
 *
 * Verified against the 04/07/2026 anchor match (Other Desert Cities 21 @
 * Benchies United 24): 2 points per game won + 1 point per line won, where a
 * line goes to the side that wins more of its games and a 1–1 split is decided
 * by the last (deciding) game.
 */
export const ATPL_SCORING_CONFIG: ScoringConfig = {
  pointsPerGameWin: 2,
  pointsPerLineWin: 1,
  lineWinBy: "games_won",
  lineTiebreak: "last_game",
  matchTiebreakers: ["games_won", "lines_won", "point_differential"],
};
