import { pathToFileURL } from "node:url";

import { closeDatabase } from "../../db/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Shared lifecycle for CLI tools.
 *
 * Every script imports `env` transitively, which validates the environment at
 * import time and throws before `main()` ever runs. Catching here turns that throw
 * into a non-zero exit with a readable line, instead of an unhandled-rejection dump.
 */
export async function runScript(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();

    process.exitCode = 0;
  } catch (error) {
    logger.error(`${name} failed`, { error });

    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

/**
 * True only when the current module is the one the process was started with.
 *
 * Scripts keep their bodies in an exported function and call `runScript()` behind
 * this guard. Without it, importing a script from a test would execute it against
 * the test database - which for `bootstrap-owner` would mean inserting an owner and
 * for `cleanup-sessions` would mean deleting rows.
 */
export function isDirectExecution(metaUrl: string): boolean {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  return metaUrl === pathToFileURL(entry).href;
}

/** Refuse to run outside an explicit opt-in, so a script cannot fire by accident. */
export function requireConfirmationFlag(flag: string, argv: string[]): void {
  if (!argv.includes(flag)) {
    throw new Error(`Refusing to proceed without ${flag}. Review the change, then re-run with it.`);
  }
}

/** Read a required variable without ever echoing its value. */
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required but not set`);
  }

  return value;
}
