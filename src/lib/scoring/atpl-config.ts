import type { ScoringConfig } from "./types";

/**
 * ATPL ("Desert ATPL") scoring format config.
 *
 * ⚠️ PROVISIONAL — these constants are a placeholder. The real ATPL ruleset
 * has not been provided yet. Once the verified 04/07/2026 game scores land, we
 * reverse-engineer the exact knobs from the known result (away 21 / home 24,
 * winner Benchies United) and pin them here. This object is the value stored in
 * `scoring_format.config` (jsonb) by the seed.
 */
export const ATPL_SCORING_CONFIG: ScoringConfig = {
  pointsPerGameWin: 1,
  pointsPerLineWin: 0,
  lineWinBy: "games_won",
  lineTiebreak: "point_differential",
  matchTiebreakers: ["games_won", "lines_won", "point_differential"],
};
