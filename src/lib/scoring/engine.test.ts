import { describe, expect, it } from "vitest";
import { scoreMatch } from "./engine";
import { ATPL_SCORING_CONFIG } from "./atpl-config";
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
  // Verified anchor: Other Desert Cities (away) @ Benchies United (home),
  // 9 lines x 2 games. away score - home score per game.
  const games: Game[] = [
    { lineNumber: 1, gameNumber: 1, awayScore: 3, homeScore: 11 },
    { lineNumber: 1, gameNumber: 2, awayScore: 12, homeScore: 10 },
    { lineNumber: 2, gameNumber: 1, awayScore: 10, homeScore: 12 },
    { lineNumber: 2, gameNumber: 2, awayScore: 7, homeScore: 11 },
    { lineNumber: 3, gameNumber: 1, awayScore: 3, homeScore: 11 },
    { lineNumber: 3, gameNumber: 2, awayScore: 0, homeScore: 11 },
    { lineNumber: 4, gameNumber: 1, awayScore: 4, homeScore: 11 },
    { lineNumber: 4, gameNumber: 2, awayScore: 3, homeScore: 11 },
    { lineNumber: 5, gameNumber: 1, awayScore: 11, homeScore: 4 },
    { lineNumber: 5, gameNumber: 2, awayScore: 11, homeScore: 2 },
    { lineNumber: 6, gameNumber: 1, awayScore: 8, homeScore: 11 },
    { lineNumber: 6, gameNumber: 2, awayScore: 11, homeScore: 5 },
    { lineNumber: 7, gameNumber: 1, awayScore: 11, homeScore: 8 },
    { lineNumber: 7, gameNumber: 2, awayScore: 11, homeScore: 2 },
    { lineNumber: 8, gameNumber: 1, awayScore: 11, homeScore: 8 },
    { lineNumber: 8, gameNumber: 2, awayScore: 11, homeScore: 9 },
    { lineNumber: 9, gameNumber: 1, awayScore: 11, homeScore: 13 },
    { lineNumber: 9, gameNumber: 2, awayScore: 8, homeScore: 11 },
  ];

  it("scores away 21 / home 24, winner Benchies United (home)", () => {
    const { matchTotals, matchWinner } = scoreMatch(games, ATPL_SCORING_CONFIG);
    expect(matchTotals.away.points).toBe(21);
    expect(matchTotals.home.points).toBe(24);
    expect(matchWinner).toBe("home");
  });

  it("rolls up the expected game and line tallies", () => {
    const { matchTotals } = scoreMatch(games, ATPL_SCORING_CONFIG);
    // 18 games: away 8 wins, home 10 wins.
    expect(matchTotals.away.gamesWon).toBe(8);
    expect(matchTotals.home.gamesWon).toBe(10);
    // 9 lines: away 5 (incl. both 1-1 splits via last game), home 4.
    expect(matchTotals.away.linesWon).toBe(5);
    expect(matchTotals.home.linesWon).toBe(4);
  });
});
