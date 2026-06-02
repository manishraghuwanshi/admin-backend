import { desc } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { inventory } from "../db/schema.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, errorOf, login } from "./helpers/api.js";
import {
  DEFAULT_ADMIN_PASSWORD,
  findAuditRows,
  seedAdmin,
  testAdmin,
} from "./helpers/seed.js";
import { seedBrand, seedProduct } from "./helpers/catalog.js";

/**
 * The inventory API.
 *
 * Two things are pinned here that the products endpoint cannot provide: permission
 * separation (`inventory.read` vs `inventory.write`) and the concurrency-safe delta
 * update. The guards are exercised through HTTP rather than by calling the service,
 * because they depend on `req.authUser` and on the validated body.
 */

async function loginAs(
  admin: { email: string },
  agent: Agent = createAgent(),
): Promise<Agent> {
  await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return agent;
}

async function ownerAgent(): Promise<Agent> {
  return loginAs(await seedAdmin(testAdmin.owner));
}

/** Products are created without stock rows, so each test controls its own start. */
async function productWithInventory(values: {
  quantity: number;
  reservedQuantity?: number;
  lowStockThreshold?: number;
}) {
  const product = await seedProduct();

  const [row] = await db
    .insert(inventory)
    .values({
      productId: product.id,
      quantity: values.quantity,
      reservedQuantity: values.reservedQuantity ?? 0,
      lowStockThreshold: values.lowStockThreshold ?? 5,
    })
    .returning();

  return { product, row };
}


const idsOf = (res: Response) =>
  dataOf<Array<{ productId: string }>>(res).map((row) => row.productId);

describe("inventory: reading", () => {
  let handle: TestDatabase;
  let agent: Agent;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    agent = await ownerAgent();
  });

  it("projects availableQuantity as quantity minus reserved", async () => {
    const { product } = await productWithInventory({ quantity: 10, reservedQuantity: 4 });

    const res = await agent.get(`/api/inventory/${product.id}`).expect(200);

    expect(dataOf(res)).toMatchObject({
      productId: product.id,
      productSku: product.sku,
      quantity: 10,
      reservedQuantity: 4,
      availableQuantity: 6,
    });
  });

  it("distinguishes a product with no stock row from a missing product", async () => {
    const product = await seedProduct();

    const gap = await agent.get(`/api/inventory/${product.id}`).expect(404);

    expect(errorOf(gap).message).toMatch(/inventory record/i);

    await agent.get(`/api/inventory/${crypto.randomUUID()}`).expect(404);
    await agent.get("/api/inventory/not-a-uuid").expect(400);
  });

  it("filters by stock state relative to each product's own threshold", async () => {
    // Same available quantity, different thresholds: only the second one is "low".
    await productWithInventory({ quantity: 8 });
    const low = await productWithInventory({ quantity: 8, lowStockThreshold: 20 });
    const out = await productWithInventory({ quantity: 0 });
    const reservedAway = await productWithInventory({
      quantity: 5,
      reservedQuantity: 5,
      lowStockThreshold: 0,
    });

    const lowRes = await agent.get("/api/inventory?stockState=low&limit=100").expect(200);

    expect(idsOf(lowRes)).toEqual([low.product.id]);

    const outRes = await agent.get("/api/inventory?stockState=out&limit=100").expect(200);

    expect(idsOf(outRes).sort()).toEqual([out.product.id, reservedAway.product.id].sort());

    const inStockRes = await agent.get("/api/inventory?stockState=inStock&limit=100").expect(200);

    expect(dataOf(inStockRes)).toHaveLength(2);
  });

  it("searches name and sku, and filters by brand", async () => {
    const brand = await seedBrand();
    const product = await seedProduct({ brandId: brand.id, name: "Seiko Presage", sku: "SKO-1" });

    await db.insert(inventory).values({ productId: product.id, quantity: 2 });

    const byName = await agent.get("/api/inventory?search=Presage").expect(200);
    const bySku = await agent.get("/api/inventory?search=sko-").expect(200);
    const byBrand = await agent.get(`/api/inventory?brandId=${brand.id}`).expect(200);
    const noBrand = await agent
      .get(`/api/inventory?brandId=${crypto.randomUUID()}`)
      .expect(200);

    expect(dataOf(byName)).toHaveLength(1);
    expect(dataOf(bySku)).toHaveLength(1);
    expect(dataOf(byBrand)).toHaveLength(1);
    expect(dataOf(noBrand)).toHaveLength(0);
  });

  it("sorts by the computed availability rather than a stored column", async () => {
    const a = await productWithInventory({ quantity: 1 });
    const b = await productWithInventory({ quantity: 50 });
    const c = await productWithInventory({ quantity: 20 });

    const res = await agent.get("/api/inventory?sort=available&order=desc&limit=100").expect(200);

    expect(idsOf(res)).toEqual([b.product.id, c.product.id, a.product.id]);
  });

  it("reports a pagination total for the filtered rows", async () => {
    for (const quantity of [1, 2, 3]) {
      await productWithInventory({ quantity });
    }

    const res = await agent.get("/api/inventory?page=2&limit=2").expect(200);

    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(dataOf(res)).toHaveLength(1);
  });

  it("rejects an unknown sort, order, or out-of-range page", async () => {
    await agent.get("/api/inventory?sort=nope").expect(400);
    await agent.get("/api/inventory?order=sideways").expect(400);
    await agent.get("/api/inventory?limit=101").expect(400);
    await agent.get("/api/inventory?page=0").expect(400);
  });
});

describe("inventory: writing", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let owner: { email: string };

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    owner = await seedAdmin(testAdmin.owner);
    agent = await loginAs(owner);
  });

  it("creates a missing stock row on set, then updates it", async () => {
    const product = await seedProduct();

    const created = await agent
      .put(`/api/inventory/${product.id}`)
      .send({ quantity: 12 })
      .expect(200);

    expect(dataOf(created)).toMatchObject({
      quantity: 12,
      reservedQuantity: 0,
      lowStockThreshold: 5,
    });

    const updated = await agent
      .put(`/api/inventory/${product.id}`)
      .send({ quantity: 7, reservedQuantity: 2, lowStockThreshold: 3 })
      .expect(200);

    expect(dataOf(updated)).toMatchObject({
      quantity: 7,
      reservedQuantity: 2,
      lowStockThreshold: 3,
      availableQuantity: 5,
    });
  });

  it("refuses a reservation larger than the quantity", async () => {
    const { product } = await productWithInventory({ quantity: 10, reservedQuantity: 2 });

    // Caught by the schema refine before the service ever runs.
    const schemaLevel = await agent
      .put(`/api/inventory/${product.id}`)
      .send({ quantity: 2, reservedQuantity: 5 })
      .expect(400);

    expect(errorOf(schemaLevel).code).toBe("VALIDATION_ERROR");

    // The service guard rejects the same state on the adjust path, where the
    // resulting pair is only known after the delta is applied.
    const serviceLevel = await agent
      .post(`/api/inventory/${product.id}/adjust`)
      .send({ delta: -9 })
      .expect(422);

    expect(errorOf(serviceLevel).code).toBe("UNPROCESSABLE_ENTITY");
  });

  it("leaves the stored row untouched when a write is rejected", async () => {
    const { product } = await productWithInventory({ quantity: 3, reservedQuantity: 1 });

    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: -4 }).expect(422);

    const after = await agent.get(`/api/inventory/${product.id}`).expect(200);

    expect(dataOf(after)).toMatchObject({ quantity: 3, reservedQuantity: 1 });
  });

  it("rejects negative, fractional, and absent quantities", async () => {
    const product = await seedProduct();

    await agent.put(`/api/inventory/${product.id}`).send({ quantity: -1 }).expect(400);
    await agent.put(`/api/inventory/${product.id}`).send({ quantity: 1.5 }).expect(400);
    await agent.put(`/api/inventory/${product.id}`).send({}).expect(400);
  });

  it("applies a delta without touching fields the caller omitted", async () => {
    const { product } = await productWithInventory({
      quantity: 10,
      reservedQuantity: 3,
      lowStockThreshold: 9,
    });

    const res = await agent
      .post(`/api/inventory/${product.id}/adjust`)
      .send({ delta: -4, reason: "Shrinkage counted" })
      .expect(200);

    expect(dataOf(res)).toMatchObject({
      quantity: 6,
      reservedQuantity: 3,
      lowStockThreshold: 9,
      availableQuantity: 3,
    });
  });

  it("applies concurrent adjustments without losing either write", async () => {
    const { product } = await productWithInventory({ quantity: 100 });

    // Six distinct sessions for the same administrator, built one at a time: the
    // logins are not what is under test, and each one hashes a password, so racing
    // them would mostly measure Argon2. The concurrency exercised below is the
    // delta UPDATE, which is where a read-modify-write would lose a write.
    const writers: Agent[] = [];

    for (let index = 0; index < 6; index += 1) {
      writers.push(await loginAs(owner, createAgent()));
    }

    const results = await Promise.all(
      writers.map((writer) =>
        writer.post(`/api/inventory/${product.id}/adjust`).send({ delta: 5 }),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // The new quantity is computed inside the UPDATE, so all six deltas land. A
    // read-modify-write would settle somewhere below 130.
    const final = await agent.get(`/api/inventory/${product.id}`).expect(200);

    expect(dataOf(final).quantity).toBe(130);
  });

  it("rejects a zero delta, and a target that does not exist", async () => {
    const { product } = await productWithInventory({ quantity: 5 });

    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 0 }).expect(400);
    await agent.put(`/api/inventory/${crypto.randomUUID()}`).send({ quantity: 1 }).expect(404);
    await agent
      .post(`/api/inventory/${crypto.randomUUID()}/adjust`)
      .send({ delta: 1 })
      .expect(404);
  });

  it("audits each write with before and after state", async () => {
    const { product } = await productWithInventory({ quantity: 10 });

    await agent.put(`/api/inventory/${product.id}`).send({ quantity: 4 }).expect(200);
    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 2 }).expect(200);

    const setRows = await findAuditRows("inventory.set");
    const adjustRows = await findAuditRows("inventory.adjust");

    expect(setRows).toHaveLength(1);
    expect(setRows[0]!.entityType).toBe("inventory");
    expect(setRows[0]!.entityId).toBe(product.id);
    expect(setRows[0]!.metadata).toMatchObject({ before: { quantity: 10 } });

    expect(adjustRows).toHaveLength(1);
    expect(adjustRows[0]!.metadata).toMatchObject({ delta: 2, quantity: 6 });
  });

  it("keeps updatedAt moving as rows are written", async () => {
    const { product, row } = await productWithInventory({ quantity: 10 });
    const before = row.updatedAt.getTime();

    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 1 }).expect(200);

    const rows = await db.select().from(inventory).orderBy(desc(inventory.updatedAt));

    expect(rows[0]!.quantity).toBe(11);
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("inventory: authorization", () => {
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

  it("requires authentication for every route", async () => {
    await createAgent().get("/api/inventory").expect(401);
    await createAgent().post("/api/inventory/x/adjust").send({ delta: 1 }).expect(401);
  });

  it("lets an editor read stock but refuses every stock write", async () => {
    const editor = await seedAdmin(testAdmin.editor);
    const { product } = await productWithInventory({ quantity: 10 });

    const agent = createAgent();

    await login(agent, { email: editor.email, password: DEFAULT_ADMIN_PASSWORD });

    await agent.get("/api/inventory").expect(200);
    await agent.get(`/api/inventory/${product.id}`).expect(200);

    const forbidden = await agent
      .put(`/api/inventory/${product.id}`)
      .send({ quantity: 3 })
      .expect(403);

    expect(errorOf(forbidden).code).toBe("FORBIDDEN");

    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 1 }).expect(403);
  });

  it("grants the manager both inventory permissions", async () => {
    const manager = await seedAdmin(testAdmin.manager);
    const { product } = await productWithInventory({ quantity: 10 });

    const agent = createAgent();

    await login(agent, { email: manager.email, password: DEFAULT_ADMIN_PASSWORD });

    await agent.get(`/api/inventory/${product.id}`).expect(200);
    await agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 2 }).expect(200);
  });
});
