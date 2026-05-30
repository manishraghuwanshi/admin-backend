import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { brands } from "../db/schema.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";

/**
 * Proves the test harness itself: a real migration run against in-memory PGlite,
 * wired into the application's `db` proxy, with constraints enforced.
 */
describe("PGlite test harness", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
  });

  it("applies every migration, creating all ten tables", async () => {
    const tables = [
      "brands",
      "categories",
      "products",
      "product_categories",
      "watch_details",
      "product_images",
      "inventory",
      "admin_users",
      "refresh_sessions",
      "audit_logs",
    ];

    expect(tables).toHaveLength(10);

    // A missing table makes the count fail with a Postgres "relation does not
    // exist" error, so counting every table is the existence check.
    for (const table of tables) {
      await expect(countRows(handle, table)).resolves.toBe(0);
    }
  });

  it("routes the application's db singleton to PGlite", async () => {
    const [created] = await db
      .insert(brands)
      .values({ name: "Seiko", slug: "seiko" })
      .returning();

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.isActive).toBe(true);
    expect(await countRows(handle, "brands")).toBe(1);
  });

  it("enforces unique constraints through the ORM", async () => {
    await db.insert(brands).values({ name: "Seiko", slug: "seiko" });

    await expect(
      db.insert(brands).values({ name: "Seiko", slug: "seiko-2" }),
    ).rejects.toThrow();
  });
});
