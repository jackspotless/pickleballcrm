import { describe, expect, it } from "vitest";
import { ATPL_SCORING_CONFIG } from "../scoring/atpl-config";
import {
  buildPreview,
  isScorable,
  toEngineGames,
  type LineGameRow,
  type MatchLineRow,
} from "./score-grid";
import { generateSlots, ATPL_ROTATION } from "./rotation";

// Build the 9 rounds-aware match_line rows; fully populate players unless told
// to leave a side null (half-submitted).
function buildLines(opts: { awayNull?: boolean } = {}): MatchLineRow[] {
  return generateSlots(3, 3, ATPL_ROTATION).map((s, i) => ({
    id: `ml-${i}`,
    round_number: s.round,
    home_pair_index: s.homePair,
    away_pair_index: s.awayPair,
    home_player1_id: `h1-${i}`,
    home_player2_id: `h2-${i}`,
    away_player1_id: opts.awayNull ? null : `a1-${i}`,
    away_player2_id: opts.awayNull ? null : `a2-${i}`,
  }));
}

const GPL = 2; // games_per_line

describe("isScorable", () => {
  it("true only when both lineups fully populated", () => {
    expect(isScorable(buildLines())).toBe(true);
  });
  it("false when one side still null (half-submitted)", () => {
    expect(isScorable(buildLines({ awayNull: true }))).toBe(false);
  });
  it("false when there are no lines", () => {
    expect(isScorable([])).toBe(false);
  });
});

describe("buildPreview — partial input never throws, winner withheld until complete", () => {
  const lines = buildLines();

  it("empty scoresheet: totals 0, not complete, no winner", () => {
    const p = buildPreview(lines, [], ATPL_SCORING_CONFIG, GPL);
    expect(p.homePoints).toBe(0);
    expect(p.awayPoints).toBe(0);
    expect(p.entered).toBe(0);
    expect(p.expected).toBe(18);
    expect(p.complete).toBe(false);
    expect(p.winner).toBeNull();
  });

  it("partial scoresheet: running totals computed, winner still withheld", () => {
    // One determined game on round 1 line 1; one game with a null score (skipped).
    const games: LineGameRow[] = [
      { match_line_id: lines[0].id, game_number: 1, home_score: 11, away_score: 6, is_forfeit: false },
      { match_line_id: lines[0].id, game_number: 2, home_score: null, away_score: null, is_forfeit: false },
    ];
    const p = buildPreview(lines, games, ATPL_SCORING_CONFIG, GPL);
    expect(p.entered).toBe(1); // null-score game skipped
    expect(p.homePoints).toBe(2); // one game win = 2 (consolation goes to away at 6)
    expect(p.awayPoints).toBe(1); // away reaches 6 -> consolation 1
    expect(p.perRound).toEqual([{ round: 1, home: 11, away: 6 }]);
    expect(p.complete).toBe(false);
    expect(p.winner).toBeNull(); // VI.E outcome NOT surfaced mid-entry
  });

  it("complete scoresheet: winner is declared", () => {
    // Fill all 18 games; home wins every game 11-0 -> home is the declared winner.
    const games: LineGameRow[] = [];
    for (const l of lines) {
      for (let gn = 1; gn <= GPL; gn++) {
        games.push({ match_line_id: l.id, game_number: gn, home_score: 11, away_score: 0, is_forfeit: false });
      }
    }
    const p = buildPreview(lines, games, ATPL_SCORING_CONFIG, GPL);
    expect(p.entered).toBe(18);
    expect(p.complete).toBe(true);
    expect(p.winner).toBe("home");
  });
});

describe("toEngineGames — mirrors the CI verify mapping", () => {
  it("maps round_number/home_pair_index/game_number and skips null scores", () => {
    const lines = buildLines();
    const games: LineGameRow[] = [
      { match_line_id: lines[4].id, game_number: 2, home_score: 9, away_score: 11, is_forfeit: false },
      { match_line_id: lines[4].id, game_number: 1, home_score: null, away_score: 7, is_forfeit: false },
    ];
    const mapped = toEngineGames(lines, games);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toEqual({
      roundNumber: lines[4].round_number,
      lineNumber: lines[4].home_pair_index,
      gameNumber: 2,
      homeScore: 9,
      awayScore: 11,
    });
  });
});
