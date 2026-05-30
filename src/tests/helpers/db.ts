import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { count } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { setDbOverride, type AppDatabase } from "../../db/index.js";
import * as appSchema from "../../db/schema.js";

/**
 * Hermetic PostgreSQL for automated tests.
 *
 * Every test talks to an in-memory PGlite instance that has had the **real**
 * Drizzle migrations applied to it, so schema, constraints, indexes, enums and
 * defaults behave like Neon while no network connection is ever opened. The
 * instance is swapped into the app through `setDbOverride()`, which the `db`
 * proxy in `src/db/index.ts` consults before it would lazily create the real
 * postgres.js client — so a test cannot reach Neon even by accident.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/**
 * Tables in dependency order. `clearTestData()` deletes children first so the
 * foreign keys that exist in the real schema stay satisfied.
 */
const TABLES_IN_CHILD_FIRST_ORDER = [
  appSchema.auditLogs,
  appSchema.refreshSessions,
  appSchema.adminUsers,
  appSchema.productImages,
  appSchema.watchDetails,
  appSchema.inventory,
  appSchema.productCategories,
  appSchema.products,
  appSchema.categories,
  appSchema.brands,
] as const;

/** Every schema table, addressable by its SQL name for generic assertions. */
export const TABLES_BY_NAME: Record<string, (typeof TABLES_IN_CHILD_FIRST_ORDER)[number]> = {
  audit_logs: appSchema.auditLogs,
  refresh_sessions: appSchema.refreshSessions,
  admin_users: appSchema.adminUsers,
  product_images: appSchema.productImages,
  watch_details: appSchema.watchDetails,
  inventory: appSchema.inventory,
  product_categories: appSchema.productCategories,
  products: appSchema.products,
  categories: appSchema.categories,
  brands: appSchema.brands,
};

export interface TestDatabase {
  /** The Drizzle client handed to the application through `setDbOverride()`. */
  readonly db: AppDatabase;
  /** Raw handle for assertions that need to bypass the ORM. */
  readonly pglite: PgliteDatabase<typeof appSchema>;
  close(): Promise<void>;
}

/**
 * Boots a fresh, fully migrated in-memory database and installs it as the
 * application's active client. Call from `beforeAll`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const pglite = drizzle(client, { schema: appSchema });

  await migrate(pglite, { migrationsFolder: MIGRATIONS_FOLDER });

  // `PgliteDatabase` and the app's `PostgresJsDatabase` expose the same query
  // builder surface; the cast is confined to the test harness on purpose so the
  // production types stay untouched.
  const asAppDb = pglite as unknown as AppDatabase;

  setDbOverride(asAppDb);

  return {
    db: asAppDb,
    pglite,
    async close() {
      setDbOverride(undefined);
      await client.close();
    },
  };
}

/**
 * Removes every row created by a test. Used from `beforeEach` so cases stay
 * independent without paying for a new migration per test.
 *
 * This only ever runs against the throwaway PGlite instance; the deletion order
 * keeps referential integrity intact exactly as it would on Neon.
 */
export async function clearTestData(handle: TestDatabase): Promise<void> {
  for (const table of TABLES_IN_CHILD_FIRST_ORDER) {
    await handle.db.delete(table);
  }
}

/** Number of rows in a table, for assertions about side effects such as audits. */
export async function countRows(handle: TestDatabase, table: string): Promise<number> {
  const target = TABLES_BY_NAME[table];

  if (!target) {
    throw new Error(`Unknown table '${table}' in test helper countRows()`);
  }

  const [row] = await handle.db.select({ value: count() }).from(target);

  return Number(row?.value ?? 0);
}
