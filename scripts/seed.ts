/**
 * Phase 1+2 seed: Desert ATPL league, season (under the ATPL rule_set), the
 * "Men 18+ Open" division, 4 teams, and the verified 04/07/2026 match
 * (Other Desert Cities 21 @ Benchies United 24), generated rounds-aware.
 *
 * Seeds over a direct Postgres connection (superuser) so it bypasses PostgREST
 * and RLS. Run after `npm run db:reset` on a fresh DB.
 */
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { ATPL_SCORING_CONFIG } from "../src/lib/scoring/atpl-config";
import { ATPL_ROTATION, generateSlots } from "../src/lib/match/rotation";

loadEnv({ path: ".env.local" });

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const db = new Client({ connectionString });

async function insertId(sql: string, params: unknown[]): Promise<string> {
  const res = await db.query(sql, params);
  return res.rows[0].id as string;
}

// --- ATPL rule_set structure (drives §1 row generation) ---------------------
const ATPL_STRUCTURE = {
  rounds: 3,
  lines_per_round: 3,
  games_per_line: 2,
  rotation: ATPL_ROTATION,
};
const ATPL_HUMAN_RULES = {
  subs: "one sub/match, pre-listed, injury/illness/lateness only (VI.G)",
  min_age: 18,
  waiver: "e-sign before first match each season (II.B.1)",
};

// --- Verified 04/07/2026 match ----------------------------------------------
const HOME_TEAM = "Benchies United";
const AWAY_TEAM = "Other Desert Cities";
// First names were not in the source; surnames are stored as last_name.
// Pair index 1..3 -> [player a, player b].
const HOME_PAIRS: Record<number, [string, string]> = {
  1: ["Mercado", "Donovan"],
  2: ["Tejada", "Elias"],
  3: ["Michaud", "Rahman"],
};
const AWAY_PAIRS: Record<number, [string, string]> = {
  1: ["Gruwell", "Prusso"],
  2: ["Saenz", "Devane"],
  3: ["Purcell", "Lynch"],
};
// Scores keyed by `${round}-${homePairIndex}` as [awayScore, homeScore] per game.
const SCORES: Record<string, [number, number][]> = {
  "1-1": [[3, 11], [12, 10]],
  "1-2": [[10, 12], [7, 11]],
  "1-3": [[3, 11], [0, 11]],
  "2-1": [[4, 11], [3, 11]],
  "2-2": [[11, 4], [11, 2]],
  "2-3": [[8, 11], [11, 5]],
  "3-1": [[11, 8], [11, 2]],
  "3-2": [[11, 8], [11, 9]],
  "3-3": [[11, 13], [8, 11]],
};

/** ATPL line winner: majority of games; tiebreak_game disabled => split = unset. */
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
  // --- Tenancy + rule set ----------------------------------------------------
  const leagueId = await insertId(
    "insert into league (name, subdomain, theme) values ($1, $2, $3) returning id",
    ["Desert ATPL", "desert", "classic"],
  );

  const scoringFormatId = await insertId(
    `insert into scoring_format (league_id, name, config, is_template)
     values ($1, $2, $3::jsonb, $4) returning id`,
    [leagueId, "ATPL Standard", JSON.stringify(ATPL_SCORING_CONFIG), false],
  );

  const ruleSetId = await insertId(
    `insert into rule_set (league_id, name, scoring_format_id, structure, human_rules, is_template)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id`,
    [
      leagueId,
      "ATPL",
      scoringFormatId,
      JSON.stringify(ATPL_STRUCTURE),
      JSON.stringify(ATPL_HUMAN_RULES),
      false,
    ],
  );

  const seasonId = await insertId(
    `insert into season (league_id, rule_set_id, name, starts_on, ends_on, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [leagueId, ruleSetId, "Spring 2026", "2026-03-01", "2026-06-30", "active"],
  );

  const divisionId = await insertId(
    `insert into division (season_id, name, scoring_format_id)
     values ($1, $2, $3) returning id`,
    [seasonId, "Men 18+ Open", scoringFormatId],
  );

  // --- Teams (the two opponents + two placeholders) --------------------------
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
  await seedRoster(HOME_TEAM, Object.values(HOME_PAIRS).flat());
  await seedRoster(AWAY_TEAM, Object.values(AWAY_PAIRS).flat());

  // --- 04/07/2026 match ------------------------------------------------------
  const matchId = await insertId(
    `insert into match (division_id, home_team_id, away_team_id, scheduled_at, week_number, match_type, status)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [divisionId, teams[HOME_TEAM], teams[AWAY_TEAM], "2026-04-07T18:00:00Z", 1, "match", "final"],
  );

  // Generate the 9 rounds-aware match_line rows from the rule_set rotation.
  const slots = generateSlots(
    ATPL_STRUCTURE.rounds,
    ATPL_STRUCTURE.lines_per_round,
    ATPL_STRUCTURE.rotation,
  );
  for (const slot of slots) {
    const games = SCORES[`${slot.round}-${slot.homePair}`];
    const [hp1, hp2] = HOME_PAIRS[slot.homePair];
    const [ap1, ap2] = AWAY_PAIRS[slot.awayPair];
    const matchLineId = await insertId(
      `insert into match_line
         (match_id, round_number, home_pair_index, away_pair_index,
          home_player1_id, home_player2_id, away_player1_id, away_player2_id, winner)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        matchId, slot.round, slot.homePair, slot.awayPair,
        members[hp1], members[hp2], members[ap1], members[ap2],
        lineWinner(games),
      ],
    );
    for (let i = 0; i < games.length; i++) {
      const [awayScore, homeScore] = games[i];
      await db.query(
        `insert into line_game (match_line_id, game_number, away_score, home_score)
         values ($1, $2, $3, $4)`,
        [matchLineId, i + 1, awayScore, homeScore],
      );
    }
  }

  console.log("✅ Seed complete:", {
    league: leagueId,
    rule_set: ruleSetId,
    season: seasonId,
    division: divisionId,
    teams: Object.keys(teams).length,
    members: Object.keys(members).length,
    match: matchId,
    match_lines: slots.length,
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
