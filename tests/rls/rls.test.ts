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

/** Assert the next write throws with a specific SQLSTATE. */
async function expectSqlState(code: string, fn: () => Promise<unknown>) {
  let err: { code?: string } | undefined;
  try {
    await fn();
  } catch (e) {
    err = e as { code?: string };
  }
  if (!err) throw new Error(`expected SQLSTATE ${code}, but the write succeeded`);
  expect(err.code).toBe(code);
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

  it("4. captain writes ANOTHER league's match -> DENY (42501)", async () => {
    await asUser(fx.uKaHome, async () => {
      await expectSqlState("42501", () =>
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

  it("6. commissioner writes ANOTHER league -> DENY (42501)", async () => {
    await asUser(fx.uCommA, async () => {
      await expectSqlState("42501", () =>
        db.query("insert into match (division_id, status) values ($1, 'scheduled')", [
          fx.divB,
        ]),
      );
    });
  });

  it("7. FK-value trigger: foreign-league player into match_line -> RAISE (P0001)", async () => {
    await asUser(fx.uCommA, async () => {
      // RLS passes (commissioner of Ma's league); the trigger must still fire.
      await expectSqlState("P0001", () =>
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
      await expectSqlState("P0001", () =>
        db.query(
          "insert into roster_entry (team_id, member_id) values ($1, $2)",
          [fx.teamAHome, fx.Pb],
        ),
      );
    });
  });

  it("9. anon (real anon role) cannot write -> DENY (42501)", async () => {
    await asAnon(async () => {
      await expectSqlState("42501", () =>
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
