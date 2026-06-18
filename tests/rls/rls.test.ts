/**
 * RLS behavioral harness — proves the write/permission layer *behaves* under
 * real auth, not just that the migration applies. Each case assumes an identity
 * by setting request.jwt.claims.sub (the same claim shape Supabase Auth emits)
 * inside a rolled-back transaction, and asserts the SPECIFIC failure mode:
 *   - 42501  -> RLS with-check rejected the write (a throw)
 *   - P0001  -> a FK-value trigger raised
 *   - rowCount 0 -> RLS `using` made the row invisible to the write (no throw)
 * "Denied this way" is the assertion; "denied somehow" would hide a regression
 * where a throw silently degrades to a 0-row no-op.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { loadFixtures, type Fixtures } from "./fixtures";

const db = new Client({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

let fx: Fixtures;

beforeAll(async () => {
  await db.connect();
  fx = await loadFixtures(db);
});

afterAll(async () => {
  await db.end();
});

/** Run fn as an authenticated user (jwt sub), rolling back any writes. */
async function asUser(sub: string, fn: () => Promise<void>) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub, role: "authenticated" }),
    ]);
    await fn();
  } finally {
    await db.query("rollback");
  }
}

/** Run fn as the real anonymous role (a true unauthenticated request). */
async function asAnon(fn: () => Promise<void>) {
  await db.query("begin");
  try {
    await db.query("set local role anon");
    await fn();
  } finally {
    await db.query("rollback");
  }
}

/**
 * Assert the next write throws with a specific SQLSTATE *and* mechanism.
 * 42501 is shared by RLS-with-check ("new row violates row-level security…")
 * and missing-grant ("permission denied for table…"), so the message matcher
 * is required — it's what distinguishes "denied by policy" from "denied by a
 * missing grant" (the collision that false-passed cases 4/6 before grants).
 */
async function expectSqlState(
  code: string,
  messageRe: RegExp,
  fn: () => Promise<unknown>,
) {
  let err: { code?: string; message?: string } | undefined;
  try {
    await fn();
  } catch (e) {
    err = e as { code?: string; message?: string };
  }
  if (!err) throw new Error(`expected SQLSTATE ${code}, but the write succeeded`);
  expect(err.code).toBe(code);
  expect(err.message ?? "").toMatch(messageRe);
}

describe("RLS write/permission matrix", () => {
  it("1. captain writes OWN match scores -> PASS", async () => {
    await asUser(fx.uKaHome, async () => {
      const r = await db.query(
        "update line_game set home_score = 11 where id = $1",
        [fx.lgScore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("2. OPPOSING captain writes scores -> PASS (proves either-captain)", async () => {
    await asUser(fx.uKaAway, async () => {
      const r = await db.query(
        "update line_game set away_score = 11 where id = $1",
        [fx.lgScore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("3. wrong role, RIGHT league (rostered player, no perm) -> DENY (rowCount 0)", async () => {
    await asUser(fx.uPa, async () => {
      const r = await db.query(
        "update line_game set home_score = 7 where id = $1",
        [fx.lgScore],
      );
      // RLS `using` (can_write_match) hides the row from this writer — not a throw.
      expect(r.rowCount).toBe(0);
    });
  });

  it("4. captain writes ANOTHER league's match -> DENY by RLS with-check (42501 + RLS message)", async () => {
    await asUser(fx.uKaHome, async () => {
      // distinguish RLS-with-check from a missing-grant 42501 via the message
      await expectSqlState("42501", /row-level security/, () =>
        db.query(
          `insert into line_game (match_line_id, game_number, home_score, away_score)
           values ($1, 9, 11, 0)`,
          [fx.mlMb],
        ),
      );
    });
  });

  it("5. commissioner unrestricted IN league -> PASS", async () => {
    await asUser(fx.uCommA, async () => {
      const r = await db.query(
        "update match set week_number = 2 where id = $1",
        [fx.Ma],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("6. commissioner writes ANOTHER league -> DENY by RLS with-check (42501 + RLS message)", async () => {
    await asUser(fx.uCommA, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query("insert into match (division_id, status) values ($1, 'scheduled')", [
          fx.divB,
        ]),
      );
    });
  });

  it("7. FK-value trigger: foreign-league player into match_line -> RAISE (P0001)", async () => {
    await asUser(fx.uCommA, async () => {
      // RLS passes (commissioner of Ma's league); the trigger must still fire.
      await expectSqlState("P0001", /player must belong to the match league/, () =>
        db.query(
          `insert into match_line (match_id, round_number, home_pair_index, away_pair_index, home_player1_id)
           values ($1, 1, 2, 2, $2)`,
          [fx.Ma, fx.Pb],
        ),
      );
    });
  });

  it("8. FK-value trigger: foreign-league member into roster_entry -> RAISE (P0001)", async () => {
    await asUser(fx.uCommA, async () => {
      await expectSqlState("P0001", /member must belong to the team league/, () =>
        db.query(
          "insert into roster_entry (team_id, member_id) values ($1, $2)",
          [fx.teamAHome, fx.Pb],
        ),
      );
    });
  });

  it("9. anon (real anon role) cannot write -> DENY at grant level (42501 + permission-denied message)", async () => {
    await asAnon(async () => {
      // anon has no write grant at all — denied before RLS, by privilege.
      await expectSqlState("42501", /permission denied for table/, () =>
        db.query(
          `insert into line_game (match_line_id, game_number, home_score, away_score)
           values ($1, 9, 11, 0)`,
          [fx.mlMa],
        ),
      );
    });
  });

  it("10. cross-league read of full member row -> DENY (rowCount 0)", async () => {
    await asUser(fx.uPa, async () => {
      const r = await db.query("select id from member where id = $1", [fx.Pb]);
      expect(r.rowCount).toBe(0);
    });
  });

  it("11. anon can still read the public view-layer (positive control)", async () => {
    await asAnon(async () => {
      const r = await db.query("select id from match where id = $1", [fx.Ma]);
      expect(r.rowCount).toBe(1);
    });
  });
});

// Scheduling screen (PR #3) writes `match` directly. The complete authz story
// for that write path lives here in full — intentionally duplicated rather than
// referencing the general cross-league case, so a refactor elsewhere can't
// silently strip coverage this file appears to have.
describe("scheduling: match write path", () => {
  it("S1. commissioner creates a match in their OWN league -> PASS", async () => {
    await asUser(fx.uCommA, async () => {
      const r = await db.query(
        "insert into match (division_id, status) values ($1, 'scheduled')",
        [fx.divA],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("S2. captain creates a match -> DENY by RLS with-check (42501 + RLS message)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query("insert into match (division_id, status) values ($1, 'scheduled')", [
          fx.divA,
        ]),
      );
    });
  });

  it("S3. commissioner creates a match in ANOTHER league -> DENY (42501 + RLS message)", async () => {
    await asUser(fx.uCommA, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query("insert into match (division_id, status) values ($1, 'scheduled')", [
          fx.divB,
        ]),
      );
    });
  });
});

// Lineup (PR #4) writes match_line only through submit_lineup(). Captains have
// no direct match_line write, so the RPC's side-ownership check IS the column
// boundary. The full authz story for that write path lives here.
describe("lineup: submit_lineup write path", () => {
  const lineup = (match: string, side: string, pairs: string[]) =>
    db.query("select submit_lineup($1, $2, $3)", [match, side, pairs]);

  it("L1. home captain submits OWN side -> PASS (9 rows, home set, away null)", async () => {
    await asUser(fx.uKaHome, async () => {
      await lineup(fx.Ma, "home", fx.playersA);
      const rows = await db.query(
        "select home_player1_id, away_player1_id from match_line where match_id = $1",
        [fx.Ma],
      );
      expect(rows.rowCount).toBe(9);
      expect(rows.rows.every((r) => r.home_player1_id !== null)).toBe(true);
      expect(rows.rows.every((r) => r.away_player1_id === null)).toBe(true);
    });
  });

  it("L2. away captain submits OWN side -> PASS (away set, home null)", async () => {
    await asUser(fx.uKaAway, async () => {
      await lineup(fx.Ma, "away", fx.playersA);
      const rows = await db.query(
        "select home_player1_id, away_player1_id from match_line where match_id = $1",
        [fx.Ma],
      );
      expect(rows.rowCount).toBe(9);
      expect(rows.rows.every((r) => r.away_player1_id !== null)).toBe(true);
      expect(rows.rows.every((r) => r.home_player1_id === null)).toBe(true);
    });
  });

  it("L3. home captain submits the OPPONENT's side -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        lineup(fx.Ma, "away", fx.playersA),
      );
    });
  });

  it("L4. plain member submits a lineup -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uPa, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        lineup(fx.Ma, "home", fx.playersA),
      );
    });
  });

  it("L5. another league's captain submits -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uKbCap, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        lineup(fx.Ma, "home", fx.playersA),
      );
    });
  });

  it("L6. captain bypasses RPC with a direct match_line INSERT -> DENY (42501 + RLS message)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query(
          `insert into match_line (match_id, round_number, home_pair_index, away_pair_index)
           values ($1, 2, 2, 2)`,
          [fx.Ma],
        ),
      );
    });
  });

  it("L6b. captain bypasses RPC with a direct match_line UPDATE -> DENY (rowCount 0)", async () => {
    await asUser(fx.uKaHome, async () => {
      const r = await db.query(
        "update match_line set away_player1_id = $1 where match_id = $2",
        [fx.playersA[0], fx.Ma],
      );
      expect(r.rowCount).toBe(0);
    });
  });

  it("L7. submit OWN side with a foreign-league player -> RAISE (P0001 + trigger message)", async () => {
    const pairsWithForeign = [...fx.playersA.slice(0, 5), fx.Pb];
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("P0001", /player must belong to the match league/, () =>
        lineup(fx.Ma, "home", pairsWithForeign),
      );
    });
  });
});

// Score entry (PR #5) writes line_game DIRECTLY (either-captain via the
// can_write_match RLS policy — scores are shared, unlike lineup's per-side
// ownership). Two DB-enforced boundaries layer on top, in an AFTER trigger so
// RLS authorization is always decided first: scorability (both lineups required)
// and lineup-lock (first determined score moves scheduled -> in_progress, which
// closes submit_lineup). The full authz + boundary story lives here in full.
describe("score entry: line_game write path", () => {
  it("SC1. own-match (home) captain writes a score -> PASS", async () => {
    await asUser(fx.uKaHome, async () => {
      const r = await db.query(
        "update line_game set home_score = 11 where id = $1",
        [fx.lgScore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("SC2. OPPOSING captain writes a score -> PASS (either-captain)", async () => {
    await asUser(fx.uKaAway, async () => {
      const r = await db.query(
        "update line_game set away_score = 11 where id = $1",
        [fx.lgScore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("SC3. non-match captain (same league, on no match) -> DENY by RLS with-check (42501 + RLS message)", async () => {
    await asUser(fx.uKaOther, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query(
          `insert into line_game (match_line_id, game_number, home_score, away_score)
           values ($1, 2, 11, 0)`,
          [fx.mlScore],
        ),
      );
    });
  });

  it("SC4. another league's captain writes scores -> DENY by RLS with-check (42501 + RLS message)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("42501", /row-level security/, () =>
        db.query(
          `insert into line_game (match_line_id, game_number, home_score, away_score)
           values ($1, 9, 11, 0)`,
          [fx.mlMb],
        ),
      );
    });
  });

  it("SC5. scorability: real score on a HALF-submitted match -> DENY (P0001 + not scorable)", async () => {
    await asUser(fx.uKaHome, async () => {
      // RLS passes (kaHome captains the half-submitted match's home team); the
      // AFTER trigger then rejects the real score because the away lineup is null.
      await expectSqlState("P0001", /not scorable/, () =>
        db.query(
          `insert into line_game (match_line_id, game_number, home_score, away_score)
           values ($1, 1, 11, 9)`,
          [fx.mlMaHalf],
        ),
      );
    });
  });

  it("SC6. forfeit is EXEMPT from scorability: 11-0 forfeit on the half-submitted match -> PASS", async () => {
    await asUser(fx.uKaHome, async () => {
      const r = await db.query(
        `insert into line_game (match_line_id, game_number, home_score, away_score, is_forfeit)
         values ($1, 1, 11, 0, true)`,
        [fx.mlMaHalf],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("SC7. lineup-lock: after a determined score, submit_lineup -> DENY (P0001 + lineup locked)", async () => {
    await asUser(fx.uKaHome, async () => {
      // A determined result flips Mscore scheduled -> in_progress (the lock).
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      // The captain lineup path is now closed.
      await expectSqlState("P0001", /lineup locked/, () =>
        db.query("select submit_lineup($1, $2, $3)", [
          fx.Mscore,
          "home",
          fx.playersA,
        ]),
      );
    });
  });

  it("SC8. status flip: a determined write moves scheduled -> in_progress (direct assertion)", async () => {
    await asUser(fx.uKaHome, async () => {
      const before = await db.query("select status from match where id = $1", [
        fx.Mscore,
      ]);
      expect(before.rows[0].status).toBe("scheduled");
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      const after = await db.query("select status from match where id = $1", [
        fx.Mscore,
      ]);
      expect(after.rows[0].status).toBe("in_progress");
    });
  });

  it("SC9. commissioner correction: direct match_line write AFTER lock -> PASS (the escape hatch)", async () => {
    await asUser(fx.uCommA, async () => {
      // Lock the match by entering a determined score (commissioner may score too).
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      const status = await db.query("select status from match where id = $1", [
        fx.Mscore,
      ]);
      expect(status.rows[0].status).toBe("in_progress");
      // Commissioner keeps DIRECT match_line write for corrections even when locked.
      const r = await db.query(
        "update match_line set home_player1_id = $1 where match_id = $2",
        [fx.playersA[0], fx.Mscore],
      );
      expect(r.rowCount).toBe(1);
    });
  });
});

// Flag review (PR #6). The commissioner acts on flagged matches: resolve_flag()
// (decoupled from correction), correct_lineup() (commissioner-only, lock-exempt),
// the auto-finalize completion lock, and the captain final-lock on line_game.
// Full authz + lifecycle story for each new write path lives here.
describe("flag review: resolve / correction / finalize write paths", () => {
  it("FR1. commissioner resolves a flagged match with NO score edit -> PASS (decoupled)", async () => {
    await asUser(fx.uCommA, async () => {
      const before = await db.query(
        "select count(*) from line_game lg join match_line ml on ml.id = lg.match_line_id where ml.match_id = $1",
        [fx.Mflag],
      );
      await db.query("select resolve_flag($1, $2)", [fx.Mflag, "no rule broken"]);
      const m = await db.query(
        "select is_flagged, flag_resolution, flag_resolved_by, flag_comment from match where id = $1",
        [fx.Mflag],
      );
      expect(m.rows[0].is_flagged).toBe(false);
      expect(m.rows[0].flag_resolution).toBe("no rule broken");
      expect(m.rows[0].flag_resolved_by).not.toBeNull();
      expect(m.rows[0].flag_comment).toBe("disputed line 4 score"); // dispute kept
      // No score was created/changed by resolving.
      const after = await db.query(
        "select count(*) from line_game lg join match_line ml on ml.id = lg.match_line_id where ml.match_id = $1",
        [fx.Mflag],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  });

  it("FR2. captain resolves a flag -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        db.query("select resolve_flag($1, $2)", [fx.Mflag, "x"]),
      );
    });
  });

  it("FR3. another league's commissioner resolves -> DENY (P0001 + not authorized)", async () => {
    // uCommA is league A's commissioner; Mb is in league B.
    await asUser(fx.uCommA, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        db.query("select resolve_flag($1, $2)", [fx.Mb, "x"]),
      );
    });
  });

  it("FR4. re-flag after resolve: captain flag_match on a RESOLVED match -> PASS; resolution stamps go stale", async () => {
    await asUser(fx.uKaHome, async () => {
      await db.query("select flag_match($1, $2)", [fx.Mflag2, "new dispute"]);
      const m = await db.query(
        "select is_flagged, flag_comment, flag_resolution from match where id = $1",
        [fx.Mflag2],
      );
      expect(m.rows[0].is_flagged).toBe(true);
      expect(m.rows[0].flag_comment).toBe("new dispute");
      // B2 single-record property: flag_match does NOT clear the prior resolution;
      // resolution fields are authoritative only while is_flagged = false.
      expect(m.rows[0].flag_resolution).toBe("corrected and cleared");
    });
  });

  it("FR5. correct_lineup: commissioner corrects a pairing AFTER lock -> PASS (lock-exempt)", async () => {
    await asUser(fx.uCommA, async () => {
      // Lock Mscore (determined score -> in_progress); correct_lineup has no lock guard.
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      await db.query("select correct_lineup($1, $2, $3)", [
        fx.Mscore,
        "home",
        fx.playersA,
      ]);
      const rows = await db.query(
        "select home_player1_id from match_line where match_id = $1",
        [fx.Mscore],
      );
      expect(rows.rows.every((r) => r.home_player1_id !== null)).toBe(true);
    });
  });

  it("FR6. correct_lineup by a captain -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        db.query("select correct_lineup($1, $2, $3)", [fx.Mscore, "home", fx.playersA]),
      );
    });
  });

  it("FR7. correct_lineup by another league's commissioner -> DENY (P0001 + not authorized)", async () => {
    await asUser(fx.uCommA, async () => {
      await expectSqlState("P0001", /not authorized/, () =>
        db.query("select correct_lineup($1, $2, $3)", [fx.Mb, "home", fx.playersA]),
      );
    });
  });

  it("FR8. correct_lineup with a FOREIGN-league player -> RAISE (P0001 + trigger message)", async () => {
    // Dropping the lock guard did NOT drop the member-league (FK-value) guard.
    const pairsWithForeign = [...fx.playersA.slice(0, 5), fx.Pb];
    await asUser(fx.uCommA, async () => {
      await expectSqlState("P0001", /player must belong to the match league/, () =>
        db.query("select correct_lineup($1, $2, $3)", [fx.Mscore, "home", pairsWithForeign]),
      );
    });
  });

  it("FR9. SC9 re-assert: commissioner direct match_line write AFTER lock -> PASS (escape hatch)", async () => {
    await asUser(fx.uCommA, async () => {
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      const r = await db.query(
        "update match_line set home_player1_id = $1 where match_id = $2",
        [fx.playersA[0], fx.Mscore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("FR10. auto-finalize: completing the scoresheet flips in_progress -> final (direct assertion)", async () => {
    await asUser(fx.uKaHome, async () => {
      // Mscore has 1 line x 2 games. Determine BOTH -> scoring complete -> final.
      await db.query(
        "update line_game set home_score = 11, away_score = 9 where id = $1",
        [fx.lgScore],
      );
      const mid = await db.query("select status from match where id = $1", [fx.Mscore]);
      expect(mid.rows[0].status).toBe("in_progress"); // 1 of 2 games: not complete
      await db.query(
        "update line_game set home_score = 7, away_score = 11 where id = $1",
        [fx.lgScore2],
      );
      const done = await db.query("select status from match where id = $1", [fx.Mscore]);
      expect(done.rows[0].status).toBe("final"); // 2 of 2: auto-finalized
    });
  });

  it("FR11. captain score-lock: once the match is final, a further captain write -> DENY (42501 + RLS)", async () => {
    await asUser(fx.uKaHome, async () => {
      // The captain can ENTER the completing games (status is in_progress at each
      // WITH CHECK); the 2nd determined game auto-finalizes the match...
      await db.query("update line_game set home_score = 11, away_score = 9 where id = $1", [fx.lgScore]);
      await db.query("update line_game set home_score = 7, away_score = 11 where id = $1", [fx.lgScore2]);
      const st = await db.query("select status from match where id = $1", [fx.Mscore]);
      expect(st.rows[0].status).toBe("final");
      // ...and a further captain write to the now-final match is denied.
      await expectSqlState("42501", /row-level security/, () =>
        db.query("update line_game set home_score = 3 where id = $1", [fx.lgScore]),
      );
    });
  });

  it("FR12. commissioner corrects a FINAL match's score -> PASS (exempt; the escape hatch at final)", async () => {
    await asUser(fx.uCommA, async () => {
      // Complete Mscore -> final (commissioner may score too), then correct in place.
      await db.query("update line_game set home_score = 11, away_score = 9 where id = $1", [fx.lgScore]);
      await db.query("update line_game set home_score = 7, away_score = 11 where id = $1", [fx.lgScore2]);
      const st = await db.query("select status from match where id = $1", [fx.Mscore]);
      expect(st.rows[0].status).toBe("final");
      const r = await db.query(
        "update line_game set home_score = 9, away_score = 11 where id = $1",
        [fx.lgScore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("FR13a. commissioner finalizes a match (status update) -> PASS", async () => {
    await asUser(fx.uCommA, async () => {
      const r = await db.query(
        "update match set status = 'final' where id = $1",
        [fx.Mscore],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("FR13b. captain finalizes a match -> DENY (rowCount 0; match_write using = is_commissioner)", async () => {
    await asUser(fx.uKaHome, async () => {
      const r = await db.query(
        "update match set status = 'final' where id = $1",
        [fx.Mscore],
      );
      expect(r.rowCount).toBe(0);
    });
  });

  it("FR13c. another league's commissioner finalizes -> DENY (rowCount 0)", async () => {
    await asUser(fx.uCommA, async () => {
      const r = await db.query(
        "update match set status = 'final' where id = $1",
        [fx.Mb],
      );
      expect(r.rowCount).toBe(0);
    });
  });
});
