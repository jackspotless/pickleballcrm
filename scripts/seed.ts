/**
 * Phase 1 seed: Desert ATPL league, one season, the "Men 18+ Open" division
 * with the ATPL scoring config, 4 teams, and the verified 04/07/2026 match
 * (Other Desert Cities 21 @ Benchies United 24).
 *
 * Seeds over a direct Postgres connection (superuser) so it bypasses PostgREST
 * and RLS — the standard way to seed, and immune to API-key/role churn.
 *   1. supabase start
 *   2. cp .env.local.example .env.local   # DATABASE_URL is the local default
 *   3. npm run db:reset && npm run seed
 */
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { ATPL_SCORING_CONFIG } from "../src/lib/scoring/atpl-config";

loadEnv({ path: ".env.local" });

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const db = new Client({ connectionString });

async function insertId(sql: string, params: unknown[]): Promise<string> {
  const res = await db.query(sql, params);
  return res.rows[0].id as string;
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

/**
 * ATPL line winner: the side that won more games. With tiebreak_game disabled,
 * a level (e.g. 1-1) line has no winner.
 */
function lineWinner(games: [number, number][]): "home" | "away" | "unset" {
  let away = 0;
  let home = 0;
  for (const [a, h] of games) {
    if (a > h) away += 1;
    else if (h > a) home += 1;
  }
  if (away > home) return "away";
  if (home > away) return "home";
  return "unset";
}

async function seed() {
  // --- Tenancy ---------------------------------------------------------------
  const leagueId = await insertId(
    "insert into league (name, subdomain, theme) values ($1, $2, $3) returning id",
    ["Desert ATPL", "desert", "classic"],
  );

  const seasonId = await insertId(
    `insert into season (league_id, name, starts_on, ends_on, status)
     values ($1, $2, $3, $4, $5) returning id`,
    [leagueId, "Spring 2026", "2026-03-01", "2026-06-30", "active"],
  );

  // --- Scoring + division ----------------------------------------------------
  const scoringFormatId = await insertId(
    `insert into scoring_format (league_id, name, config, is_template)
     values ($1, $2, $3::jsonb, $4) returning id`,
    [leagueId, "ATPL Standard", JSON.stringify(ATPL_SCORING_CONFIG), false],
  );

  const divisionId = await insertId(
    `insert into division
       (season_id, name, scoring_format_id, lines, games_per_line, doubles_lines, singles_lines)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [seasonId, "Men 18+ Open", scoringFormatId, 9, 2, 9, 0],
  );

  // --- Teams (the two opponents + two placeholders) --------------------------
  // TODO: replace the placeholder names once the other two teams are confirmed.
  const teamNames = [HOME_TEAM, AWAY_TEAM, "TBD Team 3", "TBD Team 4"];
  const teams: Record<string, string> = {};
  for (const name of teamNames) {
    teams[name] = await insertId(
      "insert into team (division_id, name) values ($1, $2) returning id",
      [divisionId, name],
    );
  }

  // --- Members + rosters -----------------------------------------------------
  const members: Record<string, string> = {}; // surname -> member id
  async function seedRoster(teamName: string, surnames: string[]) {
    for (const surname of surnames) {
      const memberId = await insertId(
        `insert into member (league_id, first_name, last_name, gender)
         values ($1, $2, $3, $4) returning id`,
        [leagueId, "", surname, "M"],
      );
      members[surname] = memberId;
      await db.query(
        "insert into roster_entry (team_id, member_id, position) values ($1, $2, $3)",
        [teams[teamName], memberId, "player"],
      );
    }
  }
  await seedRoster(HOME_TEAM, HOME_PLAYERS);
  await seedRoster(AWAY_TEAM, AWAY_PLAYERS);

  // --- 04/07/2026 match ------------------------------------------------------
  const matchId = await insertId(
    `insert into match (division_id, home_team_id, away_team_id, scheduled_at, week_number, match_type, status)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      divisionId,
      teams[HOME_TEAM],
      teams[AWAY_TEAM],
      "2026-04-07T18:00:00Z",
      1,
      "match",
      "final",
    ],
  );

  for (const line of LINES) {
    const matchLineId = await insertId(
      `insert into match_line
         (match_id, line_number, away_player1_id, away_player2_id, home_player1_id, home_player2_id, winner)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        matchId,
        line.line,
        members[line.away[0]],
        members[line.away[1]],
        members[line.home[0]],
        members[line.home[1]],
        lineWinner(line.games),
      ],
    );
    for (let i = 0; i < line.games.length; i++) {
      const [awayScore, homeScore] = line.games[i];
      await db.query(
        `insert into line_game (match_line_id, game_number, away_score, home_score)
         values ($1, $2, $3, $4)`,
        [matchLineId, i + 1, awayScore, homeScore],
      );
    }
  }

  console.log("✅ Seed complete:", {
    league: leagueId,
    season: seasonId,
    division: divisionId,
    teams: Object.keys(teams).length,
    members: Object.keys(members).length,
    match: matchId,
    lines: LINES.length,
  });
}

async function main() {
  await db.connect();
  try {
    await db.query("begin");
    await seed();
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
