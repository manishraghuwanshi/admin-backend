import { eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/index.js";
import { productImages, products } from "../db/schema.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
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
import { seedProduct, seedProductImage } from "./helpers/catalog.js";

/**
 * Product image administration.
 *
 * Object Storage is stubbed. The test environment deliberately carries no storage
 * credentials (`helpers/env.ts` strips them), so the S3 client is replaced with an
 * in-memory map. That makes the interesting paths observable instead of skipped:
 * the compensation rule (a failed insert must remove the object just written) and
 * the rule that only keys inside the `products/` namespace are ever deleted.
 */

const stored = new Map<string, { body: Buffer; contentType: string }>();
let putShouldFail = false;
let deleteShouldFail = false;
/** When set, `putObject` deletes that product, so the following insert hits the FK. */
let dropProductOnPut: string | null = null;

vi.mock("../lib/storage/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage/s3.js")>();

  return {
    ...actual,
    isStorageConfigured: () => true,
    putObject: async (input: { key: string; body: Buffer; contentType: string }) => {
      if (putShouldFail) {
        throw new Error("simulated storage outage");
      }

      if (dropProductOnPut) {
        const productId = dropProductOnPut;
        dropProductOnPut = null;

        await db.delete(productImages).where(eq(productImages.productId, productId));
        await db.delete(products).where(eq(products.id, productId));
      }

      stored.set(input.key, { body: input.body, contentType: input.contentType });
    },
    deleteObject: async (key: string) => {
      if (deleteShouldFail) {
        throw new Error("simulated delete failure");
      }

      stored.delete(key);
    },
    getSignedDownloadUrl: async (key: string) => `https://signed.test/${key}?sig=abc`,
  };
});

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28)]);

const pngPayload = () => PNG_BYTES.toString("base64");
const jpegPayload = () => JPEG_BYTES.toString("base64");

interface ImageRow {
  id: string;
  productId: string;
  storageKey: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
  url: string | null;
}

const imagesOf = (res: Response) => dataOf<ImageRow[]>(res);
const idsOf = (res: Response) => imagesOf(res).map((row) => row.id);
const path = (productId: string, suffix = "") => `/api/products/${productId}/images${suffix}`;

async function imageAgent(role: keyof typeof testAdmin = "owner"): Promise<Agent> {
  const admin = await seedAdmin(testAdmin[role]);
  const agent = createAgent();

  await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return agent;
}

describe("product images: upload", () => {
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
    stored.clear();
    putShouldFail = false;
    deleteShouldFail = false;
    dropProductOnPut = null;
    agent = await imageAgent();
  });

  it("stores the object and the row, and returns a signed URL", async () => {
    const product = await seedProduct();

    const res = await agent
      .post(path(product.id))
      .send({ data: pngPayload(), altText: "Front dial" })
      .expect(201);

    const image = dataOf<ImageRow>(res);

    expect(image.altText).toBe("Front dial");
    expect(image.isPrimary).toBe(true);
    expect(image.sortOrder).toBe(0);
    expect(image.storageKey.startsWith(`products/${product.id}/`)).toBe(true);
    expect(image.storageKey.endsWith(".png")).toBe(true);
    expect(image.url).toBe(`https://signed.test/${image.storageKey}?sig=abc`);
    expect(stored.get(image.storageKey)!.contentType).toBe("image/png");
  });

  it("derives the type from the bytes rather than the data URL label", async () => {
    const product = await seedProduct();

    const res = await agent
      .post(path(product.id))
      .send({ data: `data:image/png;base64,${jpegPayload()}` })
      .expect(415);

    expect(errorOf(res).code).toBe("UNPROCESSABLE_ENTITY");
    expect(stored.size).toBe(0);
  });

  it("rejects content that is not an image", async () => {
    const product = await seedProduct();

    const script = Buffer.from("#!/bin/sh\nexit 1\n".repeat(3)).toString("base64");

    const res = await agent.post(path(product.id)).send({ data: script }).expect(415);

    expect(errorOf(res).code).toBe("UNPROCESSABLE_ENTITY");
    expect(stored.size).toBe(0);
  });

  it("makes the first image primary and keeps later ones secondary", async () => {
    const product = await seedProduct();

    const first = dataOf<ImageRow>(
      await agent.post(path(product.id)).send({ data: pngPayload() }).expect(201),
    );
    const second = dataOf<ImageRow>(
      await agent.post(path(product.id)).send({ data: pngPayload() }).expect(201),
    );

    expect(first.isPrimary).toBe(true);
    expect(second.isPrimary).toBe(false);
    expect(second.sortOrder).toBe(1);
  });

  it("promotes a later upload immediately when asked, keeping one primary", async () => {
    const product = await seedProduct();

    const first = dataOf<ImageRow>(
      await agent.post(path(product.id)).send({ data: pngPayload() }).expect(201),
    );
    const second = dataOf<ImageRow>(
      await agent
        .post(path(product.id))
        .send({ data: pngPayload(), isPrimary: true })
        .expect(201),
    );

    expect(second.isPrimary).toBe(true);

    const list = imagesOf(await agent.get(path(product.id)).expect(200));

    expect(list.find((row) => row.id === first.id)!.isPrimary).toBe(false);
    expect(list.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  it("removes the object it wrote when the row insert fails", async () => {
    const product = await seedProduct();

    // The put callback drops the product, so the insert that follows violates the
    // foreign key. That is exactly the DB-after-storage failure the compensation
    // path exists for, and the observable proof is that no object is left behind.
    dropProductOnPut = product.id;

    const res = await agent.post(path(product.id)).send({ data: pngPayload() });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(stored.size).toBe(0);

    const rows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, product.id));

    expect(rows).toHaveLength(0);
  });

  it("reports a storage outage as a 502 and writes no row", async () => {
    const product = await seedProduct();

    putShouldFail = true;

    const res = await agent.post(path(product.id)).send({ data: pngPayload() }).expect(502);

    expect(errorOf(res).code).toBe("INTERNAL_ERROR");

    const rows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, product.id));

    expect(rows).toHaveLength(0);
  });

  it("rejects an empty payload, a malformed product id, and an unknown product", async () => {
    const product = await seedProduct();

    await agent.post(path(product.id)).send({ data: "" }).expect(400);
    await agent.post(path(crypto.randomUUID())).send({ data: pngPayload() }).expect(404);
    await agent.post("/api/products/not-a-uuid/images").send({ data: pngPayload() }).expect(400);
  });
});

describe("product images: reading and mutating", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let productId: string;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    stored.clear();
    putShouldFail = false;
    deleteShouldFail = false;
    dropProductOnPut = null;
    agent = await imageAgent();
    productId = (await seedProduct()).id;
  });

  it("lists a product's images in display order", async () => {
    const first = await seedProductImage(productId, { sortOrder: 0 });
    const second = await seedProductImage(productId, { sortOrder: 1 });

    const res = await agent.get(path(productId)).expect(200);

    expect(idsOf(res)).toEqual([first.id, second.id]);
    expect(imagesOf(res)[0]!.url).toBe(`https://signed.test/${first.storageKey}?sig=abc`);
  });

  it("returns an empty gallery for a product with no images, and 404s for none", async () => {
    expect(imagesOf(await agent.get(path(productId)).expect(200))).toEqual([]);
    await agent.get(path(crypto.randomUUID())).expect(404);
  });

  it("keeps the rest of a gallery readable when one key is tampered", async () => {
    const good = await seedProductImage(productId, { sortOrder: 0 });
    const tampered = await seedProductImage(productId, {
      sortOrder: 1,
      storageKey: "../../etc/passwd",
    });

    const list = imagesOf(await agent.get(path(productId)).expect(200));

    // One bad row must not blank the whole gallery, and must never be signed.
    expect(list.map((row) => row.id)).toEqual([good.id, tampered.id]);
    expect(list.find((row) => row.id === good.id)!.url).toContain("signed.test");
    expect(list.find((row) => row.id === tampered.id)!.url).toBeNull();

    // The single-object path is strict instead, because there is no "other rows"
    // to protect and a tampered key is an integrity signal.
    const one = await agent.get(path(productId, `/${tampered.id}`)).expect(422);

    expect(errorOf(one).code).toBe("STORAGE_KEY_INVALID");
  });

  it("scopes every image route to the product in the path", async () => {
    const other = await seedProduct();
    const image = await seedProductImage(other.id);

    // Another product's image is a 404 rather than a cross-product mutation.
    await agent.get(path(productId, `/${image.id}`)).expect(404);
    await agent.patch(path(productId, `/${image.id}`)).send({ altText: "x" }).expect(404);
    await agent.put(path(productId, `/${image.id}/primary`)).expect(404);
    await agent.delete(path(productId, `/${image.id}`)).expect(404);
    await agent.post(path(productId, "/reorder")).send({ imageIds: [image.id] }).expect(422);
  });

  it("updates only the alt text, including clearing it", async () => {
    const image = await seedProductImage(productId, { altText: "Old caption" });

    const updated = dataOf<ImageRow>(
      await agent.patch(path(productId, `/${image.id}`)).send({ altText: null }).expect(200),
    );

    expect(updated.altText).toBeNull();
    // Everything else survives the patch.
    expect(updated.storageKey).toBe(image.storageKey);
    expect(updated.sortOrder).toBe(image.sortOrder);

    await agent.patch(path(productId, `/${image.id}`)).send({}).expect(400);
    await agent
      .patch(path(productId, `/${image.id}`))
      .send({ altText: "x".repeat(256) })
      .expect(400);
  });

  it("moves the primary flag to exactly one image", async () => {
    const a = await seedProductImage(productId, { sortOrder: 0, isPrimary: true });
    const b = await seedProductImage(productId, { sortOrder: 1 });

    const promoted = dataOf<ImageRow>(
      await agent.put(path(productId, `/${b.id}/primary`)).expect(200),
    );

    expect(promoted.isPrimary).toBe(true);

    const list = imagesOf(await agent.get(path(productId)).expect(200));

    expect(list.filter((row) => row.isPrimary).map((row) => row.id)).toEqual([b.id]);
    expect(list.find((row) => row.id === a.id)!.isPrimary).toBe(false);
  });

  it("replaces the display order in one write", async () => {
    const a = await seedProductImage(productId, { sortOrder: 0 });
    const b = await seedProductImage(productId, { sortOrder: 1 });
    const c = await seedProductImage(productId, { sortOrder: 2 });

    const res = await agent
      .post(path(productId, "/reorder"))
      .send({ imageIds: [c.id, a.id, b.id] })
      .expect(200);

    expect(idsOf(res)).toEqual([c.id, a.id, b.id]);
    expect(imagesOf(res).map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });

  it("refuses a reorder that does not list the gallery exactly", async () => {
    const a = await seedProductImage(productId, { sortOrder: 0 });
    const b = await seedProductImage(productId, { sortOrder: 1 });
    const foreign = await seedProductImage((await seedProduct()).id);

    // A partial list would silently push the omitted image to the tail.
    const partial = await agent
      .post(path(productId, "/reorder"))
      .send({ imageIds: [a.id] })
      .expect(422);

    expect(errorOf(partial).code).toBe("UNPROCESSABLE_ENTITY");
    expect(partial.body.error).toBeDefined();

    await agent
      .post(path(productId, "/reorder"))
      .send({ imageIds: [a.id, b.id, foreign.id] })
      .expect(422);
    await agent.post(path(productId, "/reorder")).send({ imageIds: [] }).expect(400);
    await agent
      .post(path(productId, "/reorder"))
      .send({ imageIds: [a.id, a.id] })
      .expect(400);
    await agent.post(path(productId, "/reorder")).send({ imageIds: ["nope"] }).expect(400);
  });

  it("reaches the reorder route rather than /:imageId", async () => {
    // If `/reorder` were captured by the `/:imageId` route, params validation would
    // reject "reorder" as a UUID and the call could not succeed at all.
    const only = await seedProductImage(productId, { sortOrder: 0 });

    const res = await agent
      .post(path(productId, "/reorder"))
      .send({ imageIds: [only.id] })
      .expect(200);

    expect(idsOf(res)).toEqual([only.id]);
  });
});

describe("product images: deletion", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let productId: string;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    stored.clear();
    putShouldFail = false;
    deleteShouldFail = false;
    dropProductOnPut = null;
    agent = await imageAgent();
    productId = (await seedProduct()).id;
  });

  it("removes the row and the object together", async () => {
    const image = await seedProductImage(productId);

    stored.set(image.storageKey, { body: PNG_BYTES, contentType: "image/png" });

    const res = await agent.delete(path(productId, `/${image.id}`)).expect(200);

    expect(dataOf<Record<string, unknown>>(res)).toMatchObject({
      deleted: true,
      promotedImageId: null,
    });
    expect(stored.size).toBe(0);

    const rows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId));

    expect(rows).toHaveLength(0);
  });

  it("promotes the earliest surviving image when the primary is deleted", async () => {
    const primary = await seedProductImage(productId, { sortOrder: 0, isPrimary: true });
    const second = await seedProductImage(productId, { sortOrder: 1 });
    const third = await seedProductImage(productId, { sortOrder: 2 });

    const res = await agent.delete(path(productId, `/${primary.id}`)).expect(200);

    expect(dataOf<Record<string, unknown>>(res).promotedImageId).toBe(second.id);

    const list = imagesOf(await agent.get(path(productId)).expect(200));

    expect(list.filter((row) => row.isPrimary).map((row) => row.id)).toEqual([second.id]);
    expect(list.map((row) => row.id)).toEqual([second.id, third.id]);
  });

  it("leaves no primary once the gallery is empty", async () => {
    const only = await seedProductImage(productId, { isPrimary: true });

    await agent.delete(path(productId, `/${only.id}`)).expect(200);

    expect(imagesOf(await agent.get(path(productId)).expect(200))).toEqual([]);
  });

  it("still reports success when only the object delete fails", async () => {
    const image = await seedProductImage(productId);

    stored.set(image.storageKey, { body: PNG_BYTES, contentType: "image/png" });
    deleteShouldFail = true;

    // The database is already consistent, and surfacing the storage failure would
    // only invite a retry that now 404s. The leftover object is invisible to the API.
    await agent.delete(path(productId, `/${image.id}`)).expect(200);

    expect(stored.has(image.storageKey)).toBe(true);

    const rows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId));

    expect(rows).toHaveLength(0);
  });

  it("refuses to delete an object outside the image namespace", async () => {
    const image = await seedProductImage(productId, {
      storageKey: "some/other/tenant/object.png",
    });

    // A hand-edited row must not aim DeleteObjectCommand at the shared bucket.
    stored.set("some/other/tenant/object.png", { body: PNG_BYTES, contentType: "image/png" });

    const res = await agent.delete(path(productId, `/${image.id}`)).expect(422);

    expect(errorOf(res).code).toBe("STORAGE_KEY_INVALID");
    expect(stored.size).toBe(1);

    const rows = await db.select().from(productImages).where(eq(productImages.id, image.id));

    expect(rows).toHaveLength(1);
  });
});

describe("product images: authorization and audit trail", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    stored.clear();
    putShouldFail = false;
    deleteShouldFail = false;
    dropProductOnPut = null;
  });

  it("requires authentication", async () => {
    const product = await seedProduct();

    await createAgent().get(path(product.id)).expect(401);
    await createAgent().post(path(product.id)).send({ data: pngPayload() }).expect(401);
  });

  it("applies CSRF protection to the mutating routes", async () => {
    const product = await seedProduct();
    const admin = await seedAdmin(testAdmin.owner);

    // Log in same-origin, then replay the cookies from a foreign origin: a hostile
    // page cannot read the victim's cookies but can make the browser send them.
    const tokens = readAuthCookies(
      await login(createAgent(), {
        email: admin.email,
        password: DEFAULT_ADMIN_PASSWORD,
      }),
    );

    const forged = await createCrossSiteAgent()
      .post(path(product.id))
      .set("Cookie", cookieHeaderFor(tokens))
      .send({ data: pngPayload() });

    expect(forged.status).toBe(403);
    expect(errorOf(forged).code).toBe("CSRF_REJECTED");
    expect(stored.size).toBe(0);
  });

  it("lets an editor manage images, including deletion, per the permission table", async () => {
    const product = await seedProduct();
    const agent = await imageAgent("editor");
    const image = await seedProductImage(product.id);

    await agent.get(path(product.id)).expect(200);
    await agent.post(path(product.id)).send({ data: pngPayload() }).expect(201);
    await agent.patch(path(product.id, `/${image.id}`)).send({ altText: "caption" }).expect(200);
    await agent.delete(path(product.id, `/${image.id}`)).expect(200);
  });

  it("records an audit row for each mutation", async () => {
    const product = await seedProduct();
    const agent = await imageAgent();

    const created = dataOf<ImageRow>(
      await agent.post(path(product.id)).send({ data: pngPayload() }).expect(201),
    );

    await agent.patch(path(product.id, `/${created.id}`)).send({ altText: "renamed" }).expect(200);
    await agent.put(path(product.id, `/${created.id}/primary`)).expect(200);
    await agent.post(path(product.id, "/reorder")).send({ imageIds: [created.id] }).expect(200);
    await agent.delete(path(product.id, `/${created.id}`)).expect(200);

    const create = await findAuditRows("product_image.create");
    const update = await findAuditRows("product_image.update");
    const setPrimary = await findAuditRows("product_image.set_primary");
    const reorder = await findAuditRows("product_image.reorder");
    const remove = await findAuditRows("product_image.delete");

    expect(create).toHaveLength(1);
    expect(create[0]!.entityType).toBe("product_image");
    expect(create[0]!.entityId).toBe(created.id);
    expect(create[0]!.metadata).toMatchObject({
      productId: product.id,
      mimeType: "image/png",
      isPrimary: true,
    });
    // Only the payload's shape is recorded, never its bytes.
    expect(JSON.stringify(create[0]!.metadata)).not.toContain(pngPayload());

    expect(update).toHaveLength(1);
    expect(setPrimary).toHaveLength(1);
    expect(remove).toHaveLength(1);

    // Reordering describes the product's gallery, so the entity recorded is the
    // product and `entityId` stays a real product id rather than an image id.
    expect(reorder).toHaveLength(1);
    expect(reorder[0]!.entityType).toBe("product");
    expect(reorder[0]!.entityId).toBe(product.id);
    expect(reorder[0]!.metadata).toMatchObject({ count: 1 });
  });
});
