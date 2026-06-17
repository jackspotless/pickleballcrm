import { describe, expect, it } from "vitest";
import { scoreMatch } from "./engine";
import { ATPL_SCORING_CONFIG } from "./atpl-config";
import { lineNumberToSlot } from "../match/rotation";
import type { Game, ScoringConfig } from "./types";

const SIMPLE: ScoringConfig = {
  structure: { lines: 9, games_per_line: 2, doubles_lines: 9, singles_lines: 0 },
  game_rule: {
    target_score: 11,
    win_by: 2,
    hard_cap: null,
    tiebreak_game: { enabled: false },
  },
  points_model: {
    per_game_win: 2,
    per_game_loss: 0,
    consolation: { enabled: true, min_loser_score: 6, points: 1 },
  },
  match_outcome: {
    decided_by: "total_team_points",
    tiebreakers: [
      { field: "games_won", dir: "desc" },
      { field: "total_points_scored", dir: "desc" },
      { field: "opponent_points_scored", dir: "asc" },
      { field: "rounds_won", dir: "desc" },
    ],
  },
  standings: {
    win_points: 2,
    loss_points: 0,
    tie_points: 1,
    columns: ["Won", "Lost", "Tie", "SP", "TP", "OP"],
    sort: [
      { field: "SP", dir: "desc" },
      { field: "TP", dir: "desc" },
      { field: "OP", dir: "asc" },
    ],
  },
};

const g = (
  round: number,
  line: number,
  game: number,
  home: number,
  away: number,
): Game => ({
  roundNumber: round,
  lineNumber: line,
  gameNumber: game,
  homeScore: home,
  awayScore: away,
});

describe("scoreMatch — mechanics", () => {
  it("awards points_model.per_game_win to each game winner", () => {
    const games: Game[] = [
      g(1, 1, 1, 11, 3),
      g(1, 1, 2, 11, 4),
      g(1, 2, 1, 5, 11),
    ];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.gamesWon).toBe(2);
    expect(matchTotals.away.gamesWon).toBe(1);
    expect(matchTotals.home.consolationPoints).toBe(0);
    expect(matchTotals.away.consolationPoints).toBe(0);
    expect(matchTotals.home.points).toBe(4);
    expect(matchTotals.away.points).toBe(2);
  });

  it("gives the game loser a consolation point at/above the threshold", () => {
    const games: Game[] = [g(1, 1, 1, 11, 7), g(1, 1, 2, 11, 5)];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.points).toBe(4); // 2 games x2
    expect(matchTotals.away.consolationPoints).toBe(1);
    expect(matchTotals.away.points).toBe(1); // 0 games + 1 consolation
  });

  it("honors the configurable threshold exactly", () => {
    const games: Game[] = [g(1, 1, 1, 11, 6)];
    expect(scoreMatch(games, SIMPLE).matchTotals.away.consolationPoints).toBe(1);
    const higher: ScoringConfig = {
      ...SIMPLE,
      points_model: {
        ...SIMPLE.points_model,
        consolation: { enabled: true, min_loser_score: 7, points: 1 },
      },
    };
    expect(scoreMatch(games, higher).matchTotals.away.consolationPoints).toBe(0);
  });

  it("does not award a winner to a split line (tiebreak game disabled)", () => {
    const games: Game[] = [g(1, 1, 1, 11, 4), g(1, 1, 2, 9, 11)];
    const { matchTotals } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.linesWon).toBe(0);
    expect(matchTotals.away.linesWon).toBe(0);
  });

  it("records an 11-0 forfeit as winner 2, loser 0, no consolation", () => {
    const { matchTotals } = scoreMatch([g(1, 1, 1, 11, 0)], SIMPLE);
    expect(matchTotals.home.points).toBe(2);
    expect(matchTotals.away.points).toBe(0);
    expect(matchTotals.home.consolationPoints).toBe(0);
    expect(matchTotals.away.consolationPoints).toBe(0);
  });

  it("fills standings deltas for the winner and loser", () => {
    const games: Game[] = [g(1, 1, 1, 11, 4), g(1, 1, 2, 11, 6)];
    const { matchWinner, standingsDeltas } = scoreMatch(games, SIMPLE);
    expect(matchWinner).toBe("home");
    const [home, away] = standingsDeltas;
    expect(home.result).toBe("win");
    expect(home.won).toBe(1);
    expect(home.standingsPoints).toBe(2); // win_points
    expect(home.pointsFor).toBe(home.points);
    expect(home.pointsAgainst).toBe(away.points);
    expect(away.result).toBe("loss");
    expect(away.lost).toBe(1);
    expect(away.standingsPoints).toBe(0); // loss_points
  });
});

describe("scoreMatch — match tiebreakers (VI.E.3)", () => {
  it("breaks a team-point tie by games won (not a default tie)", () => {
    // home: 2 games won, 0 consolation = 4.  away: 1 game won + 2 consolation = 4.
    const games: Game[] = [
      g(1, 1, 1, 11, 6), // home win; away reaches 6 -> away +1 consolation
      g(1, 2, 1, 11, 6), // home win; away +1 consolation
      g(1, 3, 1, 3, 11), // away win; home scores 3 (<6) -> no home consolation
    ];
    const { matchTotals, matchWinner } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.points).toBe(4);
    expect(matchTotals.away.points).toBe(4);
    expect(matchTotals.home.gamesWon).toBe(2);
    expect(matchTotals.away.gamesWon).toBe(1);
    expect(matchWinner).toBe("home"); // resolved via games_won
  });

  it("falls to total_points_scored when points and games won tie", () => {
    // each wins 1 game, 0 consolation -> 2-2 points, 1-1 games. Separate on raw points.
    const games: Game[] = [
      g(1, 1, 1, 11, 0), // home win, away 0
      g(1, 2, 1, 5, 11), // away win, home 5 (<6, no consolation)
    ];
    const { matchTotals, matchWinner } = scoreMatch(games, SIMPLE);
    expect(matchTotals.home.points).toBe(2);
    expect(matchTotals.away.points).toBe(2);
    expect(matchTotals.home.gamesWon).toBe(1);
    expect(matchTotals.away.gamesWon).toBe(1);
    expect(matchTotals.home.pointsScored).toBe(16);
    expect(matchTotals.away.pointsScored).toBe(11);
    expect(matchWinner).toBe("home"); // resolved via total_points_scored
  });

  it("returns a tie only when every rung is level", () => {
    const games: Game[] = [g(1, 1, 1, 11, 5), g(1, 2, 1, 5, 11)];
    // mirror image: 2-2 points, 1-1 games, 16-16 points scored, 1-1 rounds.
    const { matchWinner } = scoreMatch(games, SIMPLE);
    expect(matchWinner).toBe("tie");
  });
});

describe("scoreMatch — ATPL seed match (04/07/2026)", () => {
  // Verified anchor: Other Desert Cities (away) @ Benchies United (home).
  // Source rows were flat line 1..9; map onto rounds via the same slot logic
  // the migration backfill uses.
  const raw: [number, number, number, number][] = [
    // [line, game, away, home]
    [1, 1, 3, 11], [1, 2, 12, 10],
    [2, 1, 10, 12], [2, 2, 7, 11],
    [3, 1, 3, 11], [3, 2, 0, 11],
    [4, 1, 4, 11], [4, 2, 3, 11],
    [5, 1, 11, 4], [5, 2, 11, 2],
    [6, 1, 8, 11], [6, 2, 11, 5],
    [7, 1, 11, 8], [7, 2, 11, 2],
    [8, 1, 11, 8], [8, 2, 11, 9],
    [9, 1, 11, 13], [9, 2, 8, 11],
  ];
  const games: Game[] = raw.map(([line, game, away, home]) => {
    const slot = lineNumberToSlot(line);
    return {
      roundNumber: slot.round,
      lineNumber: slot.homePair,
      gameNumber: game,
      homeScore: home,
      awayScore: away,
    };
  });

  it("scores away 21 / home 24, winner Benchies United (home)", () => {
    const { matchTotals, matchWinner } = scoreMatch(games, ATPL_SCORING_CONFIG);
    expect(matchTotals.away.points).toBe(21);
    expect(matchTotals.home.points).toBe(24);
    expect(matchWinner).toBe("home");
  });

  it("derives the totals from games + consolation (not line wins)", () => {
    const { matchTotals } = scoreMatch(games, ATPL_SCORING_CONFIG);
    expect(matchTotals.away.gamesWon).toBe(8);
    expect(matchTotals.home.gamesWon).toBe(10);
    expect(matchTotals.away.consolationPoints).toBe(5);
    expect(matchTotals.home.consolationPoints).toBe(4);
    expect(matchTotals.away.points).toBe(
      matchTotals.away.gamesWon * 2 + matchTotals.away.consolationPoints,
    );
  });

  it("computes rounds won (home 1, away 1, round 2 split)", () => {
    const { matchTotals } = scoreMatch(games, ATPL_SCORING_CONFIG);
    expect(matchTotals.home.roundsWon).toBe(1);
    expect(matchTotals.away.roundsWon).toBe(1);
  });
});
