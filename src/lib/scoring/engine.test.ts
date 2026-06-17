import { describe, expect, it } from "vitest";
import { scoreMatch } from "./engine";
import { ATPL_SCORING_CONFIG } from "./atpl-config";
import type { Game, ScoringConfig } from "./types";

const SIMPLE: ScoringConfig = {
  points_per_game_win: 2,
  consolation: { enabled: true, min_loser_score: 6, points: 1 },
  tiebreak_game: { enabled: false },
  match_tiebreakers: ["games_won", "consolation", "point_differential"],
};

describe("scoreMatch — mechanics", () => {
  it("awards points_per_game_win to each game winner", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 3 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 4 },
      { lineNumber: 2, gameNumber: 1, homeScore: 5, awayScore: 11 },
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.gamesWon).toBe(2);
    expect(matchTotals.away.gamesWon).toBe(1);
    // no game-loser reached 6, so no consolation
    expect(matchTotals.home.consolationPoints).toBe(0);
    expect(matchTotals.away.consolationPoints).toBe(0);
    expect(matchTotals.home.points).toBe(4);
    expect(matchTotals.away.points).toBe(2);
  });

  it("gives the game loser a consolation point at/above the threshold", () => {
    const games: Game[] = [
      // loser scored 7 (>=6) -> consolation; loser scored 5 (<6) -> none
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 7 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 5 },
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.points).toBe(4); // 2 games x2
    expect(matchTotals.away.consolationPoints).toBe(1);
    expect(matchTotals.away.points).toBe(1); // 0 games + 1 consolation
  });

  it("honors the configurable threshold exactly", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 6 },
    ];
    expect(scoreMatch(games, SIMPLE).matchTotals.away.consolationPoints).toBe(1);
    const higher: ScoringConfig = {
      ...SIMPLE,
      consolation: { enabled: true, min_loser_score: 7, points: 1 },
    };
    expect(scoreMatch(games, higher).matchTotals.away.consolationPoints).toBe(0);
  });

  it("does not award a winner to a split line (tiebreak game disabled)", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 4 },
      { lineNumber: 1, gameNumber: 2, homeScore: 9, awayScore: 11 },
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.linesWon).toBe(0);
    expect(matchTotals.away.linesWon).toBe(0);
  });

  it("fills standings deltas for the winner and loser", () => {
    const games: Game[] = [
      { lineNumber: 1, gameNumber: 1, homeScore: 11, awayScore: 4 },
      { lineNumber: 1, gameNumber: 2, homeScore: 11, awayScore: 6 },
    ];
    const { matchWinner, standingsDeltas } = scoreMatch(games, SIMPLE);
    expect(matchWinner).toBe("home");
    const [home, away] = standingsDeltas;
    expect(home.result).toBe("win");
    expect(home.win).toBe(1);
    expect(away.result).toBe("loss");
    expect(away.loss).toBe(1);
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

  it("derives the totals from games + consolation (not line wins)", () => {
    const { matchTotals } = scoreMatch(games, ATPL_SCORING_CONFIG);
    // 18 games: away 8 wins, home 10 wins.
    expect(matchTotals.away.gamesWon).toBe(8);
    expect(matchTotals.home.gamesWon).toBe(10);
    // consolation (loser reached 6): away 5, home 4 -> 9 total.
    expect(matchTotals.away.consolationPoints).toBe(5);
    expect(matchTotals.home.consolationPoints).toBe(4);
    // away 8*2 + 5 = 21; home 10*2 + 4 = 24.
    expect(matchTotals.away.points).toBe(
      matchTotals.away.gamesWon * 2 + matchTotals.away.consolationPoints,
    );
  });
});
