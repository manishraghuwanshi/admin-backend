import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Tests are hermetic: `src/tests/setup.ts` injects a test-only environment and
 * every database-backed test runs against an in-memory PGlite instance with the
 * real Drizzle migrations applied. No test may touch the Neon database or Neon
 * Object Storage, so the suite is safe to run against any branch.
 *
 * `pool: "forks"` runs each worker in its own process, which matters because the
 * app caches a frozen env snapshot and a single PGlite override per process.
 * `maxWorkers: 1` serializes test files: migrating the full schema per file is the
 * expensive part of a run and keeping one worker alive lets Vitest reuse it.
 */
export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**", "src/types/**", "src/server.ts"],
    },
  },
});
