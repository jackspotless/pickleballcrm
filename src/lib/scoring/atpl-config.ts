import type { ScoringConfig } from "./types";

/**
 * ATPL ("Desert ATPL") scoring format config — the value stored in
 * `scoring_format.config` (jsonb) by the seed.
 *
 * Per the data-model doc and verified against the 04/07/2026 anchor (Other
 * Desert Cities 21 @ Benchies United 24):
 *   - 2 points to the winner of each game;
 *   - 1 consolation point to the loser of a game when it reaches 6;
 *   - no deciding/tiebreak game (a split line simply has no winner).
 *
 * away 8 games x2 + 5 consolation = 21; home 10 games x2 + 4 consolation = 24
 * (9 consolation points total).
 */
export const ATPL_SCORING_CONFIG: ScoringConfig = {
  points_per_game_win: 2,
  consolation: {
    enabled: true,
    min_loser_score: 6,
    points: 1,
  },
  tiebreak_game: {
    enabled: false,
  },
  match_tiebreakers: ["games_won", "consolation", "point_differential"],
};
