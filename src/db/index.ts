import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { env } from "../config/env.js";
import * as schema from "./schema.js";

export type AppDatabase = PostgresJsDatabase<typeof schema>;

/**
 * An open Drizzle transaction on the application schema.
 *
 * Helpers that must participate in their caller's transaction accept this instead
 * of the singleton, which keeps "read, validate, write" sequences atomic without
 * each module re-declaring the (verbose) generated transaction type.
 */
export type DbTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];


type SqlClient = ReturnType<typeof postgres>;

let sqlClient: SqlClient | undefined;
let defaultDb: AppDatabase | undefined;
let overrideDb: AppDatabase | undefined;

function createDefaultDb(): AppDatabase {
  sqlClient = postgres(env.DATABASE_URL);
  return drizzle(sqlClient, { schema });
}

export function getDb(): AppDatabase {
  if (overrideDb) {
    return overrideDb;
  }

  if (!defaultDb) {
    defaultDb = createDefaultDb();
  }

  return defaultDb;
}

/**
 * Used by automated tests so they never open the real Neon connection.
 * Pass `undefined` to restore the default client.
 */
export function setDbOverride(database: AppDatabase | undefined): void {
  overrideDb = database;
}

/**
 * Relational Drizzle client. Routes and services import this singleton.
 *
 * A proxy is used so tests can replace the underlying instance after import.
 */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, property, _receiver) {
    const target = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = target[property];

    return typeof value === "function" ? value.bind(target) : value;
  },
});

/** Closes pooled connections. Used during graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    defaultDb = undefined;
  }
}
