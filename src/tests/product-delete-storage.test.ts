import { eq } from "drizzle-orm";
import type { Agent } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/index.js";
import { products } from "../db/schema.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, login } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, findAuditRows, seedAdmin, testAdmin } from "./helpers/seed.js";
import { seedProduct, seedProductImage } from "./helpers/catalog.js";
import { dedupeOwnedKeys } from "../modules/products/products.service.js";

/**
 * Object cleanup on `DELETE /api/products/:id`.
 *
 * A product's rows cascade in PostgreSQL; its objects do not, because Object Storage
 * sits outside the transaction. This suite is the only place that behaviour is
 * observable: the test environment carries no storage credentials, so
 * `products.test.ts` runs with storage genuinely unconfigured and every cleanup ends
 * up `skipped`. Here the S3 client is stubbed with an in-memory map, which makes the
 * rules that matter assertable rather than merely intended:
 *
 *  1. deleting a product removes its image objects *and* its thumbnail object;
 *  2. a key that is not this product's own - tampered, malformed, or another
 *     product's - is never deleted, because the bucket is shared;
 *  3. a storage outage does not turn a successful delete into a 500, but it is
 *     recorded, because the tally is the only evidence anything is wrong.
 */

const stored = new Map<string, string>();
const deleteAttempts: string[] = [];
let deleteShouldFail = false;

vi.mock("../lib/storage/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage/s3.js")>();

  return {
    ...actual,
    isStorageConfigured: () => true,
    putObject: async (input: { key: string }) => {
      stored.set(input.key, "body");
    },
    deleteObject: async (key: string) => {
      deleteAttempts.push(key);

      if (deleteShouldFail) {
        throw new Error("simulated storage outage");
      }

      stored.delete(key);
    },
    getSignedDownloadUrl: async (key: string) => `https://signed.test/${key}?sig=abc`,
  };
});

const key = (productId: string, suffix: string) => `products/${productId}/${suffix}.jpg`;

async function ownerAgent(): Promise<Agent> {
  const admin = await seedAdmin(testAdmin.owner);
  const request = createAgent();

  await login(request, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return request;
}

/**
 * Points a row's key column at an arbitrary string.
 *
 * No route accepts a raw storage key, so a tampered row can only be produced
 * directly - which is exactly the state the guards exist for.
 */
async function tamperThumbnail(productId: string, storageKey: string): Promise<void> {
  await db.update(products).set({ thumbnailStorageKey: storageKey }).where(eq(products.id, productId));
}

let handle: TestDatabase;
let authed: Agent;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await clearTestData(handle);
  stored.clear();
  deleteAttempts.length = 0;
  deleteShouldFail = false;
  authed = await ownerAgent();
});

describe("product delete: object cleanup", () => {
  it("removes every image object together with the rows", async () => {
    const product = await seedProduct();
    const first = await seedProductImage(product.id, { storageKey: key(product.id, "00000000-0000-4000-8000-000000000001") });
    const second = await seedProductImage(product.id, { storageKey: key(product.id, "00000000-0000-4000-8000-000000000002") });

    stored.set(first.storageKey, "body");
    stored.set(second.storageKey, "body");

    await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(deleteAttempts.sort()).toEqual([first.storageKey, second.storageKey].sort());
    expect([...stored.keys()]).toEqual([]);

    const [audit] = await findAuditRows("product.delete");

    expect(audit!.metadata).toMatchObject({ objectsDeleted: 2, objectsFailed: 0, objectsSkipped: 0 });
  });

  it("removes the thumbnail object, which has no product_images row", async () => {
    // The key is built from the product's own id, as `lib/storage/keys.ts` requires.
    // A thumbnail key naming some other product is not cleanup, it is a foreign
    // object, and the ownership filter has to reject it (asserted below).
    const product = await seedProduct();
    const thumbnail = key(product.id, "00000000-0000-4000-8000-000000000009");

    await tamperThumbnail(product.id, thumbnail);
    stored.set(thumbnail, "body");

    await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(deleteAttempts).toEqual([thumbnail]);
    expect(stored.size).toBe(0);
  });

  it("refuses to delete a thumbnail key that names a different product", async () => {
    const product = await seedProduct();
    const foreign = key(crypto.randomUUID(), "00000000-0000-4000-8000-000000000010");

    await tamperThumbnail(product.id, foreign);
    stored.set(foreign, "body");

    await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(deleteAttempts).toEqual([]);
    expect(stored.size).toBe(1);

    // The refusal happens in `dedupeOwnedKeys`, before the cleanup pass, so a foreign
    // key is not a `skipped` object - it is never offered for deletion at all, and the
    // tally stays honest about what was ever in scope. The warning is logged instead.
    const [audit] = await findAuditRows("product.delete");

    expect(audit!.metadata).toMatchObject({ objectsDeleted: 0, objectsFailed: 0, objectsSkipped: 0 });
  });

  it("counts a key shared by the thumbnail and an image row as one object", async () => {
    // Reachable through the image routes: promoting a thumbnail can reuse a gallery
    // key. Issuing the delete twice is harmless to the bucket, but the audit tally
    // would then claim two objects were removed when only one ever existed.
    const product = await seedProduct();
    const image = await seedProductImage(product.id, { storageKey: key(product.id, "00000000-0000-4000-8000-000000000003") });

    await tamperThumbnail(product.id, image.storageKey);
    stored.set(image.storageKey, "body");

    await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(deleteAttempts).toHaveLength(1);
    expect(stored.size).toBe(0);

    const [audit] = await findAuditRows("product.delete");

    expect(audit!.metadata).toMatchObject({ objectsDeleted: 1 });
  });

  it("leaves objects belonging to another product alone", async () => {
    const mine = await seedProduct();
    const theirs = await seedProduct();
    const mineKey = key(mine.id, "00000000-0000-4000-8000-000000000004");
    const theirsKey = key(theirs.id, "00000000-0000-4000-8000-000000000005");

    await seedProductImage(mine.id, { storageKey: mineKey });
    await seedProductImage(theirs.id, { storageKey: theirsKey });

    stored.set(mineKey, "body");
    stored.set(theirsKey, "body");

    await authed.delete(`/api/products/${mine.id}`).expect(200);

    expect(deleteAttempts).toEqual([mineKey]);
    expect([...stored.keys()]).toEqual([theirsKey]);
  });

  it("deletes nothing when every row points outside the image namespace", async () => {
    // A hand-edited row is the threat model: the key reaches `DeleteObjectCommand`
    // from the database, not from the client, so a row naming a foreign prefix must
    // never be acted on - the bucket is shared with other projects.
    const product = await seedProduct({ thumbnailStorageKey: "secret/credentials.json" });
    const image = await seedProductImage(product.id, { storageKey: `products/other/../../etc/passwd` });

    stored.set("secret/credentials.json", "body");
    stored.set(image.storageKey, "body");

    await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(deleteAttempts).toEqual([]);
    expect(stored.size).toBe(2);
  });

  it("still reports success when the object delete fails, and records it", async () => {
    // The rows are already gone. A 500 would invite a retry that now 404s and would
    // suggest the product survived, which is the more damaging lie.
    const product = await seedProduct();
    const stuck = await seedProductImage(product.id, { storageKey: key(product.id, "00000000-0000-4000-8000-000000000006") });

    stored.set(stuck.storageKey, "body");
    deleteShouldFail = true;

    const res = await authed.delete(`/api/products/${product.id}`).expect(200);

    expect(dataOf(res)).toEqual({ deleted: true });
    expect(stored.size).toBe(1);

    const [audit] = await findAuditRows("product.delete");

    expect(audit!.metadata).toMatchObject({ objectsDeleted: 0, objectsFailed: 1, objectsSkipped: 0 });
  });

  it("attempts no cleanup when the product does not exist", async () => {
    const missing = crypto.randomUUID();

    await seedProduct();
    stored.set(key(missing, "00000000-0000-4000-8000-000000000007"), "body");

    expect((await authed.delete(`/api/products/${missing}`)).status).toBe(404);
    expect(deleteAttempts).toEqual([]);
    expect(stored.size).toBe(1);
  });
});

/**
 * The ownership filter on its own.
 *
 * The HTTP tests above can only show the outcome for keys the routes normally
 * produce. These pin the boundary directly, including the case a prefix test alone
 * would let through: a perfectly well-shaped key naming a *different* product.
 */
describe("product delete: owned-key selection", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("keeps only well-formed keys under this product's own prefix", () => {
    const owned = `products/${id}/00000000-0000-4000-8000-00000000000a.jpg`;

    const survivors = dedupeOwnedKeys(id, [
      owned,
      null,
      "",
      `products/${other}/00000000-0000-4000-8000-00000000000b.jpg`,
      `products/${id}/..%2f..%2fetc/passwd.jpg`,
      `products/${id}/not-a-uuid.jpg`,
      `products/${id}/00000000-0000-4000-8000-00000000000c.tiff`,
      `backups/${id}/00000000-0000-4000-8000-00000000000d.jpg`,
    ]);

    expect(survivors).toEqual([owned]);
  });

  it("collapses duplicates and preserves first-seen order", () => {
    const a = `products/${id}/00000000-0000-4000-8000-00000000000e.jpg`;
    const b = `products/${id}/00000000-0000-4000-8000-00000000000f.png`;

    expect(dedupeOwnedKeys(id, [a, b, a, null, b])).toEqual([a, b]);
    expect(dedupeOwnedKeys(id, [null, null])).toEqual([]);
  });

  it("accepts every extension the uploader can produce, and only those", () => {
    const uuid = "00000000-0000-4000-8000-000000000010";

    for (const ext of ["jpg", "png", "webp", "gif"]) {
      expect(dedupeOwnedKeys(id, [`products/${id}/${uuid}.${ext}`])).toEqual([`products/${id}/${uuid}.${ext}`]);
    }

    expect(dedupeOwnedKeys(id, [`products/${id}/${uuid}.svg`, `products/${id}/${uuid}.php`])).toEqual([]);
  });
});

