import { randomBytes } from "node:crypto";

/**
 * Test environment bootstrap.
 *
 * `src/config/env.ts` validates `process.env` the moment it is first imported and
 * caches a frozen snapshot, so this function MUST run before any application
 * module is loaded. Vitest does that through `src/tests/setup.ts` (a `setupFile`),
 * which executes before each test file's imports.
 *
 * Guarantees:
 * 1. `NODE_ENV=test` - disables production-only behaviour and relaxes rate limits.
 * 2. Auth secrets are generated per run. They are never read from `.env`
 *    (`env.ts` skips dotenv when `NODE_ENV=test`), so a leaked or shared `.env`
 *    can never be used to mint tokens in CI, and tests can never authenticate
 *    against a real deployment.
 * 3. `DATABASE_URL` is a syntactically valid but **inert** loopback URL. Nothing
 *    connects to it: the PGlite harness calls `setDbOverride()` before the first
 *    query, so the lazy postgres.js client in `src/db/index.ts` is never created.
 *    Validation still passes, and any accidental real connection would fail
 *    instantly instead of touching Neon.
 * 4. Object Storage credentials are removed, so `isStorageConfigured()` is false
 *    and an accidental storage call throws `STORAGE_NOT_CONFIGURED` instead of
 *    writing to the real `product-images` bucket.
 */

/** Inert, well-formed connection string used only to satisfy env validation. */
export const TEST_DATABASE_URL =
  "postgresql://pglite:pglite@127.0.0.1:1/pglite_inert?sslmode=disable";

/** Origin the test suite treats as same-site (also used by CSRF tests). */
export const TEST_ALLOWED_ORIGIN = "http://localhost:5173";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  CORS_ORIGINS: TEST_ALLOWED_ORIGIN,
  TRUST_PROXY: "false",
  LOG_LEVEL: "error",
  AUTH_COOKIE_SAMESITE: "lax",
};

function generatedSecrets(): Record<string, string> {
  return {
    AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
    AUTH_REFRESH_TOKEN_SECRET: randomBytes(32).toString("hex"),
  };
}

let secrets: Record<string, string> | undefined;

/**
 * Installs the test environment. Idempotent: auth secrets are generated once per
 * process so that modules capturing them at import time (`src/lib/auth/tokens.ts`)
 * stay consistent with `env.AUTH_*_SECRET`.
 */
export function ensureTestEnv(overrides: Record<string, string> = {}): void {
  secrets ??= generatedSecrets();

  for (const blocked of [
    "DATABASE_URL_UNPOOLED",
    "NEON_BRANCH",
    "AWS_ENDPOINT_URL_S3",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    delete process.env[blocked];
  }

  Object.assign(process.env, BASE_ENV, secrets, overrides);
}

/**
 * Restores the baseline after a test mutated `process.env` (used by the
 * environment-validation tests). Does not change the auth secrets, so already
 * imported modules keep verifying tokens with the key they signed them with.
 */
export function resetTestEnv(): void {
  ensureTestEnv();
}

/** The exact env the app under test was configured with. */
export function currentTestEnv(): Readonly<Record<string, string>> {
  return { ...BASE_ENV, ...(secrets ?? {}) };
}
