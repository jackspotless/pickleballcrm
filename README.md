# Team Pickleball League Platform

Multi-tenant team-pickleball league platform. Next.js (App Router) with
subdomain-per-league tenancy, Supabase (Postgres + Auth + Storage + RLS),
deployed on Netlify.

## Status — Phase 1 (foundation only)

- ✅ Project scaffold (Next.js + TypeScript + Supabase clients)
- ✅ Phase 1 migration: core tables, enums, FKs, RLS + policies, tenancy helpers
- ✅ Scoring engine (pure, unit-tested) — not wired to UI
- 🚧 Seed: league/season/division/teams/match shell in place; awaiting the
  verified 04/07/2026 line scores and the final ATPL scoring config

No UI features, registration, or payments yet.

## Local development

Prereqs: Node 20+, the [Supabase CLI](https://supabase.com/docs/guides/cli),
and Docker (for local Supabase).

```bash
npm install

# Start local Supabase (Postgres + Auth + Studio) and apply migrations
npm run db:start
npm run db:reset            # applies supabase/migrations/*

# Wire env: copy keys printed by `supabase start`
cp .env.local.example .env.local   # then paste URL + anon + service-role keys

# Seed data (service-role key, bypasses RLS)
npm run seed

# Run the app / tests
npm run dev
npm test
```

## Layout

```
supabase/migrations/   SQL migrations (Phase 1 = 20260617000000_phase1_core.sql)
src/lib/supabase/      Browser + server Supabase clients
src/lib/scoring/       Pure scoring engine + types + tests + ATPL config
scripts/seed.ts        Seed script
```

## Scoring engine

`src/lib/scoring/engine.ts` exposes a pure function:

```ts
scoreMatch(games: Game[], config: ScoringConfig)
  => { matchTotals, matchWinner, standingsDeltas }
```

Deterministic and side-effect free so the seed, API, and UI can all reuse it.
Run `npm test` to exercise it.
