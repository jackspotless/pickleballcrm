# Desert ATPL Platform — Handoff (Phase 2, mid-Chunk B)

Reset reference with **Chunk B complete** — all Phase 2 operational screens
(scheduling, lineup, score entry, flag review) are merged. Everything below is
current as of `main` containing PR #6 (flag review). Next work is the post-pilot
deferred track (see What's left).

## Trunk state

- **`main` HEAD when this doc was written:** PR #6 (Chunk B: flag review) merged
  — this handoff sits on top.
- **Merged and live on `main`:**
  - Phase 1 — core schema, all enums/FKs, RLS on every table, `current_member()`
    + `auth_league_ids()`, public view-layer SELECT, `public_member` /
    `public_league` views, tenant isolation. Pure scoring engine (unit-tested).
  - Phase 2 foundation — `rule_set` entity + `season.rule_set_id`; rounds-aware
    `match_line` (round/pair indices, rotation); FK-chain league resolvers;
    role-based write policies (resolver in `using` **and** `with check`);
    `flag_match()` RPC; FK-value triggers (`match_line` players, `roster_entry`,
    `member_role`); engine `total_team_points` + VI.E.3 tiebreaker chain +
    `roundsWon` + forfeit.
  - Auth shell — `src/middleware.ts` (Supabase session refresh + subdomain→league
    via `public_league`, `x-league-id` header, 404 on unknown subdomain);
    `src/lib/auth/{league,member}.ts`; `src/app/login` (email/password).
  - **RLS behavioral harness** (the CI gate) — `tests/rls/`, `npm run test:rls`.
  - Grant fix — `anon`/`authenticated` table privileges (foundation bug the
    harness caught; app was `permission denied` for all non-superuser requests).
  - Scheduling (PR #3) — `src/app/schedule` (commissioner creates matches).
  - Lineup (PR #4) — `src/app/lineup` + `submit_lineup` RPC.
  - Score entry (PR #5) — `src/app/score` (mobile-first); writes `line_game`
    directly (either-captain via `can_write_match`). Owns the scorability +
    lineup-lock boundaries (below) + whole-match `forfeit_match()` RPC; read-only
    engine preview reuses `scoreMatch`.
  - Flag review (PR #6) — `src/app/flags` (commissioner). Acts on flagged
    matches: `resolve_flag()` + `correct_lineup()` RPCs, finalize lifecycle.
    Owns the result-correction lifecycle (below).

- **Migrations (apply in this order):**
  1. `supabase/migrations/20260617000000_phase1_core.sql`
  2. `supabase/migrations/20260617120000_phase2_operations.sql`
  3. `supabase/migrations/20260618000000_grants.sql`
  4. `supabase/migrations/20260618120000_lineup.sql`
  5. `supabase/migrations/20260618180000_score_entry.sql`
  6. `supabase/migrations/20260619000000_flag_review.sql`

- **CI pipeline** (`.github/workflows/ci.yml`, Node 22): typecheck → unit tests →
  `supabase start` → `db reset` → **RLS harness** (`test:rls`) → seed → verify
  (21/24 anchor + per-row rounds-aware structure). Seed/verify run over a direct
  Postgres connection (superuser, bypasses RLS) via `pg`.

## Standing rules (operate under these)

1. **Per-screen PRs off `main`.** Each screen is its own branch/PR; merge green
   before the next stacks.
2. **Each screen's write-path harness cases land in the same PR.** The harness
   only protects what it covers; duplicate the relevant authz cases into the
   screen's block rather than referencing another (an invisible dependency that
   can be silently refactored away is the exact "looks covered but isn't"
   failure this harness exists to catch).
3. **Deny cases are message-matched, not bare SQLSTATE.** `42501` is shared by
   RLS-with-check (`/row-level security/`) and missing-grant (`/permission denied
   for table/`); a bare-`42501` assertion false-passed cross-league writes once
   already (the grant bug). Always assert the *mechanism*: RLS-with-check →
   `42501` + `/row-level security/`; trigger → `P0001` + the specific raise
   message; using-denied update → `rowCount 0`. (Message text is slightly
   brittle across PG versions — if these go red with no logic change, check the
   message string first.)
4. **RLS is the real gate; page-level role checks are UX-only.** Server actions
   use the authenticated server client so RLS enforces; the page's
   `is_commissioner` check etc. is presentation only.
5. **Captains write `match_line` only via `submit_lineup`** — they have no direct
   `match_line` write (tightened to commissioner-only). The RPC validates
   captain-of-*that-side* (auth-first) and writes only that side's columns.
6. **Scores stay either-captain via `can_write_match`** (`line_game`). Either
   team's captain (or commissioner) may write scores — intentional and distinct
   from lineup's stricter side-ownership.
7. **`security definer` functions:** pinned `search_path = public, pg_temp`,
   auth check first, reuse the FK-chain resolvers (`match_league_id`, etc.).

## Boundaries resolved in PR #5 (score entry) — operate under these

- **(b) Scorability = `is_match_scorable(match)`** (security definer): scorable
  iff **both lineups are fully submitted** — all 8 player columns non-null across
  the `match_line` rows (and ≥1 row). A half-submitted match is not scorable.
  Enforced by an **AFTER** trigger on `line_game` (`line_game_after_write`) so
  RLS authorization is decided FIRST — a cross-league / non-match write is
  rejected by RLS (42501 + row-level security) before the trigger runs (verified
  on hosted PG: BEFORE-row → WITH CHECK → AFTER-row). **Forfeits are exempt** —
  the mechanism for an absent/short side (incl. a whole-match no-show).
- **(a) Lineup-lock = `match.status`, automatic first-score flip.** The first
  *determined* result (both game scores set, or a forfeit) moves the match
  `scheduled → in_progress` via the same AFTER trigger; that closes the captain
  lineup path — `submit_lineup` raises `lineup locked: scoring has started` once
  status ≠ `scheduled`. The lock is tied exactly to "scoring has started," the
  window in which altering a pairing would corrupt entered scores.
- **(c) Commissioner correction escape hatch — PR #6 depends on this.** The lock
  closes only the *captain* path. Commissioner keeps **direct `match_line` write**
  (`match_line_write` = `is_commissioner`) even when `in_progress`, so a
  flagged-match correction can re-pair and re-score. Proven by harness case SC9
  (commissioner `match_line` write after lock → PASS).

## Result-correction lifecycle resolved in PR #6 (flag review) — operate under these

- **Auto-finalize on completion.** The `line_game_after_write` AFTER-trigger flips
  `in_progress → final` the moment the scoresheet is complete — all expected games
  determined, `is_scoring_complete(match)` = (# `match_line`) × `games_per_line`,
  forfeits counting as determined. **No manual finalize, no fourth status.** The
  completing write itself passes (gate-on-`status`, transition-in-trigger — the
  same split as the first-score lock); the *next* captain write is locked.
- **Captain final-lock.** `line_game_write` WITH CHECK uses `can_score_line_game`:
  a captain write to a `final` match → `42501` + row-level security; the
  **commissioner is exempt** (`is_commissioner`), so in-place correction stays
  open (A1). `using` is unchanged → PR #5 deny mechanisms intact.
- **Manual finalize** = direct `match` update (`match_write` = commissioner) for
  the incomplete/abandoned case. **Re-open is deferred** (post-pilot) — the
  commissioner corrects in place rather than handing scoring back to captains.
- **Flag resolution (B2):** `resolve_flag(match, note)` (commissioner-only) sets
  `is_flagged=false` and stamps `flag_resolution` / `flag_resolved_at` /
  `flag_resolved_by` (the `_by` FK is `ON DELETE SET NULL`), keeping `flag_comment`
  as the original dispute. **Decoupled from correction** — resolve without editing
  a score, correct without resolving. **Single-record limitation (known):** a
  re-flag via `flag_match()` does NOT clear the prior resolution stamps; the
  resolution fields are authoritative **only when `is_flagged = false`**. A
  `match_flag` history table is the post-pilot upgrade if threaded history is needed.
- **Pairing correction:** `correct_lineup(match, side, pairs)` — commissioner-only,
  **lock-exempt** (no `status` guard, unlike `submit_lineup`). Dropping the lock
  guard does NOT drop the member-league FK-value guard (harness FR8).

## Testing boundary (do not let it blur)

The harness proves **authorization** on write paths. It does **not** prove forms
render or submit correctly — there is **no browser e2e in CI**. "Harness green"
must never come to mean "screen works."

## What's left

Chunk B is complete — all Phase 2 operational screens are merged. Nothing
operational is queued; remaining work is the post-pilot deferred track.

- **Post-pilot deferred:** match-result **re-open** (final → in_progress, handing
  scoring back to captains) + `match_flag` history table (threaded/repeat flags);
  payments/registration live capture (separate gated track); ratings/TSR (see the
  ratings roadmap doc); native apps; chat/message center; round-grained weather
  resumption (V); other rule sets + tournament bracket engine; standings/results
  pages that consume `final`.

## Key files

- Engine: `src/lib/scoring/{engine,types,atpl-config}.ts`; rotation:
  `src/lib/match/rotation.ts`.
- Score entry: `src/app/score/{page,actions}.tsx`; read-only view model
  `src/lib/match/score-grid.ts` (config resolved through
  `division.scoring_format_id`, the same path CI anchor-verify uses); SQL
  (`is_match_scorable`, `line_game_after_write`, `forfeit_match`, the
  `submit_lineup` lock guard) in `20260618180000_score_entry.sql`.
- Flag review: `src/app/flags/{page,actions}.tsx`; SQL (`is_scoring_complete`,
  the `line_game_after_write` completion rung, `can_score_line_game`,
  `resolve_flag`, `correct_lineup`, the `match` resolution columns) in
  `20260619000000_flag_review.sql`.
- Harness: `tests/rls/{fixtures,rls.test.ts}`, `vitest.rls.config.ts`,
  `npm run test:rls`. Fixtures: two leagues (A/B), commissioner + both captains
  + a non-match captain + plain member + 6 players in A, a captain + member in B;
  identities assumed via `request.jwt.claims.sub` in rolled-back transactions.
  Score-entry cases run on a dedicated scorable match `Mscore` (both lineups in)
  + half-submitted `MaHalf`; `Ma` stays the lineup match (untouched). Flag-review
  cases add `Mflag` / `Mflag2` (resolved) and complete `Mscore` in-transaction to
  reach `final` — no persisted `final` match (it would collide with
  verify-anchor's `where status='final'`). **Standing step:** reproduce the full
  CI sequence (reset → harness → seed → verify) locally before pushing each PR —
  `loadFixtures` commits, so a persisted fixture can pollute the later seed/verify.
- Seed/verify: `scripts/{seed,verify-anchor}.ts` (direct `pg`, superuser).
- Anchor: 04/07/2026 — Other Desert Cities 21 @ Benchies United 24, rounds won
  1–1; re-derived from Postgres in CI.
