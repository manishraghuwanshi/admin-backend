import { eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { categories } from "../db/schema.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  cookieHeaderFor,
  createAgent,
  createCrossSiteAgent,
  dataOf,
  errorOf,
  login,
  readAuthCookies,
} from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, findAuditRows, seedAdmin, testAdmin } from "./helpers/seed.js";
import { seedCategory, seedProduct, seedProductCategory } from "./helpers/catalog.js";

/**
 * `/api/categories`.
 *
 * Two things make this module worth its own suite rather than a few extra asserts
 * elsewhere. The first is the response contract: this route used to return a bare
 * array when no `page`/`limit` was supplied and a paginated envelope when either was,
 * so the shape depended on the query string. It is now always paginated, and that is
 * pinned here. The second is the hierarchy, which has no database-level foreign key
 * (see docs/database.md) and is therefore enforced *only* by application rules -
 * meaning a self-parent, a missing parent, and a cycle are all reachable states that
 * nothing else would catch.
 */

interface CategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  imageStorageKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

async function agentFor(
  role: keyof typeof testAdmin,
  base: Agent = createAgent(),
): Promise<Agent> {
  const admin = await seedAdmin(testAdmin[role]);

  await login(base, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return base;
}

const rowsOf = (res: Response) => dataOf<CategoryRow[]>(res);
const metaOf = (res: Response) => (res.body as { pagination: Pagination }).pagination;
const slugsOf = (res: Response) => rowsOf(res).map((row) => row.slug);

describe("categories: reading", () => {
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

  it("is always paginated, with or without a query string", async () => {
    await seedCategory({ name: "Watches", slug: "watches" });

    const bare = await agent.get("/api/categories").expect(200);

    expect(bare.body.success).toBe(true);
    expect(Array.isArray(bare.body.data)).toBe(true);
    expect(metaOf(bare)).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });

    // The shape must not depend on whether the caller asked for a page: a frontend
    // that has to branch on this is the bug this contract change exists to kill.
    for (const url of [
      "/api/categories?page=1",
      "/api/categories?page=1&limit=5",
      "/api/categories?limit=5",
    ]) {
      expect(metaOf(await agent.get(url).expect(200))).toMatchObject({
        page: 1,
        total: 1,
        totalPages: 1,
      });
    }
  });

  it("paginates the hierarchy without repeating or dropping a row", async () => {
    for (const letter of ["a", "b", "c", "d", "e"]) {
      await seedCategory({ name: `Cat ${letter}`, slug: `cat-${letter}` });
    }

    expect(slugsOf(await agent.get("/api/categories?page=1&limit=2").expect(200))).toEqual([
      "cat-a",
      "cat-b",
    ]);
    expect(slugsOf(await agent.get("/api/categories?page=2&limit=2").expect(200))).toEqual([
      "cat-c",
      "cat-d",
    ]);
    expect(slugsOf(await agent.get("/api/categories?page=3&limit=2").expect(200))).toEqual(["cat-e"]);
    expect(metaOf(await agent.get("/api/categories?limit=2").expect(200))).toEqual({
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it("filters by search, isActive, and parentId including the roots", async () => {
    const root = await seedCategory({ name: "Watches", slug: "watches" });
    await seedCategory({ name: "Men's", slug: "mens", parentId: root.id });
    await seedCategory({ name: "Dormant", slug: "dormant" });
    await db.update(categories).set({ isActive: false }).where(eq(categories.id, root.id));

    expect(slugsOf(await agent.get("/api/categories?search=wAT").expect(200))).toEqual(["watches"]);
    expect(slugsOf(await agent.get("/api/categories?isActive=false").expect(200))).toEqual([
      "watches",
    ]);
    expect(slugsOf(await agent.get(`/api/categories?parentId=${root.id}`).expect(200))).toEqual([
      "mens",
    ]);
    // `null` means "roots only", which is the one filter a tree view cannot derive
    // from the rows it already has.
    const roots = slugsOf(await agent.get("/api/categories?parentId=null").expect(200));

    expect(roots).toEqual(["dormant", "watches"]);
  });

  it("refuses a malformed parentId", async () => {
    await agent.get("/api/categories?parentId=not-a-uuid").expect(400);
  });

  it("sorts by sortOrder by default, then by the requested column and direction", async () => {
    await seedCategory({ name: "Third", slug: "third", sortOrder: 30 });
    await seedCategory({ name: "First", slug: "first", sortOrder: 10 });
    await seedCategory({ name: "Second", slug: "second", sortOrder: 20 });

    expect(slugsOf(await agent.get("/api/categories").expect(200))).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(slugsOf(await agent.get("/api/categories?sort=sortOrder&order=desc").expect(200))).toEqual(
      ["third", "second", "first"],
    );
    expect(slugsOf(await agent.get("/api/categories?sort=name&order=asc").expect(200))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("breaks ties deterministically so a page boundary cannot skip a row", async () => {
    // Every new category defaults to sortOrder 0, which is the realistic case rather
    // than a contrived one: an unordered catalog is entirely ties.
    const names = ["delta", "charlie", "alpha", "bravo"];

    for (const name of names) {
      await seedCategory({ name, slug: name });
    }

    expect(slugsOf(await agent.get("/api/categories?limit=2").expect(200))).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(slugsOf(await agent.get("/api/categories?page=2&limit=2").expect(200))).toEqual([
      "charlie",
      "delta",
    ]);
  });

  it("refuses an unknown sort column, order, or page", async () => {
    await agent.get("/api/categories?sort=id").expect(400);
    await agent.get("/api/categories?order=asc,desc").expect(400);
    await agent.get("/api/categories?page=-1").expect(400);
    await agent.get("/api/categories?limit=0").expect(400);
    await agent.get("/api/categories?limit=101").expect(400);
  });

  it("reads one category, and 404s for a missing or malformed id", async () => {
    const category = await seedCategory({ name: "Diving", slug: "diving" });

    expect(dataOf<CategoryRow>(await agent.get(`/api/categories/${category.id}`).expect(200))).toMatchObject(
      { id: category.id, slug: "diving", parentId: null },
    );

    expect(errorOf(await agent.get(`/api/categories/${crypto.randomUUID()}`)).code).toBe("NOT_FOUND");
    expect(errorOf(await agent.get("/api/categories/not-a-uuid")).code).toBe("VALIDATION_ERROR");
  });
});

/**
 * The write rules.
 *
 * `parent_id` has no database-level self foreign key (see docs/database.md →
 * "Category hierarchy"), so every hierarchy rule below is enforced by
 * `assertValidParent()` and by nothing else. A self-parent, a dangling parent, and a
 * cycle are all reachable states that no constraint would catch, which is exactly why
 * they are asserted here rather than assumed.
 *
 * The walk inside that guard is bounded at 20 iterations. That bound is a safety
 * stop against a pre-existing cycle in the data; it is *not* a maximum depth, and
 * nothing here imposes or asserts one.
 */
describe("categories: writing and hierarchy", () => {
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

  it("creates a category with its defaults, and records it", async () => {
    const res = await agent
      .post("/api/categories")
      .send({ name: "Watches", slug: "watches", description: "Everything on a wrist" })
      .expect(201);

    expect(dataOf<CategoryRow>(res)).toMatchObject({
      name: "Watches",
      slug: "watches",
      description: "Everything on a wrist",
      parentId: null,
      isActive: true,
      sortOrder: 0,
      imageStorageKey: null,
    });

    const audit = await findAuditRows("category.create");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityType).toBe("category");
    expect(audit[0]!.entityId).toBe(dataOf<CategoryRow>(res).id);
  });

  it("creates a child under a parent that exists", async () => {
    const parent = await seedCategory({ name: "Watches", slug: "watches" });

    const child = dataOf<CategoryRow>(
      await agent
        .post("/api/categories")
        .send({ name: "Men's", slug: "mens", parentId: parent.id })
        .expect(201),
    );

    expect(child.parentId).toBe(parent.id);
    expect(slugsOf(await agent.get(`/api/categories?parentId=${parent.id}`).expect(200))).toEqual(["mens"]);
  });

  it("refuses a parent that does not exist, without writing the row", async () => {
    const res = await agent
      .post("/api/categories")
      .send({ name: "Orphan", slug: "orphan", parentId: crypto.randomUUID() });

    expect(res.status).toBe(422);
    expect(errorOf(res).message).toBe("Parent category does not exist");

    const [row] = await db.select().from(categories).where(eq(categories.slug, "orphan"));

    expect(row).toBeUndefined();
  });

  it("rejects a duplicate slug with 409, but allows a duplicate name", async () => {
    await seedCategory({ name: "Watches", slug: "watches" });

    expect(
      errorOf(await agent.post("/api/categories").send({ name: "Timepieces", slug: "watches" })).code,
    ).toBe("CONFLICT");

    // `slug` is the only unique column on `categories`. Two parents may each have a
    // child called "Men's", so a frontend that assumed name uniqueness would be wrong.
    await agent.post("/api/categories").send({ name: "Watches", slug: "watches-2" }).expect(201);
  });

  it("validates the body before touching the database", async () => {
    await agent.post("/api/categories").send({ slug: "valid" }).expect(400);
    await agent.post("/api/categories").send({ name: "   ", slug: "valid" }).expect(400);
    await agent.post("/api/categories").send({ name: "Valid", slug: "Not A Slug" }).expect(400);
    await agent.post("/api/categories").send({ name: "Valid", slug: "valid", sortOrder: -1 }).expect(400);
    await agent
      .post("/api/categories")
      .send({ name: "Valid", slug: "valid", sortOrder: 1_000_001 })
      .expect(400);
    await agent.post("/api/categories").send({ name: "Valid", slug: "valid", parentId: "nope" }).expect(400);

    const [anyRow] = await db.select().from(categories);

    expect(anyRow).toBeUndefined();
  });

  it("patches only the fields it is sent, and moves updatedAt", async () => {
    const created = dataOf<CategoryRow>(
      await agent
        .post("/api/categories")
        .send({ name: "Diving", slug: "diving", description: "Wet", sortOrder: 3 })
        .expect(201),
    );

    // `updatedAt` is written explicitly by the service, so the sleep only has to
    // clear millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const patched = dataOf<CategoryRow>(
      await agent
        .patch(`/api/categories/${created.id}`)
        .send({ name: "Professional Diving" })
        .expect(200),
    );

    expect(patched.name).toBe("Professional Diving");
    expect(patched.slug).toBe("diving");
    expect(patched.description).toBe("Wet");
    expect(patched.sortOrder).toBe(3);
    expect(new Date(patched.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());

    expect(await findAuditRows("category.update")).toHaveLength(1);
  });

  it("404s an update for a missing id, and 400s a malformed one", async () => {
    expect(
      errorOf(await agent.patch(`/api/categories/${crypto.randomUUID()}`).send({ name: "Ghost" })).code,
    ).toBe("NOT_FOUND");

    await agent.patch("/api/categories/not-a-uuid").send({ name: "Ghost" }).expect(400);

    const existing = await seedCategory({ slug: "watches" });

    await agent.patch(`/api/categories/${existing.id}`).send({ slug: "Up Per Is" }).expect(400);
  });

  it("refuses a self-parent on update", async () => {
    const category = await seedCategory({ name: "Watches", slug: "watches" });

    const res = await agent.patch(`/api/categories/${category.id}`).send({ parentId: category.id });

    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("A category cannot be its own parent");

    const [row] = await db.select().from(categories).where(eq(categories.id, category.id));

    expect(row!.parentId).toBeNull();
  });

  it("refuses a parent that would create a cycle, at every distance", async () => {
    const root = await seedCategory({ name: "Watches", slug: "watches" });
    const child = await seedCategory({ name: "Men's", slug: "mens", parentId: root.id });
    const grandchild = await seedCategory({ name: "Dive", slug: "dive", parentId: child.id });

    // Direct: make the root a child of its own grandchild.
    const direct = await agent.patch(`/api/categories/${root.id}`).send({ parentId: grandchild.id });

    expect(direct.status).toBe(400);
    expect(errorOf(direct).message).toBe("This parent would create a circular category relationship");

    // One level further away: the same rule, walking two ancestors.
    expect((await agent.patch(`/api/categories/${child.id}`).send({ parentId: grandchild.id })).status).toBe(400);

    // Nothing moved, so the tree is still a tree.
    expect(dataOf<CategoryRow>(await agent.get(`/api/categories/${root.id}`).expect(200)).parentId).toBeNull();
    expect(dataOf<CategoryRow>(await agent.get(`/api/categories/${child.id}`).expect(200)).parentId).toBe(root.id);
  });

  it("re-parents a subtree, and promotes it to a root with null", async () => {
    const watches = await seedCategory({ name: "Watches", slug: "watches" });
    const clocks = await seedCategory({ name: "Clocks", slug: "clocks" });
    const mens = await seedCategory({ name: "Men's", slug: "mens", parentId: watches.id });

    const moved = dataOf<CategoryRow>(
      await agent.patch(`/api/categories/${mens.id}`).send({ parentId: clocks.id }).expect(200),
    );

    expect(moved.parentId).toBe(clocks.id);
    expect(slugsOf(await agent.get(`/api/categories?parentId=${watches.id}`).expect(200))).toEqual([]);
    expect(slugsOf(await agent.get(`/api/categories?parentId=${clocks.id}`).expect(200))).toEqual(["mens"]);

    // Omitting the field keeps the current parent; sending `null` clears it. The two
    // payloads mean different things and a frontend has to be able to rely on that.
    const untouched = dataOf<CategoryRow>(
      await agent.patch(`/api/categories/${mens.id}`).send({ name: "Men" }).expect(200),
    );

    expect(untouched.parentId).toBe(clocks.id);

    const promoted = dataOf<CategoryRow>(
      await agent.patch(`/api/categories/${mens.id}`).send({ parentId: null }).expect(200),
    );

    expect(promoted.parentId).toBeNull();
  });

  it("refuses a re-parent onto a category that does not exist", async () => {
    const category = await seedCategory({ name: "Watches", slug: "watches" });

    const res = await agent.patch(`/api/categories/${category.id}`).send({ parentId: crypto.randomUUID() });

    expect(res.status).toBe(422);
    expect(errorOf(res).message).toBe("Parent category does not exist");
  });

  it("refuses to delete a category that still has children", async () => {
    const parent = await seedCategory({ name: "Watches", slug: "watches" });

    await seedCategory({ name: "Men's", slug: "mens", parentId: parent.id });

    const res = await agent.delete(`/api/categories/${parent.id}`);

    expect(res.status).toBe(422);
    expect(errorOf(res).message).toBe("Cannot delete a category that still has child categories");

    // The guard runs before the delete, so the parent is still readable.
    await agent.get(`/api/categories/${parent.id}`).expect(200);
  });

  it("refuses to delete a category that is assigned to a product", async () => {
    const category = await seedCategory({ name: "Watches", slug: "watches" });
    const product = await seedProduct();

    await seedProductCategory(product.id, category.id);

    const res = await agent.delete(`/api/categories/${category.id}`);

    expect(res.status).toBe(422);
    expect(errorOf(res).message).toBe("Cannot delete a category that is still assigned to products");

    await agent.get(`/api/categories/${category.id}`).expect(200);
  });

  it("deletes a leaf, records it, and unwinds the tree bottom-up", async () => {
    const parent = await seedCategory({ name: "Watches", slug: "watches" });
    const leaf = await seedCategory({ name: "Men's", slug: "mens", parentId: parent.id });

    expect(dataOf(await agent.delete(`/api/categories/${leaf.id}`).expect(200))).toEqual({ deleted: true });

    await agent.get(`/api/categories/${leaf.id}`).expect(404);

    // Only now is the parent deletable: a category is never silently detached from
    // its children, and children are never cascaded away.
    await agent.delete(`/api/categories/${parent.id}`).expect(200);

    const audit = await findAuditRows("category.delete");

    expect(audit).toHaveLength(2);
    expect(audit.map((row) => row.entityId).sort()).toEqual([leaf.id, parent.id].sort());
  });

  it("404s a missing delete target, and 400s a malformed one", async () => {
    expect(errorOf(await agent.delete(`/api/categories/${crypto.randomUUID()}`)).code).toBe("NOT_FOUND");
    await agent.delete("/api/categories/not-a-uuid").expect(400);
  });
});

describe("categories: authorization", () => {
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

    expect((await anonymous.get("/api/categories")).status).toBe(401);
    expect((await anonymous.get(`/api/categories/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await anonymous.post("/api/categories").send({ name: "X", slug: "x" })).status).toBe(401);
    expect((await anonymous.patch(`/api/categories/${crypto.randomUUID()}`).send({ name: "X" })).status).toBe(401);
    expect((await anonymous.delete(`/api/categories/${crypto.randomUUID()}`)).status).toBe(401);
  });

  it("grants the whole surface to all three roles, since none lacks categories.manage", async () => {
    for (const role of ["owner", "manager", "editor"] as const) {
      const agent = await agentFor(role);

      const created = dataOf<CategoryRow>(
        await agent.post("/api/categories").send({ name: `Root ${role}`, slug: `root-${role}` }).expect(201),
      );

      await agent.get("/api/categories").expect(200);
      await agent.get(`/api/categories/${created.id}`).expect(200);
      await agent.patch(`/api/categories/${created.id}`).send({ sortOrder: 2 }).expect(200);
      await agent.delete(`/api/categories/${created.id}`).expect(200);
    }
  });

  it("applies CSRF protection to the mutating routes only", async () => {
    const category = await seedCategory({ slug: "watches" });

    // Log in same-origin, then replay those cookies from a foreign origin: a hostile
    // page cannot read the victim's cookies but can make the browser send them, so
    // the Origin check is what stops the forged request.
    const tokens = readAuthCookies(await login(createAgent(), {
      email: (await seedAdmin(testAdmin.owner)).email,
      password: DEFAULT_ADMIN_PASSWORD,
    }));

    const forged = createCrossSiteAgent().set("Cookie", cookieHeaderFor(tokens));

    expect(errorOf(await forged.post("/api/categories").send({ name: "W", slug: "w-2" })).code).toBe(
      "CSRF_REJECTED",
    );
    expect(errorOf(await forged.patch(`/api/categories/${category.id}`).send({ name: "W" })).code).toBe(
      "CSRF_REJECTED",
    );
    expect(errorOf(await forged.delete(`/api/categories/${category.id}`)).code).toBe("CSRF_REJECTED");

    // A safe method carries no side effect, so the origin guard must not reject it.
    await forged.get("/api/categories").expect(200);

    // And the mutations themselves never reached the database.
    expect(await countRows(handle, "categories")).toBe(1);
  });
});
