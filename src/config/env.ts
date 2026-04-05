import { config as loadEnv } from "dotenv";

/**
 * Centralized environment configuration.
 *
 * Loads `.env` once, validates it, and exposes a frozen, typed object. Modules
 * read configuration from here instead of touching `process.env` directly, so
 * misconfiguration fails fast at startup with a clear message.
 *
 * Validation errors list variable names and reasons only - never values - so
 * secrets cannot leak through logs or error output.
 */

// Under `NODE_ENV=test` the environment is provided by the test harness
// (`src/tests/setup.ts`), and the real `.env` is deliberately not read so that
// live Neon/Object Storage credentials can never leak into an automated run.
if (process.env.NODE_ENV !== "test") {
  loadEnv({ quiet: true });
}


type NodeEnvironment = "development" | "test" | "production";
type LogLevel = "debug" | "info" | "warn" | "error";

const NODE_ENVIRONMENTS: readonly NodeEnvironment[] = ["development", "test", "production"];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const problems: string[] = [];

function optionalString(name: string): string | undefined {
  const raw = process.env[name]?.trim();

  return raw ? raw : undefined;
}

function enumValue<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T | undefined,
): T | undefined {
  const raw = optionalString(name);

  if (!raw) {
    return fallback;
  }

  if (!allowed.includes(raw as T)) {
    problems.push(`${name}: expected one of ${allowed.join(", ")}`);

    return fallback;
  }

  return raw as T;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalString(name);

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name}: expected an integer between ${min} and ${max}`);

    return fallback;
  }

  return parsed;
}

/** Accepts a boolean (`true`/`false`) or a proxy-hop count. */
function trustProxy(name: string): boolean | number {
  const raw = optionalString(name)?.toLowerCase();

  if (!raw || raw === "false") {
    return false;
  }

  if (raw === "true") {
    return true;
  }

  const hops = Number(raw);

  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    problems.push(`${name}: expected true, false, or an integer between 0 and 10`);

    return false;
  }

  return hops;
}

function postgresUrl(name: string, required: boolean): string | undefined {
  const raw = optionalString(name);

  if (!raw) {
    if (required) {
      problems.push(`${name}: required but not set`);
    }

    return undefined;
  }

  try {
    const parsed = new URL(raw);

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      problems.push(`${name}: expected a postgres:// or postgresql:// connection string`);
    }
  } catch {
    problems.push(`${name}: not a valid connection string URL`);
  }

  return raw;
}

/**
 * Comma-separated absolute origins, e.g.
 * `CORS_ORIGINS=https://admin.example.com,https://staging.example.com`
 */
function originList(name: string): readonly string[] {
  const raw = optionalString(name);

  if (!raw) {
    return [];
  }

  const origins: string[] = [];

  for (const entry of raw.split(",")) {
    const value = entry.trim();

    if (!value) {
      continue;
    }

    try {
      const parsed = new URL(value);

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push(`${name}: "${value}" must use http or https`);
        continue;
      }

      // Trailing slash is not part of an Origin header value.
      origins.push(parsed.origin);
    } catch {
      problems.push(`${name}: "${value}" is not a valid origin`);
    }
  }

  return origins;
}

function bodySizeLimit(name: string, fallback: string): string {
  const raw = optionalString(name);

  if (!raw) {
    return fallback;
  }

  if (!/^\d+(b|kb|mb)$/i.test(raw)) {
    problems.push(`${name}: expected a size such as 100kb or 1mb`);

    return fallback;
  }

  return raw.toLowerCase();
}

const NODE_ENV = enumValue("NODE_ENV", NODE_ENVIRONMENTS, "development") ?? "development";
const IS_PRODUCTION = NODE_ENV === "production";
const IS_TEST = NODE_ENV === "test";

const CORS_ORIGINS = originList("CORS_ORIGINS");
const PORT = integer("PORT", 5000, 1, 65535);
const LOG_LEVEL = enumValue("LOG_LEVEL", LOG_LEVELS, IS_PRODUCTION ? "info" : "debug") ?? "debug";
const DATABASE_URL = postgresUrl("DATABASE_URL", true);
const DATABASE_URL_UNPOOLED = postgresUrl("DATABASE_URL_UNPOOLED", false);
const TRUST_PROXY = trustProxy("TRUST_PROXY");
const JSON_BODY_LIMIT = bodySizeLimit("JSON_BODY_LIMIT", "100kb");
const SHUTDOWN_TIMEOUT_MS = integer("SHUTDOWN_TIMEOUT_MS", 10000, 1000, 60000);

if (IS_PRODUCTION && CORS_ORIGINS.length === 0) {
  problems.push("CORS_ORIGINS: required in production (comma-separated list of allowed origins)");
}

if (problems.length > 0) {
  throw new Error(
    `Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
  );
}

export const env = Object.freeze({
  NODE_ENV,
  IS_PRODUCTION,
  IS_TEST,
  /** Guaranteed to be a non-empty string; the `!` is backed by the check above. */
  DATABASE_URL: DATABASE_URL as string,
  DATABASE_URL_UNPOOLED,
  NEON_BRANCH: optionalString("NEON_BRANCH"),
  PORT,
  CORS_ORIGINS,
  TRUST_PROXY,
  JSON_BODY_LIMIT,
  LOG_LEVEL,
  SHUTDOWN_TIMEOUT_MS,
});

export type Env = typeof env;