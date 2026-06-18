import { defineConfig } from "vitest/config";

// Integration tests that run against a live local Supabase Postgres (DATABASE_URL).
// Kept separate from the unit suite (vitest.config.ts) so `npm test` stays DB-free.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rls/**/*.test.ts"],
    fileParallelism: false, // single shared connection, sequential
    hookTimeout: 60000,
  },
});
