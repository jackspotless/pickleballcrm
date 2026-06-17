import type {
  Game,
  MatchOutcome,
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
 * reaches `points_model.consolation.min_loser_score`. Lines don't award points —
 * a line winner is tracked only for display/standings, and a split line has no
 * winner unless `game_rule.tiebreak_game.enabled` is set.
 *
 * Deterministic and side-effect free so the seed, API, and UI can reuse it.
 */
export function scoreMatch(
  games: Game[],
  config: ScoringConfig,
): ScoringResult {
  const lines = groupByLine(games);
  const cons = config.points_model.consolation;

  let homeGamesWon = 0;
  let awayGamesWon = 0;
  let homeLinesWon = 0;
  let awayLinesWon = 0;
  let homeConsolation = 0;
  let awayConsolation = 0;
  let homePointsScored = 0;
  let awayPointsScored = 0;

  for (const lineGames of lines.values()) {
    let lineHomeGames = 0;
    let lineAwayGames = 0;

    for (const g of lineGames) {
      homePointsScored += g.homeScore;
      awayPointsScored += g.awayScore;

      if (g.homeScore > g.awayScore) {
        lineHomeGames += 1;
        if (cons.enabled && g.awayScore >= cons.min_loser_score) {
          awayConsolation += cons.points;
        }
      } else if (g.awayScore > g.homeScore) {
        lineAwayGames += 1;
        if (cons.enabled && g.homeScore >= cons.min_loser_score) {
          homeConsolation += cons.points;
        }
      }
      // exact ties contribute to neither side's game count
    }

    homeGamesWon += lineHomeGames;
    awayGamesWon += lineAwayGames;

    // Line winner is for display/standings only; it awards no match points.
    if (lineHomeGames > lineAwayGames) homeLinesWon += 1;
    else if (lineAwayGames > lineHomeGames) awayLinesWon += 1;
    // level on games + no deciding game => the line has no winner
  }

  const home = buildTotals({
    config,
    gamesWon: homeGamesWon,
    gamesLost: awayGamesWon,
    linesWon: homeLinesWon,
    linesLost: awayLinesWon,
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

function groupByLine(games: Game[]): Map<number, Game[]> {
  const byLine = new Map<number, Game[]>();
  for (const g of games) {
    const arr = byLine.get(g.lineNumber);
    if (arr) arr.push(g);
    else byLine.set(g.lineNumber, [g]);
  }
  return byLine;
}

function buildTotals(args: {
  config: ScoringConfig;
  gamesWon: number;
  gamesLost: number;
  linesWon: number;
  linesLost: number;
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
  switch (config.match_outcome.decided_by) {
    case "total_points":
    default:
      if (home.points > away.points) return "home";
      if (away.points > home.points) return "away";
      return "tie";
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
