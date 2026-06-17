/**
 * Phase 1 seed: Desert ATPL league, one season, the "Men 18+ Open" division
 * with the ATPL scoring config, 4 teams, and the verified 04/07/2026 match
 * (Other Desert Cities 21 @ Benchies United 24).
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
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data as T;
}

// --- Verified 04/07/2026 match ----------------------------------------------
// Pairs are stable across the match. Scores are [away, home] per game.
const HOME_TEAM = "Benchies United";
const AWAY_TEAM = "Other Desert Cities";
// First names were not in the source; surnames are stored as last_name.
const HOME_PLAYERS = ["Mercado", "Donovan", "Tejada", "Elias", "Michaud", "Rahman"];
const AWAY_PLAYERS = ["Gruwell", "Prusso", "Saenz", "Devane", "Purcell", "Lynch"];

type LineSeed = {
  line: number;
  away: [string, string];
  home: [string, string];
  games: [number, number][]; // [awayScore, homeScore]
};

const LINES: LineSeed[] = [
  { line: 1, away: ["Gruwell", "Prusso"], home: ["Mercado", "Donovan"], games: [[3, 11], [12, 10]] },
  { line: 2, away: ["Saenz", "Devane"], home: ["Tejada", "Elias"], games: [[10, 12], [7, 11]] },
  { line: 3, away: ["Purcell", "Lynch"], home: ["Michaud", "Rahman"], games: [[3, 11], [0, 11]] },
  { line: 4, away: ["Saenz", "Devane"], home: ["Mercado", "Donovan"], games: [[4, 11], [3, 11]] },
  { line: 5, away: ["Purcell", "Lynch"], home: ["Tejada", "Elias"], games: [[11, 4], [11, 2]] },
  { line: 6, away: ["Gruwell", "Prusso"], home: ["Michaud", "Rahman"], games: [[8, 11], [11, 5]] },
  { line: 7, away: ["Purcell", "Lynch"], home: ["Mercado", "Donovan"], games: [[11, 8], [11, 2]] },
  { line: 8, away: ["Gruwell", "Prusso"], home: ["Tejada", "Elias"], games: [[11, 8], [11, 9]] },
  { line: 9, away: ["Saenz", "Devane"], home: ["Michaud", "Rahman"], games: [[11, 13], [8, 11]] },
];

/** ATPL line winner: more games won; a 1-1 split is decided by the last game. */
function lineWinner(games: [number, number][]): "home" | "away" | "unset" {
  let away = 0;
  let home = 0;
  for (const [a, h] of games) {
    if (a > h) away += 1;
    else if (h > a) home += 1;
  }
  if (away > home) return "away";
  if (home > away) return "home";
  const [la, lh] = games[games.length - 1];
  if (la > lh) return "away";
  if (lh > la) return "home";
  return "unset";
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

  // --- Teams (the two opponents from this match + two placeholders) ----------
  // TODO: replace the placeholder names once the other two teams are confirmed.
  const teamNames = [HOME_TEAM, AWAY_TEAM, "TBD Team 3", "TBD Team 4"];
  const teams: Record<string, string> = {};
  for (const name of teamNames) {
    const t = await insert<{ id: string }>("team", {
      division_id: division.id,
      name,
    });
    teams[name] = t.id;
  }

  // --- Members + rosters -----------------------------------------------------
  const members: Record<string, string> = {}; // surname -> member id
  async function seedRoster(teamName: string, surnames: string[]) {
    for (const surname of surnames) {
      const m = await insert<{ id: string }>("member", {
        league_id: league.id,
        first_name: "",
        last_name: surname,
        gender: "M",
      });
      members[surname] = m.id;
      await insert("roster_entry", {
        team_id: teams[teamName],
        member_id: m.id,
        position: "player",
      });
    }
  }
  await seedRoster(HOME_TEAM, HOME_PLAYERS);
  await seedRoster(AWAY_TEAM, AWAY_PLAYERS);

  // --- 04/07/2026 match ------------------------------------------------------
  const match = await insert<{ id: string }>("match", {
    division_id: division.id,
    home_team_id: teams[HOME_TEAM],
    away_team_id: teams[AWAY_TEAM],
    scheduled_at: "2026-04-07T18:00:00Z",
    week_number: 1,
    match_type: "match",
    status: "final",
  });

  for (const line of LINES) {
    const ml = await insert<{ id: string }>("match_line", {
      match_id: match.id,
      line_number: line.line,
      away_player1_id: members[line.away[0]],
      away_player2_id: members[line.away[1]],
      home_player1_id: members[line.home[0]],
      home_player2_id: members[line.home[1]],
      winner: lineWinner(line.games),
    });
    for (let i = 0; i < line.games.length; i++) {
      const [awayScore, homeScore] = line.games[i];
      await insert("line_game", {
        match_line_id: ml.id,
        game_number: i + 1,
        away_score: awayScore,
        home_score: homeScore,
      });
    }
  }

  console.log("✅ Seed complete:", {
    league: league.id,
    season: season.id,
    division: division.id,
    teams: Object.keys(teams).length,
    members: Object.keys(members).length,
    match: match.id,
    lines: LINES.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
