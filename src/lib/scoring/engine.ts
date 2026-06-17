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
 * Deterministic and side-effect free so it can be unit tested and reused by the
 * seed, API, and (later) the UI without change.
 */
export function scoreMatch(
  games: Game[],
  config: ScoringConfig,
): ScoringResult {
  const lines = groupByLine(games);

  let homeLinesWon = 0;
  let awayLinesWon = 0;
  let homeGamesWon = 0;
  let awayGamesWon = 0;
  let homePointsScored = 0;
  let awayPointsScored = 0;

  for (const lineGames of lines.values()) {
    let lineHomeGames = 0;
    let lineAwayGames = 0;
    let lineHomePoints = 0;
    let lineAwayPoints = 0;

    for (const g of lineGames) {
      lineHomePoints += g.homeScore;
      lineAwayPoints += g.awayScore;
      if (g.homeScore > g.awayScore) lineHomeGames += 1;
      else if (g.awayScore > g.homeScore) lineAwayGames += 1;
      // exact ties contribute to neither side's game count
    }

    homeGamesWon += lineHomeGames;
    awayGamesWon += lineAwayGames;
    homePointsScored += lineHomePoints;
    awayPointsScored += lineAwayPoints;

    const lineWinner = decideLineWinner(config, {
      homeGames: lineHomeGames,
      awayGames: lineAwayGames,
      homePoints: lineHomePoints,
      awayPoints: lineAwayPoints,
    });
    if (lineWinner === "home") homeLinesWon += 1;
    else if (lineWinner === "away") awayLinesWon += 1;
  }

  const perGamePoint = config.pointsPerGamePoint ?? 0;

  const home: SideTotals = {
    points:
      homeGamesWon * config.pointsPerGameWin +
      homeLinesWon * config.pointsPerLineWin +
      homePointsScored * perGamePoint,
    linesWon: homeLinesWon,
    linesLost: awayLinesWon,
    gamesWon: homeGamesWon,
    gamesLost: awayGamesWon,
    pointsScored: homePointsScored,
    pointDifferential: homePointsScored - awayPointsScored,
  };

  const away: SideTotals = {
    points:
      awayGamesWon * config.pointsPerGameWin +
      awayLinesWon * config.pointsPerLineWin +
      awayPointsScored * perGamePoint,
    linesWon: awayLinesWon,
    linesLost: homeLinesWon,
    gamesWon: awayGamesWon,
    gamesLost: homeGamesWon,
    pointsScored: awayPointsScored,
    pointDifferential: awayPointsScored - homePointsScored,
  };

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

function decideLineWinner(
  config: ScoringConfig,
  line: {
    homeGames: number;
    awayGames: number;
    homePoints: number;
    awayPoints: number;
  },
): Side | "unset" {
  if (config.lineWinBy === "point_differential") {
    if (line.homePoints > line.awayPoints) return "home";
    if (line.awayPoints > line.homePoints) return "away";
    return "unset";
  }

  // default: games_won
  if (line.homeGames > line.awayGames) return "home";
  if (line.awayGames > line.homeGames) return "away";

  // games level — apply line tiebreak
  if ((config.lineTiebreak ?? "none") === "point_differential") {
    if (line.homePoints > line.awayPoints) return "home";
    if (line.awayPoints > line.homePoints) return "away";
  }
  return "unset";
}

function decideMatchWinner(
  config: ScoringConfig,
  home: SideTotals,
  away: SideTotals,
): MatchOutcome {
  if (home.points > away.points) return "home";
  if (away.points > home.points) return "away";

  for (const tb of config.matchTiebreakers ?? []) {
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
    case "lines_won":
      return [home.linesWon, away.linesWon];
    case "games_won":
      return [home.gamesWon, away.gamesWon];
    case "point_differential":
      return [home.pointDifferential, away.pointDifferential];
  }
}

function toDelta(
  side: Side,
  totals: SideTotals,
  winner: MatchOutcome,
): StandingsDelta {
  const result =
    winner === "tie" ? "tie" : winner === side ? "win" : "loss";
  return {
    side,
    ...totals,
    result,
    win: result === "win" ? 1 : 0,
    loss: result === "loss" ? 1 : 0,
    tie: result === "tie" ? 1 : 0,
  };
}
