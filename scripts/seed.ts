/**
 * Phase 1 seed: Desert ATPL league, one season, the "Men 18+ Open" division
 * with the ATPL scoring config, 4 teams, and the verified 04/07/2026 match.
 *
 * Runs against LOCAL Supabase with the SERVICE ROLE key (bypasses RLS).
 *   1. supabase start
 *   2. cp .env.local.example .env.local  # paste keys from `supabase start`
 *   3. npm run seed
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ATPL_SCORING_CONFIG } from "../src/lib/scoring/atpl-config";

loadEnv({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function insert<T>(table: string, row: object): Promise<T> {
  const { data, error } = await db
    .from(table)
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data as T;
}

async function main() {
  // --- Tenancy ---------------------------------------------------------------
  const league = await insert<{ id: string }>("league", {
    name: "Desert ATPL",
    subdomain: "desert",
    theme: "classic",
  });

  const season = await insert<{ id: string }>("season", {
    league_id: league.id,
    name: "Spring 2026",
    starts_on: "2026-03-01",
    ends_on: "2026-06-30",
    status: "active",
  });

  // --- Scoring + division ----------------------------------------------------
  const scoringFormat = await insert<{ id: string }>("scoring_format", {
    league_id: league.id,
    name: "ATPL Standard",
    config: ATPL_SCORING_CONFIG,
    is_template: false,
  });

  const division = await insert<{ id: string }>("division", {
    season_id: season.id,
    name: "Men 18+ Open",
    scoring_format_id: scoringFormat.id,
    lines: 9,
    games_per_line: 2,
    doubles_lines: 9,
    singles_lines: 0,
  });

  // --- Teams -----------------------------------------------------------------
  // TODO: replace the three placeholder names with the real opponents from
  // pickleballscores.com. "Benchies United" is the verified match winner (home).
  const teamNames = [
    "Benchies United",
    "TBD Team 2",
    "TBD Team 3",
    "TBD Team 4",
  ];
  const teams: Record<string, string> = {};
  for (const name of teamNames) {
    const t = await insert<{ id: string }>("team", {
      division_id: division.id,
      name,
    });
    teams[name] = t.id;
  }

  // --- 04/07/2026 match ------------------------------------------------------
  // Benchies United is home (24) and beat the away side (21).
  const match = await insert<{ id: string }>("match", {
    division_id: division.id,
    home_team_id: teams["Benchies United"],
    away_team_id: teams["TBD Team 2"], // TODO: real opponent
    scheduled_at: "2026-04-07T18:00:00Z",
    week_number: 1,
    match_type: "match",
    status: "final",
  });

  // TODO: paste the verified 9 lines from pickleballscores.com here.
  // Each line: line_number, player ids (optional in Phase 1), and the games.
  // Shape, ready to fill:
  //   { lineNumber: 1, games: [ { game: 1, home: 11, away: 7 },
  //                             { game: 2, home: 11, away: 9 } ] },
  const PLACEHOLDER_LINES: {
    lineNumber: number;
    games: { game: number; home: number; away: number }[];
  }[] = [];

  for (const line of PLACEHOLDER_LINES) {
    const ml = await insert<{ id: string }>("match_line", {
      match_id: match.id,
      line_number: line.lineNumber,
    });
    for (const g of line.games) {
      await insert("line_game", {
        match_line_id: ml.id,
        game_number: g.game,
        home_score: g.home,
        away_score: g.away,
      });
    }
  }

  if (PLACEHOLDER_LINES.length === 0) {
    console.warn(
      "⚠️  Seeded league/season/division/teams/match shell, but NO line scores " +
        "yet — fill PLACEHOLDER_LINES with the verified 04/07/2026 data.",
    );
  }

  console.log("✅ Seed complete:", {
    league: league.id,
    season: season.id,
    division: division.id,
    teams: Object.keys(teams).length,
    match: match.id,
    lines: PLACEHOLDER_LINES.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
