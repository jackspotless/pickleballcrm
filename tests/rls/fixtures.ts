/**
 * RLS behavioral-harness fixtures: two leagues so tenant isolation is testable.
 *
 * League A: commissioner Cα; team A-home (captain Ka_home), team A-away
 * (captain Ka_away); match Ma with a match_line + line_game; plain member Pα
 * (rostered, NO write permission — isolates in-tenant authz from isolation).
 * League B: division/team/match Mb + match_line; member Pβ (for FK-value tests).
 *
 * auth.users rows are inserted as superuser and linked via member.auth_user_id,
 * so the harness can assume each identity by setting request.jwt.claims.sub.
 */
import type { Client } from "pg";

export interface Fixtures {
  // auth user ids (used as the JWT `sub`)
  uCommA: string;
  uKaHome: string;
  uKaAway: string;
  uPa: string;
  // entities
  divB: string;
  Ma: string;
  mlMa: string;
  lgA: string;
  mlMb: string;
  teamAHome: string;
  Pb: string; // league-B member, for FK-value triggers
}

async function one(db: Client, sql: string, params: unknown[] = []): Promise<string> {
  const r = await db.query(sql, params);
  return r.rows[0].id as string;
}

async function newAuthUser(db: Client, email: string): Promise<string> {
  return one(
    db,
    `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values
       (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', $1, '', '{}', '{}', now(), now())
     returning id`,
    [email],
  );
}

async function addMember(
  db: Client,
  leagueId: string,
  authUserId: string | null,
  last: string,
): Promise<string> {
  return one(
    db,
    `insert into member (league_id, auth_user_id, first_name, last_name, gender)
     values ($1, $2, '', $3, 'M') returning id`,
    [leagueId, authUserId, last],
  );
}

export async function cleanFixtures(db: Client): Promise<void> {
  // Leagues cascade to members/teams/matches/etc.; then drop the auth users.
  await db.query("delete from league where subdomain in ('alpha', 'beta')");
  await db.query("delete from auth.users where email like '%@rlsharness.local'");
}

export async function loadFixtures(db: Client): Promise<Fixtures> {
  await cleanFixtures(db);

  // ---- League A ----
  const leagueA = await one(
    db,
    "insert into league (name, subdomain) values ('Alpha', 'alpha') returning id",
  );
  const sfA = await one(
    db,
    "insert into scoring_format (league_id, name, config) values ($1, 'sf', '{}'::jsonb) returning id",
    [leagueA],
  );
  const seasonA = await one(
    db,
    "insert into season (league_id, name) values ($1, 'S') returning id",
    [leagueA],
  );
  const divA = await one(
    db,
    "insert into division (season_id, name, scoring_format_id) values ($1, 'D', $2) returning id",
    [seasonA, sfA],
  );

  // commissioner Cα
  const uCommA = await newAuthUser(db, "comm-a@rlsharness.local");
  const commMemberA = await addMember(db, leagueA, uCommA, "CommA");
  const roleA = await one(
    db,
    `insert into role (league_id, name, permissions)
     values ($1, 'Commissioner', '{"commissioner": true}'::jsonb) returning id`,
    [leagueA],
  );
  await db.query("insert into member_role (member_id, role_id) values ($1, $2)", [
    commMemberA,
    roleA,
  ]);

  // captains + plain member
  const uKaHome = await newAuthUser(db, "ka-home@rlsharness.local");
  const kaHome = await addMember(db, leagueA, uKaHome, "KaHome");
  const uKaAway = await newAuthUser(db, "ka-away@rlsharness.local");
  const kaAway = await addMember(db, leagueA, uKaAway, "KaAway");
  const uPa = await newAuthUser(db, "pa@rlsharness.local");
  await addMember(db, leagueA, uPa, "Pa"); // plain rostered player, no role/captaincy

  const teamAHome = await one(
    db,
    "insert into team (division_id, name, captain_member_id) values ($1, 'A-home', $2) returning id",
    [divA, kaHome],
  );
  const teamAAway = await one(
    db,
    "insert into team (division_id, name, captain_member_id) values ($1, 'A-away', $2) returning id",
    [divA, kaAway],
  );

  const Ma = await one(
    db,
    `insert into match (division_id, home_team_id, away_team_id, status)
     values ($1, $2, $3, 'scheduled') returning id`,
    [divA, teamAHome, teamAAway],
  );
  const mlMa = await one(
    db,
    `insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
     values ($1, 1, 1, 1) returning id`,
    [Ma],
  );
  const lgA = await one(
    db,
    "insert into line_game (match_line_id, game_number, home_score, away_score) values ($1, 1, 0, 0) returning id",
    [mlMa],
  );

  // ---- League B ----
  const leagueB = await one(
    db,
    "insert into league (name, subdomain) values ('Beta', 'beta') returning id",
  );
  const sfB = await one(
    db,
    "insert into scoring_format (league_id, name, config) values ($1, 'sf', '{}'::jsonb) returning id",
    [leagueB],
  );
  const seasonB = await one(
    db,
    "insert into season (league_id, name) values ($1, 'S') returning id",
    [leagueB],
  );
  const divB = await one(
    db,
    "insert into division (season_id, name, scoring_format_id) values ($1, 'D', $2) returning id",
    [seasonB, sfB],
  );
  const teamB = await one(
    db,
    "insert into team (division_id, name) values ($1, 'B') returning id",
    [divB],
  );
  const Mb = await one(
    db,
    "insert into match (division_id, home_team_id, status) values ($1, $2, 'scheduled') returning id",
    [divB, teamB],
  );
  const mlMb = await one(
    db,
    `insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
     values ($1, 1, 1, 1) returning id`,
    [Mb],
  );
  const Pb = await addMember(db, leagueB, null, "Pb");

  return {
    uCommA,
    uKaHome,
    uKaAway,
    uPa,
    divB,
    Ma,
    mlMa,
    lgA,
    mlMb,
    teamAHome,
    Pb,
  };
}
