import { describe, expect, it } from "vitest";
import { scoreMatch } from "./engine";
import type { Game, ScoringConfig } from "./types";

// A simple, fully-determined config for exercising the engine mechanics.
const SIMPLE: ScoringConfig = {
  pointsPerGameWin: 1,
  pointsPerLineWin: 0,
  lineWinBy: "games_won",
  lineTiebreak: "point_differential",
  matchTiebreakers: ["games_won", "lines_won", "point_differential"],
};

describe("scoreMatch — mechanics", () => {
  it("tallies game wins per side", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 7 },
      { lineNumber: 1, gameNumber: 2, homeScore: 9, awayScore: 11 },
      { lineNumber: 2, gameNumber: 1, homeScore: 11, awayScore: 5 },
      { lineNumber: 2, gameNumber: 2, homeScore: 11, awayScore: 8 },
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.gamesWon).toBe(3);
    expect(matchTotals.away.gamesWon).toBe(1);
    expect(matchTotals.home.points).toBe(3);
    expect(matchTotals.away.points).toBe(1);
  });

  it("counts lines won by majority of games", () => {
    const games: Game[] = [
      // line 1: home sweeps
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 4 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 6 },
      // line 2: away sweeps
      { lineNumber: 2, gameNumber: 1, homeScore: 5, awayScore: 11 },
      { lineNumber: 2, gameNumber: 2, homeScore: 8, awayScore: 11 },
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.linesWon).toBe(1);
    expect(matchTotals.away.linesWon).toBe(1);
  });

  it("breaks a split line (1–1) by point differential", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 2 },
      { lineNumber: 1, gameNumber: 2, homeScore: 9, awayScore: 11 },
    ];
    // home: 20 pts, away: 13 pts -> home takes the line on differential
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.linesWon).toBe(1);
    expect(matchTotals.away.linesWon).toBe(0);
  });

  it("rewards lines instead of games when configured", () => {
    const lineConfig: ScoringConfig = {
      pointsPerGameWin: 0,
      pointsPerLineWin: 5,
      lineWinBy: "games_won",
    };
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 4 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 6 },
    ];
    const { matchTotals } = scoreMatch(games, lineConfig);
    expect(matchTotals.home.points).toBe(5);
    expect(matchTotals.away.points).toBe(0);
  });

  it("declares the higher total the winner and fills standings deltas", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 4 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 6 },
      { lineNumber: 2, gameNumber: 1, homeScore: 9, awayScore: 11 },
    ];
    const result = scoreMatch(games, SIMPLE);
    expect(result.matchWinner).toBe("home");

    const [homeDelta, awayDelta] = result.standingsDeltas;
    expect(homeDelta.result).toBe("win");
    expect(homeDelta.win).toBe(1);
    expect(awayDelta.result).toBe("loss");
    expect(awayDelta.loss).toBe(1);
  });

  it("returns a tie when totals and all tiebreakers are level", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 5 },
      { lineNumber: 1, gameNumber: 2, homeScore: 5, awayScore: 11 },
    ];
    const { matchWinner } = scoreMatch(games, {
      ...SIMPLE,
      matchTiebreakers: [],
    });
    expect(matchWinner).toBe("tie");
  });
});

describe("scoreMatch — ATPL seed match (04/07/2026)", () => {
  // ACCEPTANCE TARGET: away 21, home 24, winner Benchies United (home).
  // Pending the verified 9-line game scores from pickleballscores.com and the
  // final ATPL config. Once pasted, fill `games` + config and enable.
  it.todo("scores the seed match as away 21 / home 24, winner Benchies United");
});
