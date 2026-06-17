// Pure scoring-engine types. No I/O, no Supabase — just data in, data out.

/** One game played on a line (e.g. line 3, game 2). */
export interface Game {
  lineNumber: number;
  gameNumber: number;
  homeScore: number;
  awayScore: number;
}

export type Side = "home" | "away";
export type MatchOutcome = Side | "tie";

/** Tiebreakers applied, in order, when match points are equal. */
export type MatchTiebreaker =
  | "games_won"
  | "lines_won"
  | "consolation"
  | "point_differential";

/**
 * Consolation rule: the losing side of a game earns `points` if it reached at
 * least `min_loser_score`. (ATPL: 1 pt when a game's loser reaches 6.)
 */
export interface ConsolationRule {
  enabled: boolean;
  min_loser_score: number;
  points: number;
}

/**
 * Whether a deciding (tiebreak) game is played when a line is level on games.
 * ATPL: disabled — a split line simply has no winner.
 */
export interface TiebreakGameRule {
  enabled: boolean;
}

/**
 * The `scoring_format.config` JSON, typed. Keys mirror the data-model doc so the
 * stored jsonb matches it verbatim. ATPL values are pinned in atpl-config.ts.
 */
export interface ScoringConfig {
  /** Points awarded to the winner of each game. */
  points_per_game_win: number;
  /** Per-game consolation for the loser. */
  consolation: ConsolationRule;
  /** Deciding-game behavior for split lines. */
  tiebreak_game: TiebreakGameRule;
  /** Order of tiebreakers for the overall match winner. */
  match_tiebreakers?: MatchTiebreaker[];
}

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

export interface StandingsDelta extends SideTotals {
  side: Side;
  result: "win" | "loss" | "tie";
  win: 0 | 1;
  loss: 0 | 1;
  tie: 0 | 1;
}

export interface ScoringResult {
  matchTotals: { home: SideTotals; away: SideTotals };
  matchWinner: MatchOutcome;
  standingsDeltas: StandingsDelta[]; // [home, away]
}
