/**
 * End-to-end anchor check: read the seeded 04/07/2026 match back out of
 * Postgres, score it with the *stored* scoring_format config via the real
 * engine, and assert away 21 / home 24, winner Benchies United.
 *
 * Guards against silent drift in the schema, the seed, OR the engine — any of
 * them breaking the anchor fails CI. Run after `npm run seed`.
 */
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { scoreMatch } from "../src/lib/scoring/engine";
import type { Game, ScoringConfig } from "../src/lib/scoring/types";

loadEnv({ path: ".env.local" });

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const db = new Client({ connectionString });

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
    if (matchRes.rowCount === 0) throw new Error("no final match found");
    const { id, home_name, away_name, config } = matchRes.rows[0] as {
      id: string;
      home_name: string;
      away_name: string;
      config: ScoringConfig;
    };

    const gamesRes = await db.query(
      `select ml.line_number, lg.game_number, lg.home_score, lg.away_score
       from match_line ml
       join line_game lg on lg.match_line_id = ml.id
       where ml.match_id = $1`,
      [id],
    );
    const games: Game[] = gamesRes.rows.map((r) => ({
      lineNumber: r.line_number,
      gameNumber: r.game_number,
      homeScore: r.home_score,
      awayScore: r.away_score,
    }));

    const { matchTotals, matchWinner } = scoreMatch(games, config);
    const winnerName =
      matchWinner === "home"
        ? home_name
        : matchWinner === "away"
          ? away_name
          : "TIE";

    console.log(
      `Anchor: ${away_name} ${matchTotals.away.points} @ ${home_name} ${matchTotals.home.points} — winner ${winnerName}`,
    );

    const ok =
      matchTotals.away.points === 21 &&
      matchTotals.home.points === 24 &&
      winnerName === "Benchies United";

    if (!ok) {
      console.error(
        "❌ Anchor mismatch — expected away 21 / home 24, winner Benchies United.",
      );
      process.exit(1);
    }
    console.log(
      "✅ 21/24 anchor verified end-to-end (DB seed + stored config + engine).",
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
