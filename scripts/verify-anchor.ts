/**
 * End-to-end anchor + structure check: read the seeded 04/07/2026 match back
 * out of Postgres, score it with the *stored* config via the real engine, and
 * assert away 21 / home 24, winner Benchies United — AND that the rounds-aware
 * match_line rows carry correct per-row round/pair values (not a uniform
 * backfill). Guards schema, seed, and engine drift. Run after `npm run seed`.
 */
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { scoreMatch } from "../src/lib/scoring/engine";
import { ATPL_ROTATION } from "../src/lib/match/rotation";
import type { Game, ScoringConfig } from "../src/lib/scoring/types";

loadEnv({ path: ".env.local" });

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const db = new Client({ connectionString });

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  await db.connect();
  try {
    const matchRes = await db.query(
      `select m.id,
              home.name as home_name,
              away.name as away_name,
              sf.config as config
       from match m
       join team home on home.id = m.home_team_id
       join team away on away.id = m.away_team_id
       join division d on d.id = m.division_id
       join scoring_format sf on sf.id = d.scoring_format_id
       where m.status = 'final'
       limit 1`,
    );
    if (matchRes.rowCount === 0) fail("no final match found");
    const { id, home_name, away_name, config } = matchRes.rows[0] as {
      id: string;
      home_name: string;
      away_name: string;
      config: ScoringConfig;
    };

    // --- Per-row structure check (rounds-aware integrity) --------------------
    const linesRes = await db.query(
      `select round_number, home_pair_index, away_pair_index
       from match_line where match_id = $1
       order by round_number, home_pair_index`,
      [id],
    );
    const lines = linesRes.rows as {
      round_number: number;
      home_pair_index: number;
      away_pair_index: number;
    }[];

    if (lines.length !== 9) fail(`expected 9 match_line rows, got ${lines.length}`);
    const seen = new Set<string>();
    const perRound: Record<number, number> = {};
    for (const l of lines) {
      const key = `${l.round_number}-${l.home_pair_index}`;
      if (seen.has(key)) fail(`duplicate (round, home_pair) ${key}`);
      seen.add(key);
      perRound[l.round_number] = (perRound[l.round_number] ?? 0) + 1;
      const expectedAway = ATPL_ROTATION[String(l.round_number)]?.[String(l.home_pair_index)];
      if (l.away_pair_index !== expectedAway) {
        fail(
          `round ${l.round_number} home pair ${l.home_pair_index}: away_pair ${l.away_pair_index} != rotation ${expectedAway}`,
        );
      }
    }
    if (seen.size !== 9) fail("match_line rows are not 9 distinct (round, home_pair) slots");
    for (const r of [1, 2, 3]) {
      if (perRound[r] !== 3) fail(`round ${r} has ${perRound[r] ?? 0} lines, expected 3`);
    }
    console.log("match_line rows (round, home_pair, away_pair) — validated vs rotation:");
    for (const l of lines) {
      console.log(
        `  round ${l.round_number}  home_pair ${l.home_pair_index} -> away_pair ${l.away_pair_index}`,
      );
    }

    // --- Scoring check -------------------------------------------------------
    const gamesRes = await db.query(
      `select ml.round_number, ml.home_pair_index, lg.game_number, lg.home_score, lg.away_score
       from match_line ml
       join line_game lg on lg.match_line_id = ml.id
       where ml.match_id = $1`,
      [id],
    );
    const games: Game[] = gamesRes.rows.map((r) => ({
      roundNumber: r.round_number,
      lineNumber: r.home_pair_index,
      gameNumber: r.game_number,
      homeScore: r.home_score,
      awayScore: r.away_score,
    }));

    const { matchTotals, matchWinner } = scoreMatch(games, config);
    const winnerName =
      matchWinner === "home" ? home_name : matchWinner === "away" ? away_name : "TIE";

    console.log(
      `Anchor: ${away_name} ${matchTotals.away.points} @ ${home_name} ${matchTotals.home.points} — winner ${winnerName} (rounds won ${matchTotals.home.roundsWon}-${matchTotals.away.roundsWon})`,
    );

    if (matchTotals.away.points !== 21 || matchTotals.home.points !== 24) {
      fail(`expected away 21 / home 24, got away ${matchTotals.away.points} / home ${matchTotals.home.points}`);
    }
    if (winnerName !== "Benchies United") fail(`winner ${winnerName}, expected Benchies United`);
    if (matchTotals.home.roundsWon !== 1 || matchTotals.away.roundsWon !== 1) {
      fail(`expected rounds won 1-1, got ${matchTotals.home.roundsWon}-${matchTotals.away.roundsWon}`);
    }

    console.log(
      "✅ 21/24 anchor + rounds-aware structure verified end-to-end (DB seed + stored config + engine).",
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
