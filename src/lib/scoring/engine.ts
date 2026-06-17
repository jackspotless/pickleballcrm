import type {
  Game,
  MatchOutcome,
  MatchTiebreakerField,
  ScoringConfig,
  ScoringResult,
  Side,
  SideTotals,
  StandingsDelta,
} from "./types";

/**
 * Pure scoring engine: (games, config) => match totals, winner, standings deltas.
 *
 * ATPL scoring is per-game: the game winner earns `points_model.per_game_win`,
 * the loser earns `points_model.per_game_loss` plus a consolation point when it
 * reaches `consolation.min_loser_score`. Lines award no points (a split line has
 * no winner; tracked for display). Match winner is decided by total team points
 * (`match_outcome.decided_by`); ties fall through the VI.E.3 tiebreaker chain.
 *
 * Deterministic and side-effect free so the seed, API, and UI can reuse it.
 */
export function scoreMatch(
  games: Game[],
  config: ScoringConfig,
): ScoringResult {
  const cons = config.points_model.consolation;

  let homeGamesWon = 0;
  let awayGamesWon = 0;
  let homeConsolation = 0;
  let awayConsolation = 0;
  let homePointsScored = 0;
  let awayPointsScored = 0;

  // line key (`round-line`) -> games won by each side, for line winner (display)
  const lineWins = new Map<string, { home: number; away: number }>();
  // round number -> games won by each side + total, for rounds_won
  const roundWins = new Map<number, { home: number; away: number; total: number }>();

  for (const g of games) {
    homePointsScored += g.homeScore;
    awayPointsScored += g.awayScore;

    const lineKey = `${g.roundNumber}-${g.lineNumber}`;
    const line = lineWins.get(lineKey) ?? { home: 0, away: 0 };
    const round = roundWins.get(g.roundNumber) ?? { home: 0, away: 0, total: 0 };
    round.total += 1;

    if (g.homeScore > g.awayScore) {
      homeGamesWon += 1;
      line.home += 1;
      round.home += 1;
      if (cons.enabled && g.awayScore >= cons.min_loser_score) {
        awayConsolation += cons.points;
      }
    } else if (g.awayScore > g.homeScore) {
      awayGamesWon += 1;
      line.away += 1;
      round.away += 1;
      if (cons.enabled && g.homeScore >= cons.min_loser_score) {
        homeConsolation += cons.points;
      }
    }
    // exact ties contribute to neither side's game count

    lineWins.set(lineKey, line);
    roundWins.set(g.roundNumber, round);
  }

  let homeLinesWon = 0;
  let awayLinesWon = 0;
  for (const l of lineWins.values()) {
    if (l.home > l.away) homeLinesWon += 1;
    else if (l.away > l.home) awayLinesWon += 1;
    // level on games + no deciding game => the line has no winner
  }

  let homeRoundsWon = 0;
  let awayRoundsWon = 0;
  for (const r of roundWins.values()) {
    // a round goes to the side that won strictly more than half its games
    if (r.home * 2 > r.total) homeRoundsWon += 1;
    else if (r.away * 2 > r.total) awayRoundsWon += 1;
  }

  const home = buildTotals({
    config,
    gamesWon: homeGamesWon,
    gamesLost: awayGamesWon,
    linesWon: homeLinesWon,
    linesLost: awayLinesWon,
    roundsWon: homeRoundsWon,
    consolation: homeConsolation,
    pointsScored: homePointsScored,
    opponentPointsScored: awayPointsScored,
  });

  const away = buildTotals({
    config,
    gamesWon: awayGamesWon,
    gamesLost: homeGamesWon,
    linesWon: awayLinesWon,
    linesLost: homeLinesWon,
    roundsWon: awayRoundsWon,
    consolation: awayConsolation,
    pointsScored: awayPointsScored,
    opponentPointsScored: homePointsScored,
  });

  const matchWinner = decideMatchWinner(config, home, away);

  return {
    matchTotals: { home, away },
    matchWinner,
    standingsDeltas: [
      toDelta("home", home, away.points, matchWinner, config),
      toDelta("away", away, home.points, matchWinner, config),
    ],
  };
}

function buildTotals(args: {
  config: ScoringConfig;
  gamesWon: number;
  gamesLost: number;
  linesWon: number;
  linesLost: number;
  roundsWon: number;
  consolation: number;
  pointsScored: number;
  opponentPointsScored: number;
}): SideTotals {
  const pm = args.config.points_model;
  return {
    points:
      args.gamesWon * pm.per_game_win +
      args.gamesLost * pm.per_game_loss +
      args.consolation,
    gamesWon: args.gamesWon,
    gamesLost: args.gamesLost,
    linesWon: args.linesWon,
    linesLost: args.linesLost,
    roundsWon: args.roundsWon,
    consolationPoints: args.consolation,
    pointsScored: args.pointsScored,
    pointDifferential: args.pointsScored - args.opponentPointsScored,
  };
}

function decideMatchWinner(
  config: ScoringConfig,
  home: SideTotals,
  away: SideTotals,
): MatchOutcome {
  // decided_by: total_team_points
  if (home.points !== away.points) {
    return home.points > away.points ? "home" : "away";
  }
  // VI.E.3 single-match tiebreaker chain
  for (const tb of config.match_outcome.tiebreakers ?? []) {
    const hv = tieValue(tb.field, home, away);
    const av = tieValue(tb.field, away, home);
    if (hv !== av) {
      const homeBetter = tb.dir === "desc" ? hv > av : hv < av;
      return homeBetter ? "home" : "away";
    }
  }
  return "tie";
}

function tieValue(
  field: MatchTiebreakerField,
  side: SideTotals,
  other: SideTotals,
): number {
  switch (field) {
    case "games_won":
      return side.gamesWon;
    case "total_points_scored":
      return side.pointsScored;
    case "opponent_points_scored":
      return other.pointsScored;
    case "rounds_won":
      return side.roundsWon;
  }
}

function toDelta(
  side: Side,
  totals: SideTotals,
  opponentPoints: number,
  winner: MatchOutcome,
  config: ScoringConfig,
): StandingsDelta {
  const result = winner === "tie" ? "tie" : winner === side ? "win" : "loss";
  const s = config.standings;
  const standingsPoints =
    result === "win"
      ? s.win_points
      : result === "loss"
        ? s.loss_points
        : s.tie_points;
  return {
    side,
    ...totals,
    result,
    won: result === "win" ? 1 : 0,
    lost: result === "loss" ? 1 : 0,
    tied: result === "tie" ? 1 : 0,
    standingsPoints,
    pointsFor: totals.points,
    pointsAgainst: opponentPoints,
  };
}
