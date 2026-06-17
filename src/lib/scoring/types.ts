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

/**
 * How a line's winner is decided from its games.
 * - "games_won": side that won more games on the line.
 * - "point_differential": side with the higher total points across the line.
 */
export type LineWinBy = "games_won" | "point_differential";

/** Tiebreakers applied, in order, when match totals are equal. */
export type MatchTiebreaker = "lines_won" | "games_won" | "point_differential";

/**
 * The `scoring_format.config` JSON, typed. Drives how raw game scores roll up
 * into match totals and a winner. These knobs are league-configurable; the
 * ATPL values are pinned in atpl-config.ts.
 */
export interface ScoringConfig {
  /** Points awarded per individual game won. */
  pointsPerGameWin: number;
  /** Points awarded to the side that wins a line. */
  pointsPerLineWin: number;
  /** Points awarded per raw point scored in games (often 0). */
  pointsPerGamePoint?: number;
  /** How each line's winner is determined. */
  lineWinBy: LineWinBy;
  /** When `lineWinBy: "games_won"` ends level, break the line by this. */
  lineTiebreak?: "point_differential" | "none";
  /** Order of tiebreakers for the overall match winner. */
  matchTiebreakers?: MatchTiebreaker[];
}

/** Per-side rollup used both for match totals and standings deltas. */
export interface SideTotals {
  /** Final match points (the headline number, e.g. away 21 / home 24). */
  points: number;
  linesWon: number;
  linesLost: number;
  gamesWon: number;
  gamesLost: number;
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
