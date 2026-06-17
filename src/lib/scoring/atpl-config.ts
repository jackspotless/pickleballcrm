import type { ScoringConfig } from "./types";

/**
 * ATPL ("Desert ATPL") scoring format config — the canonical value stored in
 * `scoring_format.config` (jsonb) by the seed. Structure and key names mirror
 * the data-model doc verbatim.
 *
 * Verified against the 04/07/2026 anchor (Other Desert Cities 21 @ Benchies
 * United 24): away 8 games x2 + 5 consolation = 21; home 10 games x2 + 4
 * consolation = 24 (9 consolation points total).
 */
export const ATPL_SCORING_CONFIG: ScoringConfig = {
  structure: { lines: 9, games_per_line: 2, doubles_lines: 9, singles_lines: 0 },
  game_rule: {
    target_score: 11,
    win_by: 2,
    hard_cap: null,
    tiebreak_game: { enabled: false },
  },
  points_model: {
    per_game_win: 2,
    per_game_loss: 0,
    consolation: { enabled: true, min_loser_score: 6, points: 1 },
  },
  match_outcome: { decided_by: "total_points" },
  standings: {
    win_points: 2,
    loss_points: 0,
    tie_points: 1,
    columns: ["Won", "Lost", "Tie", "SP", "TP", "OP"],
    sort: [
      { field: "SP", dir: "desc" },
      { field: "TP", dir: "desc" },
      { field: "OP", dir: "asc" },
    ],
  },
};
