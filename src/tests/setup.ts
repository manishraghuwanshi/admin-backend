import { ensureTestEnv } from "./helpers/env.js";

/**
 * Vitest global setup file (see `vitest.config.ts`).
 *
 * `ensureTestEnv()` runs here, at the very top of the module graph, because
 * `src/config/env.ts` snapshots and validates `process.env` the first time it is
 * imported. Importing any application module before that would freeze the wrong
 * configuration in place.
 */
ensureTestEnv();
