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
        [fx.lgA],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("2. OPPOSING captain writes scores -> PASS (proves either-captain)", async () => {
    await asUser(fx.uKaAway, async () => {
      const r = await db.query(
        "update line_game set away_score = 11 where id = $1",
        [fx.lgA],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("3. wrong role, RIGHT league (rostered player, no perm) -> DENY (rowCount 0)", async () => {
    await asUser(fx.uPa, async () => {
      const r = await db.query(
        "update line_game set home_score = 7 where id = $1",
        [fx.lgA],
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
