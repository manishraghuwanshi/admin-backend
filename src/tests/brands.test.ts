import { eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { brands } from "../db/schema.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, errorOf, login } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, findAuditRows, seedAdmin, testAdmin } from "./helpers/seed.js";
import { seedBrand, seedProduct } from "./helpers/catalog.js";

/**
 * `/api/brands`.
 *
 * All three roles hold `brands.manage`, so no authenticated administrator can be
 * shown a 403 here: only the granted path and the `401` path are assertable, and the
 * role matrix itself is unit-tested in `permissions.test.ts`.
 *
 * What is worth pinning is the list contract (always paginated, never shuffling a row
 * across a page boundary), the two unique constraints, and the delete guard - each is
 * a rule the frontend has to code against.
 */

interface BrandRow {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  isActive: boolean;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

async function agentFor(role: keyof typeof testAdmin): Promise<Agent> {
  const admin = await seedAdmin(testAdmin[role]);
  const agent = createAgent();

  await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return agent;
}

const rowsOf = (res: Response) => dataOf<BrandRow[]>(res);
const metaOf = (res: Response) => (res.body as { pagination: Pagination }).pagination;
const namesOf = (res: Response) => rowsOf(res).map((row) => row.name);

async function setActive(slug: string, isActive: boolean): Promise<void> {
  await db.update(brands).set({ isActive }).where(eq(brands.slug, slug));
}

describe("brands: reading", () => {
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
    agent = await agentFor("owner");
  });

  it("always returns the paginated envelope, even with no query string", async () => {
    await seedBrand({ name: "Alpha", slug: "alpha" });

    const res = await agent.get("/api/brands").expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(metaOf(res)).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it("returns an empty page with a zeroed total", async () => {
    const res = await agent.get("/api/brands").expect(200);

    expect(rowsOf(res)).toEqual([]);
    expect(metaOf(res)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it("paginates without repeating or dropping a row across pages", async () => {
    for (const letter of ["a", "b", "c", "d", "e"]) {
      await seedBrand({ name: `Brand ${letter}`, slug: `brand-${letter}` });
    }

    expect(namesOf(await agent.get("/api/brands?page=1&limit=2").expect(200))).toEqual([
      "Brand a",
      "Brand b",
    ]);
    expect(namesOf(await agent.get("/api/brands?page=2&limit=2").expect(200))).toEqual([
      "Brand c",
      "Brand d",
    ]);
    expect(namesOf(await agent.get("/api/brands?page=3&limit=2").expect(200))).toEqual(["Brand e"]);
    expect(metaOf(await agent.get("/api/brands?page=1&limit=2").expect(200))).toEqual({
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it("filters by a case-insensitive name search", async () => {
    await seedBrand({ name: "Seiko", slug: "seiko" });
    await seedBrand({ name: "Casio", slug: "casio" });

    expect(namesOf(await agent.get("/api/brands?search=sei").expect(200))).toEqual(["Seiko"]);
    expect(namesOf(await agent.get("/api/brands?search=SEIKO").expect(200))).toEqual(["Seiko"]);
    expect(rowsOf(await agent.get("/api/brands?search=nobody").expect(200))).toEqual([]);
  });

  it("sorts by createdAt with the same tie-break as updatedAt", async () => {
    const zeta = await seedBrand({ name: "Zeta", slug: "zeta" });
    await seedBrand({ name: "Alpha", slug: "alpha" });

    // Backdate one row: the tie-break is what a page boundary depends on when two
    // rows genuinely share a timestamp, so it has to be asserted for both columns.
    await db
      .update(brands)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(brands.id, zeta.id));

    expect(namesOf(await agent.get("/api/brands?sort=createdAt&order=asc").expect(200))).toEqual([
      "Zeta",
      "Alpha",
    ]);
    expect(namesOf(await agent.get("/api/brands?sort=createdAt&order=desc").expect(200))).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });

  it("filters by isActive, and returns everything when not asked to", async () => {
    await seedBrand({ name: "Live", slug: "live" });
    await seedBrand({ name: "Dropped", slug: "dropped" });
    await setActive("dropped", false);

    expect(namesOf(await agent.get("/api/brands").expect(200))).toEqual(["Dropped", "Live"]);
    expect(namesOf(await agent.get("/api/brands?isActive=true").expect(200))).toEqual(["Live"]);
    expect(namesOf(await agent.get("/api/brands?isActive=false").expect(200))).toEqual(["Dropped"]);
  });

  it("sorts by every allowed column in both directions", async () => {
    await seedBrand({ name: "Zeta", slug: "zeta" });
    await seedBrand({ name: "Alpha", slug: "alpha" });

    expect(namesOf(await agent.get("/api/brands?sort=name").expect(200))).toEqual(["Alpha", "Zeta"]);
    expect(namesOf(await agent.get("/api/brands?sort=name&order=desc").expect(200))).toEqual([
      "Zeta",
      "Alpha",
    ]);

    // `createdAt`/`updatedAt` are stamped by the database, and two inserts in the
    // same instant would make the *time* order meaningless. Pushing one brand
    // forward gives the assertion something real to order by, which is also exactly
    // what the `name` tie-break protects when the two are genuinely equal.
    await db
      .update(brands)
      .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(brands.slug, "alpha"));

    const byUpdatedAsc = namesOf(await agent.get("/api/brands?sort=updatedAt&order=asc").expect(200));

    expect(byUpdatedAsc[0]).toBe("Alpha");
    expect(byUpdatedAsc).toEqual(["Alpha", "Zeta"]);
    expect(namesOf(await agent.get("/api/brands?sort=updatedAt&order=desc").expect(200))).toEqual([
      "Zeta",
      "Alpha",
    ]);
  });

  it("refuses an unknown sort column, a bad order, and a nonsense page", async () => {
    expect(errorOf(await agent.get("/api/brands?sort=passwordHash")).code).toBe("VALIDATION_ERROR");
    await agent.get("/api/brands?order=sideways").expect(400);
    await agent.get("/api/brands?page=0").expect(400);
    await agent.get("/api/brands?page=1&limit=101").expect(400);
    await agent.get("/api/brands?isActive=maybe").expect(400);
  });

  it("reads one brand, 404s for a missing one, and 400s for a malformed id", async () => {
    const brand = await seedBrand({ name: "Omega", slug: "omega" });

    expect(dataOf<BrandRow>(await agent.get(`/api/brands/${brand.id}`).expect(200))).toMatchObject({
      id: brand.id,
      slug: "omega",
    });

    expect(errorOf(await agent.get(`/api/brands/${crypto.randomUUID()}`)).code).toBe("NOT_FOUND");
    expect(errorOf(await agent.get("/api/brands/not-a-uuid")).code).toBe("VALIDATION_ERROR");
  });
});



describe("brands: writing", () => {
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
    agent = await agentFor("owner");
  });

  it("creates a brand with its defaults and 201", async () => {
    const res = await agent
      .post("/api/brands")
      .send({ name: "Citizen", slug: "citizen", description: "Eco-Drive" })
      .expect(201);

    expect(dataOf<BrandRow>(res)).toMatchObject({
      name: "Citizen",
      slug: "citizen",
      description: "Eco-Drive",
      isActive: true,
      websiteUrl: null,
    });

    const audit = await findAuditRows("brand.create");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityType).toBe("brand");
    expect(audit[0]!.entityId).toBe(dataOf<BrandRow>(res).id);
  });

  it("treats an empty websiteUrl as clearing it rather than storing an empty string", async () => {
    const created = dataOf<BrandRow>(
      await agent
        .post("/api/brands")
        .send({ name: "Url", slug: "url", websiteUrl: "https://example.com" })
        .expect(201),
    );

    expect(created.websiteUrl).toBe("https://example.com");

    const cleared = dataOf<BrandRow>(
      await agent.patch(`/api/brands/${created.id}`).send({ websiteUrl: "" }).expect(200),
    );

    expect(cleared.websiteUrl).toBeNull();
  });

  it("rejects a duplicate name and a duplicate slug with 409", async () => {
    await seedBrand({ name: "Taken", slug: "taken" });

    const dupName = await agent.post("/api/brands").send({ name: "Taken", slug: "other" });

    expect(dupName.status).toBe(409);
    expect(errorOf(dupName).code).toBe("CONFLICT");

    const dupSlug = await agent.post("/api/brands").send({ name: "Other", slug: "taken" });

    expect(dupSlug.status).toBe(409);
    expect(errorOf(dupSlug).code).toBe("CONFLICT");

    expect(rowsOf(await agent.get("/api/brands").expect(200))).toHaveLength(1);
  });

  it("validates the name, slug, and URL before touching the database", async () => {
    await agent.post("/api/brands").send({ name: "", slug: "x" }).expect(400);
    await agent.post("/api/brands").send({ name: "N".repeat(101), slug: "x" }).expect(400);
    // Uppercase and underscores are the two shapes a hand-typed slug usually has.
    await agent.post("/api/brands").send({ name: "Nope", slug: "Not-Lower" }).expect(400);
    await agent.post("/api/brands").send({ name: "Nope", slug: "with_underscore" }).expect(400);
    await agent.post("/api/brands").send({ name: "Nope" }).expect(400);
    await agent
      .post("/api/brands")
      .send({ name: "Nope", slug: "x", websiteUrl: "not-a-url" })
      .expect(400);

    expect(rowsOf(await agent.get("/api/brands").expect(200))).toEqual([]);
  });

  it("patches only the fields it is sent", async () => {
    const brand = await seedBrand({ name: "Seiko", slug: "seiko", description: "Presage" });

    const updated = dataOf<BrandRow>(
      await agent.patch(`/api/brands/${brand.id}`).send({ isActive: false }).expect(200),
    );

    expect(updated.isActive).toBe(false);
    expect(updated.name).toBe("Seiko");
    expect(updated.slug).toBe("seiko");

    const badSlug = await agent.patch(`/api/brands/${brand.id}`).send({ slug: "Bad Slug" });

    expect(errorOf(badSlug).code).toBe("VALIDATION_ERROR");

    await agent.patch("/api/brands/not-a-uuid").send({ name: "x" }).expect(400);
    expect(errorOf(await agent.patch(`/api/brands/${crypto.randomUUID()}`).send({ name: "x" })).code).toBe(
      "NOT_FOUND",
    );

    const audit = await findAuditRows("brand.update");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityId).toBe(brand.id);
  });

  it("refuses to delete a brand that still has products", async () => {
    const brand = await seedBrand({ name: "Orphan", slug: "orphan" });

    // No products yet: the delete is allowed on its own terms.
    await agent.delete(`/api/brands/${brand.id}`).expect(200);

    const referenced = await seedBrand({ name: "Owned", slug: "owned" });

    await seedProduct({ brandId: referenced.id });

    const blocked = await agent.delete(`/api/brands/${referenced.id}`);

    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).code).toBe("CONFLICT");
    expect(errorOf(await agent.get(`/api/brands/${referenced.id}`)).code).toBeUndefined();
  });

  it("deletes an unreferenced brand and records it", async () => {
    const brand = await seedBrand({ name: "Gone", slug: "gone" });

    expect(dataOf(await agent.delete(`/api/brands/${brand.id}`).expect(200))).toEqual({
      deleted: true,
    });

    expect(errorOf(await agent.get(`/api/brands/${brand.id}`)).code).toBe("NOT_FOUND");
    expect(errorOf(await agent.delete(`/api/brands/${brand.id}`)).code).toBe("NOT_FOUND");

    const audit = await findAuditRows("brand.delete");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ slug: "gone" });
  });
});

describe("brands: authorization", () => {
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

  it("rejects an anonymous caller on every route", async () => {
    const anonymous = createAgent();
    const id = crypto.randomUUID();

    expect((await anonymous.get("/api/brands")).status).toBe(401);
    expect((await anonymous.get(`/api/brands/${id}`)).status).toBe(401);
    expect((await anonymous.post("/api/brands").send({ name: "x", slug: "x" })).status).toBe(401);
    expect((await anonymous.patch(`/api/brands/${id}`).send({ name: "x" })).status).toBe(401);
    expect((await anonymous.delete(`/api/brands/${id}`)).status).toBe(401);
  });

  it("grants the whole surface to all three roles, since none lacks brands.manage", async () => {
    const brand = await seedBrand({ name: "Shared", slug: "shared" });

    for (const role of ["owner", "manager", "editor"] as const) {
      const agent = await agentFor(role);

      expect((await agent.get("/api/brands")).status).toBe(200);
      expect((await agent.get(`/api/brands/${brand.id}`)).status).toBe(200);
      expect(
        (await agent.post("/api/brands").send({ name: `Via ${role}`, slug: `via-${role}` })).status,
      ).toBe(201);
      expect((await agent.patch(`/api/brands/${brand.id}`).send({ isActive: true })).status).toBe(200);

      // Reachable, but refused by the product guard rather than by the role - which
      // is the point: a 409 proves the request passed authorization.
      await seedProduct({ brandId: brand.id });
      expect((await agent.delete(`/api/brands/${brand.id}`)).status).toBe(409);
    }
  });
});

