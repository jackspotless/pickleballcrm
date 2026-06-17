/**
 * End-to-end anchor check: read the seeded 04/07/2026 match back out of
 * Postgres, score it with the *stored* scoring_format config via the real
 * engine, and assert away 21 / home 24, winner Benchies United.
 *
 * This guards against silent drift in the schema, the seed, OR the engine —
 * any of them breaking the anchor fails CI. Run after `npm run seed`.
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { scoreMatch } from "../src/lib/scoring/engine";
import type { Game, ScoringConfig } from "../src/lib/scoring/types";

loadEnv({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
  );
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface MatchRow {
  id: string;
  home_team: { name: string };
  away_team: { name: string };
  division: { scoring_format: { config: ScoringConfig } };
}

async function main() {
  const matchRes = await db
    .from("match")
    .select(
      `id,
       home_team:home_team_id ( name ),
       away_team:away_team_id ( name ),
       division:division_id ( scoring_format:scoring_format_id ( config ) )`,
    )
    .eq("status", "final")
    .limit(1)
    .single();
  if (matchRes.error || !matchRes.data) {
    throw new Error(`load match: ${matchRes.error?.message ?? "not found"}`);
  }
  const match = matchRes.data as unknown as MatchRow;

  const config = match.division.scoring_format.config;
  const homeName = match.home_team.name;
  const awayName = match.away_team.name;

  const linesRes = await db
    .from("match_line")
    .select("id, line_number")
    .eq("match_id", match.id);
  if (linesRes.error || !linesRes.data) {
    throw new Error(`load lines: ${linesRes.error?.message ?? "none"}`);
  }
  const lineNumberById = new Map<string, number>(
    linesRes.data.map((l) => [l.id as string, l.line_number as number]),
  );

  const gamesRes = await db
    .from("line_game")
    .select("match_line_id, game_number, home_score, away_score")
    .in("match_line_id", [...lineNumberById.keys()]);
  if (gamesRes.error || !gamesRes.data) {
    throw new Error(`load games: ${gamesRes.error?.message ?? "none"}`);
  }

  const games: Game[] = gamesRes.data.map((g) => ({
    lineNumber: lineNumberById.get(g.match_line_id as string)!,
    gameNumber: g.game_number as number,
    homeScore: g.home_score as number,
    awayScore: g.away_score as number,
  }));

  const { matchTotals, matchWinner } = scoreMatch(games, config);
  const winnerName =
    matchWinner === "home"
      ? homeName
      : matchWinner === "away"
        ? awayName
        : "TIE";

  console.log(
    `Anchor: ${awayName} ${matchTotals.away.points} @ ${homeName} ${matchTotals.home.points} — winner ${winnerName}`,
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
