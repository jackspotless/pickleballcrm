import type {
  Game,
  MatchOutcome,
  MatchTiebreaker,
  ScoringConfig,
  ScoringResult,
  Side,
  SideTotals,
  StandingsDelta,
} from "./types";

/**
 * Pure scoring engine: (games, config) => match totals, winner, standings deltas.
 *
 * ATPL scoring is per-game: the game winner earns `points_per_game_win`, and the
 * loser earns a consolation point when it reaches `consolation.min_loser_score`.
 * Lines don't award points directly — a line winner is tracked only for display
 * and standings tiebreakers, and a split line has no winner unless a deciding
 * game is enabled.
 *
 * Deterministic and side-effect free so the seed, API, and UI can reuse it.
 */
export function scoreMatch(
  games: Game[],
  config: ScoringConfig,
): ScoringResult {
  const lines = groupByLine(games);
  const cons = config.consolation;

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
    gamesWon: homeGamesWon,
    gamesLost: awayGamesWon,
    linesWon: homeLinesWon,
    linesLost: awayLinesWon,
    consolation: homeConsolation,
    pointsScored: homePointsScored,
    opponentPointsScored: awayPointsScored,
    config,
  });

  const away = buildTotals({
    gamesWon: awayGamesWon,
    gamesLost: homeGamesWon,
    linesWon: awayLinesWon,
    linesLost: homeLinesWon,
    consolation: awayConsolation,
    pointsScored: awayPointsScored,
    opponentPointsScored: homePointsScored,
    config,
  });

  const matchWinner = decideMatchWinner(config, home, away);

  return {
    matchTotals: { home, away },
    matchWinner,
    standingsDeltas: [
      toDelta("home", home, matchWinner),
      toDelta("away", away, matchWinner),
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
  gamesWon: number;
  gamesLost: number;
  linesWon: number;
  linesLost: number;
  consolation: number;
  pointsScored: number;
  opponentPointsScored: number;
  config: ScoringConfig;
}): SideTotals {
  return {
    points: args.gamesWon * args.config.points_per_game_win + args.consolation,
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
  if (home.points > away.points) return "home";
  if (away.points > home.points) return "away";

  for (const tb of config.match_tiebreakers ?? []) {
    const [h, a] = tiebreakValues(tb, home, away);
    if (h > a) return "home";
    if (a > h) return "away";
  }
  return "tie";
}

function tiebreakValues(
  tb: MatchTiebreaker,
  home: SideTotals,
  away: SideTotals,
): [number, number] {
  switch (tb) {
    case "games_won":
      return [home.gamesWon, away.gamesWon];
    case "lines_won":
      return [home.linesWon, away.linesWon];
    case "consolation":
      return [home.consolationPoints, away.consolationPoints];
    case "point_differential":
      return [home.pointDifferential, away.pointDifferential];
  }
}

function toDelta(
  side: Side,
  totals: SideTotals,
  winner: MatchOutcome,
): StandingsDelta {
  const result = winner === "tie" ? "tie" : winner === side ? "win" : "loss";
  return {
    side,
    ...totals,
    result,
    win: result === "win" ? 1 : 0,
    loss: result === "loss" ? 1 : 0,
    tie: result === "tie" ? 1 : 0,
  };
}
