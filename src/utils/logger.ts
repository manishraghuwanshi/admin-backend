import { env } from "../config/env.js";

/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line (stdout for debug/info, stderr for warn/error)
 * and redacts secrets both by key name and by literal value, so credentials can
 * never leak into logs through an accidentally logged error or config object.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Field names whose values are replaced without inspecting the value. */
const SENSITIVE_KEY_PATTERN =
  /pass|secret|token|authorization|cookie|api[-_]?key|access[-_]?key|connection[-_]?string|database[-_]?url|credential/i;

const CONNECTION_STRING_PATTERN = /postgres(?:ql)?:\/\/\S+/gi;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 512;

function databasePasswords(): string[] {
  return [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].flatMap((url) => {
    if (!url) {
      return [];
    }

    try {
      const password = new URL(url).password;
      return password ? [password] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Literal secret values that must never appear in logs. Values shorter than
 * eight characters are ignored so common substrings are not over-redacted.
 */
const SECRET_VALUES: string[] = [
  env.DATABASE_URL,
  env.DATABASE_URL_UNPOOLED,
  env.AUTH_ACCESS_TOKEN_SECRET,
  env.AUTH_REFRESH_TOKEN_SECRET,
  env.AWS_ACCESS_KEY_ID,
  env.AWS_SECRET_ACCESS_KEY,
  ...databasePasswords(),
].filter((value): value is string => typeof value === "string" && value.length >= 8);

function scrubText(value: string): string {
  let result = value;

  for (const secret of SECRET_VALUES) {
    result = result.split(secret).join(REDACTED);
  }

  result = result.replace(CONNECTION_STRING_PATTERN, REDACTED);

  return result.length > MAX_STRING_LENGTH
    ? `${result.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : result;
}

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return scrubText(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[MaxDepth]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: scrubText(value.message),
    };

    // Stack traces are useful while developing but are not written in production.
    if (!env.IS_PRODUCTION && value.stack) {
      serialized.stack = scrubText(value.stack);
    }

    return serialized;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }

  return result;
}

function normalizeFields(fields: LogFields | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!fields) {
    return result;
  }

  for (const [key, value] of Object.entries(fields)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(value);
  }

  return result;
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.LOG_LEVEL]) {
    return;
  }

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    message: scrubText(message),
    ...normalizeFields(fields),
  };

  let line: string;

  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({
      time: entry.time,
      level,
      message: entry.message,
      fields: "[unserializable]",
    });
  }

  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => write("debug", message, fields),
  info: (message: string, fields?: LogFields): void => write("info", message, fields),
  warn: (message: string, fields?: LogFields): void => write("warn", message, fields),
  error: (message: string, fields?: LogFields): void => write("error", message, fields),
};
