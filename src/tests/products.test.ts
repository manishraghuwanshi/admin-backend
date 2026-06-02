import { eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { inventory, products, watchDetails } from "../db/schema.js";
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
import { seedBrand, seedCategory, seedProduct, seedProductCategory } from "./helpers/catalog.js";
import { MAX_SAFE_AMOUNT } from "../utils/schemas.js";

/**
 * `/api/products`.
 *
 * The module with the most rules in the API, and the one `admin-frontend` will lean
 * on hardest: a nested write (watch details, categories, stock) inside a transaction,
 * a price bound PostgreSQL alone cannot enforce, and the only `403` in the catalog
 * that a real role difference can produce - `products.delete` is withheld from
 * `editor`. That last one is asserted over HTTP rather than against `permissions.ts`,
 * because a permission nobody enforces is indistinguishable from one nobody has.
 *
 * Object Storage is deliberately not mocked here: the test environment carries no
 * storage credentials, so signed URLs are absent and the read model is asserted as
 * the un-resolved shape. The delete path's object cleanup is covered in
 * `product-delete-storage.test.ts`, where the client is stubbed.
 */

interface ProductRow {
  id: string;
  brandId: string;
  name: string;
  slug: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  shortDescription: string | null;
  description: string | null;
  thumbnailStorageKey: string | null;
  isActive: boolean;
  isFeatured: boolean;
  updatedAt?: string;
  url?: string;
  thumbnailUrl?: string;
  brand?: { id: string; name: string };
  inventory?: { quantity: number; reservedQuantity: number; lowStockThreshold: number } | null;
  watchDetails?: Record<string, unknown> | null;
  categories?: Array<{ id: string; slug: string }>;
  images?: Array<{ id: string; storageKey: string }>;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Logs a seeded administrator in over HTTP.
 *
 * `base` lets a caller reuse one agent for several accounts: each login appends its
 * own cookies, so the resulting header carries a session per role, which is how the
 * same-role writers in the concurrency test get distinct sessions without tripping
 * the unique email constraint on `admin_users`.
 */
async function agentFor(role: keyof typeof testAdmin, base: Agent = createAgent()): Promise<Agent> {
  const admin = await seedAdmin(testAdmin[role]);

  await login(base, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return base;
}

const rowsOf = (res: Response) => dataOf<ProductRow[]>(res);
const metaOf = (res: Response) => (res.body as { pagination: Pagination }).pagination;
const skusOf = (res: Response) => rowsOf(res).map((row) => row.sku);

/**
 * The dotted path of each validation issue the API reported.
 *
 * Every rejected body carries the same client-facing message ("Validation failed"),
 * with the Zod issues in `error.details`. Which field failed is therefore only
 * observable through `details`, which is exactly what a form needs to highlight — so
 * asserting on it pins the contract the frontend depends on rather than the prose.
 */
function issuePathsOf(res: Response): string[] {
  const details = (res.body as { error?: { details?: unknown } }).error?.details;

  if (!Array.isArray(details)) {
    return [];
  }

  return details.map((issue) => {
    const path = (issue as { path?: unknown[] }).path ?? [];

    return path.map(String).join(".");
  });
}

/** The minimal valid create payload, so each test overrides only what it tests. */
function productBody(overrides: Record<string, unknown> = {}) {
  return { name: "Marine Master", slug: "marine-master", sku: "MM-001", price: 42_000, ...overrides };
}

async function create(agent: Agent, body: Record<string, unknown>, status = 201): Promise<ProductRow> {
  const res = await agent.post("/api/products").send(body);

  expect(res.status).toBe(status);

  return dataOf<ProductRow>(res);
}


describe("products: reading", () => {
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

  it("always returns the paginated envelope, with brand and stock attached", async () => {
    await seedProduct({ sku: "MM-001" });

    const bare = await agent.get("/api/products").expect(200);

    expect(bare.body.success).toBe(true);
    expect(metaOf(bare)).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });

    // The list is the dashboard's table source, so it carries the relations a row is
    // rendered from. `inventory` is null rather than missing for a product with no
    // stock row, which lets a frontend distinguish "zero stock" from "not tracked".
    const [row] = rowsOf(bare);

    expect(row!.brand).toMatchObject({ id: row!.brandId });
    expect(row!.inventory).toBeNull();

    for (const url of ["/api/products?page=1", "/api/products?limit=5"]) {
      expect(metaOf(await agent.get(url).expect(200))).toMatchObject({ page: 1, total: 1 });
    }
  });

  it("returns an empty page with a zeroed total", async () => {
    const res = await agent.get("/api/products").expect(200);

    expect(rowsOf(res)).toEqual([]);
    expect(metaOf(res)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it("searches name, slug, and sku together, case-insensitively", async () => {
    await seedProduct({ name: "Marine Master", slug: "marine-master", sku: "MM-001" });
    await seedProduct({ name: "Field Kit", slug: "field-kit", sku: "FK-900" });

    expect(skusOf(await agent.get("/api/products?search=marine").expect(200))).toEqual(["MM-001"]);
    expect(skusOf(await agent.get("/api/products?search=FIELD-KIT").expect(200))).toEqual(["FK-900"]);
    expect(skusOf(await agent.get("/api/products?search=fk-9").expect(200))).toEqual(["FK-900"]);
    expect(skusOf(await agent.get("/api/products?search=nothing").expect(200))).toEqual([]);
  });

  it("filters by brand, category, isActive, and isFeatured", async () => {
    const seiko = await seedBrand({ name: "Seiko", slug: "seiko" });
    const casio = await seedBrand({ name: "Casio", slug: "casio" });
    const diving = await seedCategory({ name: "Diving", slug: "diving" });

    const diver = await seedProduct({ brandId: seiko.id, sku: "MM-001", isFeatured: true });
    await seedProduct({ brandId: casio.id, sku: "FK-900", isActive: false });
    await seedProductCategory(diver.id, diving.id);

    expect(skusOf(await agent.get(`/api/products?brandId=${seiko.id}`).expect(200))).toEqual(["MM-001"]);
    expect(skusOf(await agent.get(`/api/products?categoryId=${diving.id}`).expect(200))).toEqual(["MM-001"]);
    expect(skusOf(await agent.get(`/api/products?categoryId=${crypto.randomUUID()}`).expect(200))).toEqual([]);
    expect(skusOf(await agent.get("/api/products?isActive=false").expect(200))).toEqual(["FK-900"]);
    expect(skusOf(await agent.get("/api/products?isFeatured=true").expect(200))).toEqual(["MM-001"]);

    // Filters compose, which is what makes one "featured diver from Seiko" query
    // possible instead of three round trips.
    expect(
      skusOf(
        await agent.get(`/api/products?brandId=${seiko.id}&categoryId=${diving.id}&isFeatured=true`).expect(200),
      ),
    ).toEqual(["MM-001"]);
  });

  it("filters by price range inclusively", async () => {
    await seedProduct({ sku: "LOW-1", price: 1_000 });
    await seedProduct({ sku: "MID-1", price: 5_000 });
    await seedProduct({ sku: "HIGH-1", price: 9_000 });

    expect(skusOf(await agent.get("/api/products?minPrice=5000&sort=price&order=asc").expect(200))).toEqual([
      "MID-1",
      "HIGH-1",
    ]);
    expect(skusOf(await agent.get("/api/products?maxPrice=5000&sort=price&order=asc").expect(200))).toEqual([
      "LOW-1",
      "MID-1",
    ]);
    expect(skusOf(await agent.get("/api/products?minPrice=2000&maxPrice=8000").expect(200))).toEqual(["MID-1"]);
  });

  it("sorts by every allowed column in both directions", async () => {
    const zulu = await seedProduct({ sku: "AAA", name: "Zulu", price: 300 });
    await seedProduct({ sku: "BBB", name: "Alpha", price: 100 });
    const mike = await seedProduct({ sku: "CCC", name: "Mike", price: 200 });

    expect(skusOf(await agent.get("/api/products?sort=price&order=asc").expect(200))).toEqual(["BBB", "CCC", "AAA"]);
    expect(skusOf(await agent.get("/api/products?sort=price&order=desc").expect(200))).toEqual(["AAA", "CCC", "BBB"]);
    expect(skusOf(await agent.get("/api/products?sort=name&order=asc").expect(200))).toEqual(["BBB", "CCC", "AAA"]);

    // Timestamps come from the database, and two rows stamped in the same instant
    // would make the *time* order meaningless rather than merely tied. Pushing rows
    // apart gives the assertion something real to order by.
    await db.update(products).set({ createdAt: new Date("2020-01-01T00:00:00Z") }).where(eq(products.id, zulu.id));
    await db.update(products).set({ createdAt: new Date("2021-01-01T00:00:00Z") }).where(eq(products.id, mike.id));

    expect(skusOf(await agent.get("/api/products?sort=createdAt&order=asc").expect(200))).toEqual(["AAA", "CCC", "BBB"]);

    // The default is newest first, which is what a catalog landing page wants.
    expect(skusOf(await agent.get("/api/products").expect(200))).toEqual(["BBB", "CCC", "AAA"]);

    // Every `updatedAt` is pinned, so this assertion compares three distinct values
    // rather than three rows the database happened to stamp in the same millisecond.
    await db.update(products).set({ updatedAt: new Date("2030-01-01T00:00:00Z") }).where(eq(products.id, zulu.id));
    await db
      .update(products)
      .set({ updatedAt: new Date("2029-01-01T00:00:00Z") })
      .where(eq(products.id, mike.id));

    expect(skusOf(await agent.get("/api/products?sort=updatedAt&order=desc").expect(200))).toEqual([
      "AAA",
      "CCC",
      "BBB",
    ]);
  });

  it("breaks ties on sku so a page boundary cannot repeat or drop a row", async () => {
    // Products created in one batch share a timestamp and, often, a price, so a page
    // split on either column lands entirely on ties.
    for (const sku of ["delta", "charlie", "alpha", "bravo"]) {
      await seedProduct({ sku, price: 100 });
    }

    expect(skusOf(await agent.get("/api/products?sort=price&limit=2&order=asc").expect(200))).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(skusOf(await agent.get("/api/products?sort=price&limit=2&page=2&order=asc").expect(200))).toEqual([
      "charlie",
      "delta",
    ]);
  });

  it("paginates without repeating or dropping a row", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await seedProduct({ sku: `SKU-${index}`, name: `Row ${index}` });
    }

    const pages = [
      skusOf(await agent.get("/api/products?limit=2&page=1&sort=name&order=asc").expect(200)),
      skusOf(await agent.get("/api/products?limit=2&page=2&sort=name&order=asc").expect(200)),
      skusOf(await agent.get("/api/products?limit=2&page=3&sort=name&order=asc").expect(200)),
      skusOf(await agent.get("/api/products?limit=2&page=4&sort=name&order=asc").expect(200)),
    ];

    expect(pages[0]).toEqual(["SKU-1", "SKU-2"]);
    expect(pages[1]).toEqual(["SKU-3", "SKU-4"]);
    // The last page is a remainder, and past it the list is empty rather than
    // wrapping back to page 1.
    expect(pages[2]).toEqual(["SKU-5"]);
    expect(pages[3]).toEqual([]);
    expect(metaOf(await agent.get("/api/products?limit=2&page=1").expect(200))).toMatchObject({
      total: 5,
      totalPages: 3,
    });
  });

  it("refuses an unknown sort, order, page, limit, or relation id", async () => {
    await agent.get("/api/products?sort=id").expect(400);
    await agent.get("/api/products?order=sideways").expect(400);
    await agent.get("/api/products?page=0").expect(400);
    await agent.get("/api/products?limit=101").expect(400);
    await agent.get("/api/products?brandId=not-a-uuid").expect(400);
    await agent.get("/api/products?categoryId=not-a-uuid").expect(400);
    await agent.get("/api/products?minPrice=-1").expect(400);
    await agent.get("/api/products?maxPrice=not-a-number").expect(400);
  });

  it("reads one product as the nested read model", async () => {
    const category = await seedCategory({ name: "Diving", slug: "diving" });
    const product = await seedProduct({ sku: "MM-001" });
    const other = await seedCategory({ name: "Dress", slug: "dress" });

    await seedProductCategory(product.id, category.id);
    await seedProductCategory(product.id, other.id);

    await db.insert(watchDetails).values({ productId: product.id, movement: "Automatic" });
    await db.insert(inventory).values({ productId: product.id, quantity: 7, reservedQuantity: 2 });

    const body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(body.brand).toMatchObject({ id: product.brandId });
    expect(body.categories?.map((row) => row.slug).sort()).toEqual(["diving", "dress"]);
    expect(body.watchDetails).toMatchObject({ movement: "Automatic" });
    expect(body.inventory).toMatchObject({ quantity: 7, reservedQuantity: 2 });
    expect(body.images).toEqual([]);

    // With no storage credentials there is no bucket to sign against, so the read
    // model simply omits `url` rather than returning one that would 404.
    expect(body.url).toBeUndefined();
    expect(body.thumbnailUrl).toBeUndefined();

    // The junction rows are flattened into `categories` deliberately: the frontend
    // should not have to unwrap a join table to render a product.
    expect((body as unknown as Record<string, unknown>).productCategories).toBeUndefined();
  });

  it("404s a missing product and 400s a malformed id", async () => {
    expect(errorOf(await agent.get(`/api/products/${crypto.randomUUID()}`)).code).toBe("NOT_FOUND");
    expect(errorOf(await agent.get("/api/products/not-a-uuid")).code).toBe("VALIDATION_ERROR");
  });
});

describe("products: creating", () => {
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

  it("creates a product with its defaults and a stock row", async () => {
    const brand = await seedBrand({ name: "Seiko", slug: "seiko" });

    const body = await create(agent, productBody({ brandId: brand.id }));

    expect(body).toMatchObject({
      brandId: brand.id,
      name: "Marine Master",
      slug: "marine-master",
      sku: "MM-001",
      price: 42_000,
      compareAtPrice: null,
      currency: "INR",
      isActive: true,
      isFeatured: false,
      shortDescription: null,
      description: null,
      thumbnailStorageKey: null,
    });

    // A product is created with its inventory row in the same transaction, so the
    // stock endpoint never has to handle "this product has no stock row yet".
    expect(body.inventory).toMatchObject({ quantity: 0, reservedQuantity: 0, lowStockThreshold: 5 });
    expect(body.watchDetails).toBeNull();
    expect(body.categories).toEqual([]);

    const audit = await findAuditRows("product.create");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityType).toBe("product");
    expect(audit[0]!.metadata).toMatchObject({ sku: "MM-001", slug: "marine-master" });
  });

  it("creates watch details, categories, and stock in one nested write", async () => {
    const brand = await seedBrand();
    const diving = await seedCategory({ name: "Diving", slug: "diving" });
    const dress = await seedCategory({ name: "Dress", slug: "dress" });

    const body = await create(
      agent,
      productBody({
        brandId: brand.id,
        categoryIds: [diving.id, dress.id, diving.id],
        watchDetails: {
          movement: "Automatic",
          caseMaterial: "Stainless steel",
          caseDiameter: 42,
          waterResistance: "200m",
          gender: "Men's",
          additionalSpecifications: { lugWidth: "22mm" },
        },
        inventory: { quantity: 12, reservedQuantity: 3, lowStockThreshold: 2 },
        shortDescription: "A diver",
        description: "A proper diver",
        compareAtPrice: 48_000,
        isFeatured: true,
      }),
    );

    expect(body.categories?.map((row) => row.slug).sort()).toEqual(["diving", "dress"]);
    expect(body.watchDetails).toMatchObject({
      movement: "Automatic",
      caseMaterial: "Stainless steel",
      // Numbers are stored as text so a value like "42mm" is as acceptable as 42.
      caseDiameter: "42",
      waterResistance: "200m",
      additionalSpecifications: { lugWidth: "22mm" },
    });
    expect(body.inventory).toMatchObject({ quantity: 12, reservedQuantity: 3, lowStockThreshold: 2 });
    expect(body.shortDescription).toBe("A diver");
    expect(body.compareAtPrice).toBe(48_000);
    expect(body.isFeatured).toBe(true);

    // The duplicate id in `categoryIds` was collapsed rather than inserted twice.
    expect(await countRows(handle, "product_categories")).toBe(2);
  });

  it("requires a brand that exists, and categories that exist", async () => {
    // These two are semantic rather than structural, so they answer 422 with a
    // specific message, unlike a malformed body.
    expect(
      errorOf(await agent.post("/api/products").send(productBody({ brandId: crypto.randomUUID() }))),
    ).toMatchObject({ message: "Brand does not exist" });

    const brand = await seedBrand();

    expect(
      errorOf(
        await agent
          .post("/api/products")
          .send(productBody({ brandId: brand.id, categoryIds: [crypto.randomUUID()] })),
      ),
    ).toMatchObject({ message: "One or more categories do not exist" });

    // Both checks run before the insert, so a rejected create leaves no orphan.
    expect(await countRows(handle, "products")).toBe(0);
    expect(await countRows(handle, "product_categories")).toBe(0);
  });

  it("rejects a duplicate slug or sku with 409", async () => {
    const brand = await seedBrand();

    await create(agent, productBody({ brandId: brand.id }));

    expect(errorOf(await agent.post("/api/products").send(productBody({ brandId: brand.id, sku: "MM-002" }))).code).toBe(
      "CONFLICT",
    );
    expect(
      errorOf(await agent.post("/api/products").send(productBody({ brandId: brand.id, slug: "marine-master" }))).code,
    ).toBe("CONFLICT");

    expect(await countRows(handle, "products")).toBe(1);
  });

  it("validates the shape of the body before touching the database", async () => {
    const brand = await seedBrand();

    await agent.post("/api/products").send(productBody({ brandId: brand.id, price: -1 })).expect(400);
    await agent.post("/api/products").send(productBody({ brandId: brand.id, price: 1.5 })).expect(400);
    await agent.post("/api/products").send(productBody({ brandId: brand.id, price: "42000" })).expect(400);
    await agent.post("/api/products").send(productBody({ brandId: brand.id, currency: "RUPEES" })).expect(400);
    await agent.post("/api/products").send(productBody({ brandId: brand.id, slug: "Marine Master" })).expect(400);
    await agent.post("/api/products").send({ ...productBody({ brandId: brand.id }), name: "" }).expect(400);
    await agent.post("/api/products").send(productBody({ brandId: brand.id, sku: "x".repeat(101) })).expect(400);
    await agent
      .post("/api/products")
      .send(productBody({ brandId: brand.id, categoryIds: ["not-a-uuid"] }))
      .expect(400);

    expect(await countRows(handle, "products")).toBe(0);
  });

  it("refuses a price above the safe integer range, while PostgreSQL would accept it", async () => {
    const brand = await seedBrand();

    expect(MAX_SAFE_AMOUNT).toBe(Number.MAX_SAFE_INTEGER);

    // `products.price` is a bigint, so the column will happily store far more. Drizzle
    // reads and writes it in `number` mode, so a larger value would come back silently
    // rounded - a monetary amount that changes when you look at it. The ceiling is
    // therefore enforced at the boundary, on both price fields.
    const beyond = MAX_SAFE_AMOUNT + 1;

    expect(
      errorOf(await agent.post("/api/products").send(productBody({ brandId: brand.id, price: beyond }))).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      errorOf(
        await agent
          .post("/api/products")
          .send(productBody({ brandId: brand.id, compareAtPrice: beyond })),
      ).code,
    ).toBe("VALIDATION_ERROR");

    // The boundary itself is inclusive, and is exact rather than rounded.
    const atLimit = await create(agent, productBody({ brandId: brand.id, price: MAX_SAFE_AMOUNT }));

    expect(atLimit.price).toBe(MAX_SAFE_AMOUNT);

    expect(
      errorOf(await agent.get(`/api/products?minPrice=${MAX_SAFE_AMOUNT + 1}`)).code,
    ).toBe("VALIDATION_ERROR");
    expect(metaOf(await agent.get(`/api/products?minPrice=${MAX_SAFE_AMOUNT}`).expect(200))).toMatchObject({
      total: 1,
    });
  });

  it("refuses a compareAtPrice below price", async () => {
    const brand = await seedBrand();

    const res = await agent
      .post("/api/products")
      .send(productBody({ brandId: brand.id, price: 5_000, compareAtPrice: 4_000 }));

    expect(res.status).toBe(400);
    expect(issuePathsOf(res)).toContain("compareAtPrice");

    // `null` clears it, which is not the same as omitting it, and equality is allowed.
    await create(agent, productBody({ brandId: brand.id, price: 5_000, compareAtPrice: 5_000 }));
    expect(await countRows(handle, "products")).toBe(1);
  });

  it("refuses a reservation larger than the quantity", async () => {
    const brand = await seedBrand();

    const res = await agent
      .post("/api/products")
      .send(productBody({ brandId: brand.id, inventory: { quantity: 4, reservedQuantity: 5 } }));

    expect(res.status).toBe(400);
    expect(issuePathsOf(res)).toContain("inventory.reservedQuantity");

    // The same rule applies when only the reservation is sent, because the create
    // path defaults quantity to zero.
    expect(
      (await agent.post("/api/products").send(productBody({ brandId: brand.id, inventory: { reservedQuantity: 1 } })))
        .status,
    ).toBe(400);
  });
});

describe("products: updating", () => {
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

  /** A product created through the route, so the nested rows exist as real rows. */
  async function createdProduct(overrides: Record<string, unknown> = {}) {
    const brand = overrides.brandId ? null : await seedBrand();

    return create(agent, productBody(brand ? { brandId: brand.id, ...overrides } : overrides));
  }

  it("patches only the fields it is sent", async () => {
    const product = await createdProduct({ price: 5_000, compareAtPrice: 9_000 });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const res = await agent.patch(`/api/products/${product.id}`).send({ name: "Marine Master II" }).expect(200);
    const body = dataOf<ProductRow>(res);

    expect(body.name).toBe("Marine Master II");
    expect(body.slug).toBe(product.slug);
    expect(body.sku).toBe(product.sku);
    expect(body.price).toBe(5_000);
    expect(body.compareAtPrice).toBe(9_000);
    expect(new Date(body.updatedAt!).getTime()).toBeGreaterThan(new Date(product.updatedAt!).getTime());

    expect(await findAuditRows("product.update")).toHaveLength(1);
  });

  it("replaces the category set rather than adding to it", async () => {
    const product = await createdProduct();
    const diving = await seedCategory({ name: "Diving", slug: "diving" });
    const dress = await seedCategory({ name: "Dress", slug: "dress" });

    await agent.patch(`/api/products/${product.id}`).send({ categoryIds: [diving.id] }).expect(200);
    await agent.patch(`/api/products/${product.id}`).send({ categoryIds: [dress.id] }).expect(200);

    const body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    // Sending a list is "these are the categories now", so the previous membership
    // disappears. A frontend that expected additive behaviour would show a product
    // in two categories when the database says one.
    expect(body.categories?.map((row) => row.slug)).toEqual(["dress"]);
    expect(await countRows(handle, "product_categories")).toBe(1);

    // An empty list clears the membership; omitting the field leaves it alone.
    await agent.patch(`/api/products/${product.id}`).send({ name: "Kept" }).expect(200);

    expect(await countRows(handle, "product_categories")).toBe(1);

    await agent.patch(`/api/products/${product.id}`).send({ categoryIds: [] }).expect(200);

    expect(await countRows(handle, "product_categories")).toBe(0);
  });

  it("upserts watch details, and does not clear them when omitted", async () => {
    const product = await createdProduct();

    await agent.patch(`/api/products/${product.id}`).send({ watchDetails: { movement: "Automatic" } }).expect(200);

    let body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(body.watchDetails).toMatchObject({ movement: "Automatic", caseMaterial: null });
    expect(await countRows(handle, "watch_details")).toBe(1);

    // A second send updates the same row instead of inserting a duplicate.
    await agent.patch(`/api/products/${product.id}`).send({ watchDetails: { caseMaterial: "Steel" } }).expect(200);

    body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(await countRows(handle, "watch_details")).toBe(1);
    expect(body.watchDetails).toMatchObject({ caseMaterial: "Steel" });

    // Omitting the block must not wipe it: the update is partial for the nested
    // objects too.
    await agent.patch(`/api/products/${product.id}`).send({ name: "Still specified" }).expect(200);

    body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(body.watchDetails).toMatchObject({ caseMaterial: "Steel" });
  });

  it("carries over the stock fields it is not sent, and refuses an impossible reservation", async () => {
    const product = await createdProduct({ inventory: { quantity: 20, reservedQuantity: 4, lowStockThreshold: 6 } });

    // A partial absolute set: sending only `quantity` must keep the other two, which
    // is why the row has to be read before it is written - and why that read has to
    // be locked.
    let body = dataOf<ProductRow>(
      await agent.patch(`/api/products/${product.id}`).send({ inventory: { quantity: 30 } }).expect(200),
    );

    expect(body.inventory).toMatchObject({ quantity: 30, reservedQuantity: 4, lowStockThreshold: 6 });

    // Two different guards, in two different places. A payload that contradicts
    // itself is a 400 from the schema:
    const selfContradictory = await agent
      .patch(`/api/products/${product.id}`)
      .send({ inventory: { quantity: 2, reservedQuantity: 4 } });

    expect(selfContradictory.status).toBe(400);
    expect(issuePathsOf(selfContradictory)).toContain("inventory.reservedQuantity");

    // A payload that is valid on its own but impossible once the carried-over
    // reservation is applied is a 422 from the service, because the row it is being
    // merged with is what makes it wrong.
    const res = await agent.patch(`/api/products/${product.id}`).send({ inventory: { quantity: 2 } });

    expect(res.status).toBe(422);
    expect(errorOf(res).message).toContain("reservedQuantity");

    // The rejected write left the row exactly as it was.
    body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(body.inventory).toMatchObject({ quantity: 30, reservedQuantity: 4 });
  });

  it("loses neither a concurrent nested set nor a concurrent adjustment", async () => {
    const product = await createdProduct({ inventory: { quantity: 100, lowStockThreshold: 5 } });

    // The nested payload is a partial absolute set: a field the caller omits is
    // carried over from the row, and that carry-over is the read that has to happen
    // under the row lock. So the request that detects an unlocked read is not a
    // second nested set - two absolute sets are *supposed* to race to last-write-wins
    // - it is the relative `POST /adjust` landing in between.
    //
    // A nested set of `lowStockThreshold` alone must carry `quantity` forward. With
    // the lock, it reads whatever quantity is committed at that moment, so the +10
    // from the adjustment survives in every interleaving and the result is always 110.
    // Read unlocked, the set can capture 100 before the adjustment commits and write
    // it back after, silently deleting the +10 - which is exactly the bug the shared
    // `lib/inventory-lock.ts` exists to prevent.
    for (let round = 1; round <= 4; round += 1) {
      const [a, b] = await Promise.all([
        agent.post(`/api/inventory/${product.id}/adjust`).send({ delta: 10 }),
        agent.patch(`/api/products/${product.id}`).send({ inventory: { lowStockThreshold: 7 } }),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

      // Every adjustment so far is accounted for, so no set ever rewound a quantity
      // it had read before the adjustment committed.
      expect(body.inventory).toMatchObject({
        quantity: 100 + round * 10,
        reservedQuantity: 0,
        lowStockThreshold: 7,
      });
    }
  });

  it("applies one nested set whole, rather than tearing it across writers", async () => {
    const product = await createdProduct({ inventory: { quantity: 100, reservedQuantity: 10 } });

    // Two self-consistent absolute sets racing. Whichever commits last wins as a
    // unit; a write that updated each column separately could land the quantity of
    // one request with the reservation of the other, leaving a row that no caller
    // asked for.
    const writers = [
      { quantity: 40, reservedQuantity: 5 },
      { quantity: 60, reservedQuantity: 20 },
    ];

    const results = await Promise.all(
      writers.map((set) => agent.patch(`/api/products/${product.id}`).send({ inventory: set })),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    const body = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    const matched = writers.filter(
      (set) => set.quantity === body.inventory!.quantity && set.reservedQuantity === body.inventory!.reservedQuantity,
    );

    expect(matched).toHaveLength(1);
  });

  it("rolls the whole nested write back when a later step fails", async () => {
    const product = await createdProduct({ inventory: { quantity: 8 } });

    const before = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    // A valid name change plus an unknown category: the category check runs before
    // the transaction, so nothing is written, and the pre-existing rows are untouched.
    const res = await agent
      .patch(`/api/products/${product.id}`)
      .send({ name: "Renamed", categoryIds: [crypto.randomUUID()] });

    expect(res.status).toBe(422);

    const after = dataOf<ProductRow>(await agent.get(`/api/products/${product.id}`).expect(200));

    expect(after.name).toBe(before.name);
    expect(after.inventory).toMatchObject({ quantity: 8 });

    // A unique violation raised from inside the transaction must not leave the
    // product renamed while its sku is unchanged.
    const twin = await createdProduct({ sku: "TWIN-1", slug: "twin-1" });

    const clash = await agent
      .patch(`/api/products/${twin.id}`)
      .send({ sku: product.sku, watchDetails: { movement: "Quartz" } });

    expect(clash.status).toBe(409);

    const unchanged = dataOf<ProductRow>(await agent.get(`/api/products/${twin.id}`).expect(200));

    expect(unchanged.sku).toBe("TWIN-1");
    expect(unchanged.watchDetails).toBeNull();
  });

  it("404s an update for a missing product, and 400s a malformed id", async () => {
    expect(errorOf(await agent.patch(`/api/products/${crypto.randomUUID()}`).send({ name: "Ghost" })).code).toBe(
      "NOT_FOUND",
    );
    await agent.patch("/api/products/not-a-uuid").send({ name: "Ghost" }).expect(400);
  });
});

describe("products: deleting", () => {
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

  it("deletes a product and cascades every dependent row", async () => {
    const product = await seedProduct({ sku: "MM-001" });
    const category = await seedCategory({ name: "Diving", slug: "diving" });
    const other = await seedProduct({ sku: "OTHER-1" });

    await seedProductCategory(product.id, category.id);
    await seedProductCategory(other.id, category.id);
    await db.insert(watchDetails).values({ productId: product.id, movement: "Automatic" });
    await db.insert(inventory).values({ productId: product.id, quantity: 3 });

    expect(dataOf(await agent.delete(`/api/products/${product.id}`).expect(200))).toEqual({ deleted: true });

    await agent.get(`/api/products/${product.id}`).expect(404);

    expect(await countRows(handle, "products")).toBe(1);
    expect(await countRows(handle, "watch_details")).toBe(0);
    expect(await countRows(handle, "inventory")).toBe(0);

    // Only this product's junction rows went; the category and its other membership
    // are untouched, because a category is not owned by a product.
    expect(await countRows(handle, "product_categories")).toBe(1);
    expect(await countRows(handle, "categories")).toBe(1);

    const audit = await findAuditRows("product.delete");

    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ sku: "MM-001", slug: product.slug });
  });

  it("leaves the brand in place, because a brand is not owned by a product", async () => {
    const brand = await seedBrand({ name: "Seiko", slug: "seiko" });
    const product = await seedProduct({ brandId: brand.id });

    await agent.delete(`/api/products/${product.id}`).expect(200);

    expect(await countRows(handle, "brands")).toBe(1);
  });

  it("404s a missing product, and 400s a malformed id", async () => {
    expect(errorOf(await agent.delete(`/api/products/${crypto.randomUUID()}`)).code).toBe("NOT_FOUND");
    await agent.delete("/api/products/not-a-uuid").expect(400);
  });
});

/**
 * The only role-distinguishing rule left in the catalog.
 *
 * `products.delete` is held by `owner` and `manager` and withheld from `editor`, so
 * this is the one place in the catalog where a `403` is reachable by a real
 * administrator. It is asserted over HTTP because the permission table alone cannot
 * show that a route actually enforces the permission.
 */
describe("products: authorization", () => {
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

    expect((await anonymous.get("/api/products")).status).toBe(401);
    expect((await anonymous.get(`/api/products/${id}`)).status).toBe(401);
    expect((await anonymous.post("/api/products").send(productBody({ brandId: id }))).status).toBe(401);
    expect((await anonymous.patch(`/api/products/${id}`).send({ name: "x" })).status).toBe(401);
    expect((await anonymous.delete(`/api/products/${id}`)).status).toBe(401);
  });

  it("lets owner and manager delete, and refuses editor with 403", async () => {
    for (const role of ["owner", "manager"] as const) {
      const agent = await agentFor(role);
      const product = await seedProduct({ sku: `DEL-${role}` });

      await agent.delete(`/api/products/${product.id}`).expect(200);
      await agent.get(`/api/products/${product.id}`).expect(404);
    }

    const editor = await agentFor("editor");
    const target = await seedProduct({ sku: "DEL-editor" });

    const res = await editor.delete(`/api/products/${target.id}`);

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("FORBIDDEN");

    // The refusal happens at authorization, so the row survives and the delete was
    // never attempted.
    await editor.get(`/api/products/${target.id}`).expect(200);
    expect(await countRows(handle, "products")).toBe(1);
  });

  it("lets every role read, create, and update, since none lacks products.read or products.write", async () => {
    for (const role of ["owner", "manager", "editor"] as const) {
      const agent = await agentFor(role);
      const brand = await seedBrand({ name: `Brand ${role}`, slug: `brand-${role}` });

      const product = await create(agent, productBody({ brandId: brand.id, sku: `SKU-${role}`, slug: `p-${role}` }));

      await agent.get("/api/products").expect(200);
      await agent.get(`/api/products/${product.id}`).expect(200);
      await agent.patch(`/api/products/${product.id}`).send({ name: "Renamed" }).expect(200);
    }
  });

  it("applies CSRF protection to the mutating routes only", async () => {
    const product = await seedProduct();
    const tokens = readAuthCookies(
      await login(createAgent(), {
        email: (await seedAdmin(testAdmin.owner)).email,
        password: DEFAULT_ADMIN_PASSWORD,
      }),
    );

    const forged = createCrossSiteAgent().set("Cookie", cookieHeaderFor(tokens));

    expect(errorOf(await forged.post("/api/products").send(productBody({ brandId: product.brandId }))).code).toBe(
      "CSRF_REJECTED",
    );
    expect(errorOf(await forged.patch(`/api/products/${product.id}`).send({ name: "X" })).code).toBe("CSRF_REJECTED");
    expect(errorOf(await forged.delete(`/api/products/${product.id}`)).code).toBe("CSRF_REJECTED");

    await forged.get("/api/products").expect(200);
    expect(await countRows(handle, "products")).toBe(1);
  });
});
