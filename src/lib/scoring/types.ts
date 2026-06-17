// Pure scoring-engine types. No I/O, no Supabase — just data in, data out.
// The ScoringConfig shape mirrors the canonical `scoring_format.config` JSON
// verbatim (same nesting, same key names) so the stored jsonb matches the doc.

/** One game played on a line (e.g. line 3, game 2). */
export interface Game {
  lineNumber: number;
  gameNumber: number;
  homeScore: number;
  awayScore: number;
}

export type Side = "home" | "away";
export type MatchOutcome = Side | "tie";

// ---- Canonical config blocks -----------------------------------------------

export interface StructureConfig {
  lines: number;
  games_per_line: number;
  doubles_lines: number;
  singles_lines: number;
}

export interface TiebreakGameRule {
  enabled: boolean;
}

export interface GameRuleConfig {
  target_score: number;
  win_by: number;
  hard_cap: number | null;
  tiebreak_game: TiebreakGameRule;
}

/**
 * Consolation: the losing side of a game earns `points` when it reaches at
 * least `min_loser_score`. (ATPL: 1 pt when a game's loser reaches 6.)
 */
export interface ConsolationRule {
  enabled: boolean;
  min_loser_score: number;
  points: number;
}

export interface PointsModelConfig {
  per_game_win: number;
  per_game_loss: number;
  consolation: ConsolationRule;
}

export type MatchDecidedBy = "total_points";

export interface MatchOutcomeConfig {
  decided_by: MatchDecidedBy;
}

export interface StandingsSort {
  field: string;
  dir: "asc" | "desc";
}

export interface StandingsConfig {
  win_points: number;
  loss_points: number;
  tie_points: number;
  columns: string[];
  sort: StandingsSort[];
}

export interface ScoringConfig {
  structure: StructureConfig;
  game_rule: GameRuleConfig;
  points_model: PointsModelConfig;
  match_outcome: MatchOutcomeConfig;
  standings: StandingsConfig;
}

// ---- Engine output ----------------------------------------------------------

/** Per-side rollup used both for match totals and standings deltas. */
export interface SideTotals {
  /** Final match points (the headline number, e.g. away 21 / home 24). */
  points: number;
  gamesWon: number;
  gamesLost: number;
  linesWon: number;
  linesLost: number;
  /** Consolation points earned across all games. */
  consolationPoints: number;
  /** Total raw points scored across all games. */
  pointsScored: number;
  /** pointsScored − opponent's pointsScored. */
  pointDifferential: number;
}

/**
 * One match's contribution to a team's standings row. Field names map to the
 * canonical `standings.columns`: Won, Lost, Tie, SP, TP, OP.
 */
export interface StandingsDelta extends SideTotals {
  side: Side;
  result: "win" | "loss" | "tie";
  won: 0 | 1; // Won
  lost: 0 | 1; // Lost
  tied: 0 | 1; // Tie
  standingsPoints: number; // SP
  pointsFor: number; // TP
  pointsAgainst: number; // OP
}

export interface ScoringResult {
  matchTotals: { home: SideTotals; away: SideTotals };
  matchWinner: MatchOutcome;
  standingsDeltas: StandingsDelta[]; // [home, away]
}
