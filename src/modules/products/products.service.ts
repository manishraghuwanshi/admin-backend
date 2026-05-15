import { and, asc, count, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import {
  brands,
  categories,
  inventory,
  productCategories,
  productImages,
  products,
  watchDetails,
} from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { lockInventoryRow } from "../../lib/inventory-lock.js";
import { isProductImageKey } from "../../lib/storage/keys.js";
import { safeDeleteObject } from "../../lib/storage/delete.js";
import { getSignedDownloadUrl, isStorageConfigured } from "../../lib/storage/s3.js";
import { logger } from "../../utils/logger.js";
import { notFound, unprocessable } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "../../utils/pagination.js";
import {
  amountQuerySchema,
  amountSchema,
  optionalBooleanQuery,
  slugSchema,
  uuidParamSchema,
} from "../../utils/schemas.js";

export const productListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  isActive: optionalBooleanQuery,
  isFeatured: optionalBooleanQuery,
  minPrice: amountQuerySchema.optional(),
  maxPrice: amountQuerySchema.optional(),
  sort: z.enum(["createdAt", "name", "price", "updatedAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const watchDetailsSchema = z.object({
  watchType: z.string().trim().max(50).nullable().optional(),
  movement: z.string().trim().max(100).nullable().optional(),
  caseMaterial: z.string().trim().max(100).nullable().optional(),
  caseShape: z.string().trim().max(50).nullable().optional(),
  caseDiameter: z.union([z.string(), z.number()]).nullable().optional(),
  caseThickness: z.union([z.string(), z.number()]).nullable().optional(),
  strapMaterial: z.string().trim().max(100).nullable().optional(),
  strapColor: z.string().trim().max(50).nullable().optional(),
  dialColor: z.string().trim().max(50).nullable().optional(),
  glassMaterial: z.string().trim().max(100).nullable().optional(),
  waterResistance: z.string().trim().max(100).nullable().optional(),
  powerReserve: z.string().trim().max(100).nullable().optional(),
  warrantyPeriod: z.string().trim().max(100).nullable().optional(),
  gender: z.string().trim().max(30).nullable().optional(),
  additionalSpecifications: z.record(z.string(), z.unknown()).nullable().optional(),
});

const inventoryInputSchema = z.object({
  quantity: z.number().int().min(0).optional(),
  reservedQuantity: z.number().int().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
});

const productFieldsSchema = z.object({
  brandId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
  sku: z.string().trim().min(1).max(100),
  shortDescription: z.string().trim().max(2000).nullable().optional(),
  description: z.string().trim().max(20000).nullable().optional(),
  /** Whole currency units (see docs/database.md → "products"); never minor units. */
  price: amountSchema,
  compareAtPrice: amountSchema.nullable().optional(),
  currency: z.string().trim().length(3).default("INR"),
  thumbnailStorageKey: z.string().trim().max(500).nullable().optional(),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
  categoryIds: z.array(z.uuid()).max(50).optional(),
  watchDetails: watchDetailsSchema.optional(),
  inventory: inventoryInputSchema.optional(),
});

type ProductCrossFieldInput = {
  price?: number;
  compareAtPrice?: number | null;
  inventory?: { quantity?: number; reservedQuantity?: number };
};

/**
 * Cross-field rules shared by create and update.
 *
 * Every check is conditional on the relevant fields being present, so the same
 * refinement can run against the fully optional update payload.
 */
function assertProductCrossFieldRules(value: ProductCrossFieldInput, ctx: z.RefinementCtx): void {
  if (
    value.price !== undefined &&
    value.compareAtPrice !== undefined &&
    value.compareAtPrice !== null &&
    value.compareAtPrice < value.price
  ) {
    ctx.addIssue({
      code: "custom",
      message: "compareAtPrice must be greater than or equal to price",
      path: ["compareAtPrice"],
    });
  }

  const reserved = value.inventory?.reservedQuantity ?? 0;
  const quantity = value.inventory?.quantity ?? 0;

  if (reserved > quantity) {
    ctx.addIssue({
      code: "custom",
      message: "reservedQuantity cannot exceed quantity",
      path: ["inventory", "reservedQuantity"],
    });
  }
}

export const productCreateSchema = productFieldsSchema.superRefine(assertProductCrossFieldRules);

// Note: zod v4 refuses `.partial()` on a schema that already carries
// refinements, so the refinements are re-applied to the partial object here.
export const productUpdateSchema = productFieldsSchema
  .extend({ price: amountSchema.optional() })
  .partial()
  .superRefine(assertProductCrossFieldRules);

async function assertBrandExists(brandId: string): Promise<void> {
  const [brand] = await db.select({ id: brands.id }).from(brands).where(eq(brands.id, brandId)).limit(1);

  if (!brand) {
    throw unprocessable("Brand does not exist");
  }
}

async function assertCategoriesExist(categoryIds: string[]): Promise<void> {
  if (categoryIds.length === 0) {
    return;
  }

  const unique = [...new Set(categoryIds)];
  const rows = await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, unique));

  if (rows.length !== unique.length) {
    throw unprocessable("One or more categories do not exist");
  }
}

function watchValues(input: z.infer<typeof watchDetailsSchema>) {
  return {
    watchType: input.watchType ?? null,
    movement: input.movement ?? null,
    caseMaterial: input.caseMaterial ?? null,
    caseShape: input.caseShape ?? null,
    caseDiameter: input.caseDiameter === null || input.caseDiameter === undefined ? null : String(input.caseDiameter),
    caseThickness:
      input.caseThickness === null || input.caseThickness === undefined ? null : String(input.caseThickness),
    strapMaterial: input.strapMaterial ?? null,
    strapColor: input.strapColor ?? null,
    dialColor: input.dialColor ?? null,
    glassMaterial: input.glassMaterial ?? null,
    waterResistance: input.waterResistance ?? null,
    powerReserve: input.powerReserve ?? null,
    warrantyPeriod: input.warrantyPeriod ?? null,
    gender: input.gender ?? null,
    additionalSpecifications: input.additionalSpecifications ?? null,
  };
}

async function attachSignedUrls<T extends { storageKey?: string | null; thumbnailStorageKey?: string | null }>(
  items: T[],
): Promise<Array<T & { url?: string; thumbnailUrl?: string }>> {
  if (!isStorageConfigured()) {
    return items;
  }

  return Promise.all(
    items.map(async (item) => {
      const extra: { url?: string; thumbnailUrl?: string } = {};

      if (item.storageKey) {
        extra.url = await getSignedDownloadUrl(item.storageKey);
      }

      if (item.thumbnailStorageKey) {
        extra.thumbnailUrl = await getSignedDownloadUrl(item.thumbnailStorageKey);
      }

      return { ...item, ...extra };
    }),
  );
}

async function loadProduct(id: string) {
  const product = await db.query.products.findFirst({
    where: eq(products.id, id),
    with: {
      brand: true,
      watchDetails: true,
      inventory: true,
      images: {
        orderBy: (images, { asc }) => [asc(images.sortOrder)],
      },
      productCategories: {
        with: {
          category: true,
        },
      },
    },
  });

  if (!product) {
    return undefined;
  }

  const images = await attachSignedUrls(product.images);
  const [withThumb] = await attachSignedUrls([product]);

  return {
    ...withThumb,
    images,
    categories: product.productCategories.map((row) => row.category),
    productCategories: undefined,
  };
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof productListQuerySchema>;
  const filters: SQL[] = [];

  if (query.search) {
    const term = `%${query.search}%`;
    filters.push(
      or(sql`${products.name} ILIKE ${term}`, sql`${products.slug} ILIKE ${term}`, sql`${products.sku} ILIKE ${term}`)!,
    );
  }

  if (query.brandId) {
    filters.push(eq(products.brandId, query.brandId));
  }

  if (query.isActive !== undefined) {
    filters.push(eq(products.isActive, query.isActive));
  }

  if (query.isFeatured !== undefined) {
    filters.push(eq(products.isFeatured, query.isFeatured));
  }

  if (query.minPrice !== undefined) {
    filters.push(gte(products.price, query.minPrice));
  }

  if (query.maxPrice !== undefined) {
    filters.push(lte(products.price, query.maxPrice));
  }

  if (query.categoryId) {
    filters.push(
      inArray(
        products.id,
        db
          .select({ id: productCategories.productId })
          .from(productCategories)
          .where(eq(productCategories.categoryId, query.categoryId)),
      ),
    );
  }

  const where = filters.length ? and(...filters) : undefined;
  const sortColumn = {
    createdAt: products.createdAt,
    name: products.name,
    price: products.price,
    updatedAt: products.updatedAt,
  }[query.sort];
  // `sku` is unique, so it is a safe final tie-break, exactly as it is for brands and
  // categories. Products imported in one batch frequently share a `createdAt` and a
  // `price`; without a tie-break those rows sort arbitrarily and can repeat or vanish
  // across a page boundary.
  const orderBy = query.order === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [{ total }] = await db.select({ total: count() }).from(products).where(where);
  const rows = await db.query.products.findMany({
    where,
    with: {
      brand: true,
      inventory: true,
    },
    orderBy: () => [orderBy, asc(products.sku)],
    limit: query.limit,
    offset: paginationOffset(query.page, query.limit),
  });

  sendPaginated(res, rows, paginationMeta(query.page, query.limit, Number(total)));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const product = await loadProduct(id);

  if (!product) {
    throw notFound("Product not found");
  }

  sendSuccess(res, product);
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const body = req.validatedBody as z.infer<typeof productCreateSchema>;
  await assertBrandExists(body.brandId);
  const categoryIds = [...new Set(body.categoryIds ?? [])];
  await assertCategoriesExist(categoryIds);

  const created = await db.transaction(async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({
        brandId: body.brandId,
        name: body.name,
        slug: body.slug,
        sku: body.sku,
        shortDescription: body.shortDescription ?? null,
        description: body.description ?? null,
        price: body.price,
        compareAtPrice: body.compareAtPrice ?? null,
        currency: body.currency ?? "INR",
        thumbnailStorageKey: body.thumbnailStorageKey ?? null,
        isFeatured: body.isFeatured ?? false,
        isActive: body.isActive ?? true,
      })
      .returning();

    if (categoryIds.length > 0) {
      await tx.insert(productCategories).values(
        categoryIds.map((categoryId) => ({
          productId: product.id,
          categoryId,
        })),
      );
    }

    if (body.watchDetails) {
      await tx.insert(watchDetails).values({
        productId: product.id,
        ...watchValues(body.watchDetails),
      });
    }

    await tx.insert(inventory).values({
      productId: product.id,
      quantity: body.inventory?.quantity ?? 0,
      reservedQuantity: body.inventory?.reservedQuantity ?? 0,
      lowStockThreshold: body.inventory?.lowStockThreshold ?? 5,
    });

    return product;
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product.create",
    entityType: "product",
    entityId: created.id,
    metadata: { sku: created.sku, slug: created.slug },
    req,
  });

  sendSuccess(res, await loadProduct(created.id), 201);
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const body = req.validatedBody as z.infer<typeof productUpdateSchema>;
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });

  if (!existing) {
    throw notFound("Product not found");
  }

  if (body.brandId) {
    await assertBrandExists(body.brandId);
  }

  const categoryIds = body.categoryIds ? [...new Set(body.categoryIds)] : undefined;

  if (categoryIds) {
    await assertCategoriesExist(categoryIds);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        ...(body.brandId !== undefined ? { brandId: body.brandId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.sku !== undefined ? { sku: body.sku } : {}),
        ...(body.shortDescription !== undefined ? { shortDescription: body.shortDescription } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.compareAtPrice !== undefined ? { compareAtPrice: body.compareAtPrice } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.thumbnailStorageKey !== undefined ? { thumbnailStorageKey: body.thumbnailStorageKey } : {}),
        ...(body.isFeatured !== undefined ? { isFeatured: body.isFeatured } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.id, id));

    if (categoryIds) {
      await tx.delete(productCategories).where(eq(productCategories.productId, id));

      if (categoryIds.length > 0) {
        await tx.insert(productCategories).values(
          categoryIds.map((categoryId) => ({
            productId: id,
            categoryId,
          })),
        );
      }
    }

    if (body.watchDetails) {
      const values = watchValues(body.watchDetails);
      await tx
        .insert(watchDetails)
        .values({ productId: id, ...values })
        .onConflictDoUpdate({
          target: watchDetails.productId,
          set: { ...values, updatedAt: new Date() },
        });
    }

    if (body.inventory) {
      // Locked before it is read, exactly as `PUT /api/inventory/:productId` does.
      // The nested payload is a partial absolute set: anything the caller omits is
      // carried over from the row, so reading it unlocked would let a concurrent
      // write land first and then be silently overwritten with a stale value.
      const current = await lockInventoryRow(tx, id);
      const quantity = body.inventory.quantity ?? current?.quantity ?? 0;
      const reservedQuantity = body.inventory.reservedQuantity ?? current?.reservedQuantity ?? 0;
      const lowStockThreshold = body.inventory.lowStockThreshold ?? current?.lowStockThreshold ?? 5;

      if (reservedQuantity > quantity) {
        throw unprocessable("reservedQuantity cannot exceed quantity", {
          path: ["inventory", "reservedQuantity"],
        });
      }

      if (current) {
        await tx
          .update(inventory)
          .set({ quantity, reservedQuantity, lowStockThreshold, updatedAt: new Date() })
          .where(eq(inventory.productId, id));
      } else {
        await tx.insert(inventory).values({ productId: id, quantity, reservedQuantity, lowStockThreshold });
      }
    }
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product.update",
    entityType: "product",
    entityId: id,
    req,
  });

  sendSuccess(res, await loadProduct(id));
}

/**
 * Every object belonging to a product, gathered before its rows disappear.
 *
 * `product_images` rows cascade in PostgreSQL, so the rows go with the product, but
 * the objects they point at do not: Object Storage is outside the transaction. Until
 * this was collected, deleting a product that had images left every one of those
 * objects in the bucket forever with nothing referencing it.
 *
 * The keys have to be read *before* the delete, because afterwards there is no row
 * left to read them from.
 */
async function collectStorageKeys(
  productId: string,
  thumbnailStorageKey: string | null,
): Promise<string[]> {
  const rows = await db
    .select({ storageKey: productImages.storageKey })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  return dedupeOwnedKeys(productId, [...rows.map((row) => row.storageKey), thumbnailStorageKey]);
}

/**
 * Keep only keys that are well formed *and* owned by this product.
 *
 * `safeDeleteObject` re-checks the shape before any delete, which is what stops a
 * tampered row aiming the delete at an arbitrary object. That check is deliberately
 * not the only one here: `products/<otherProduct>/<uuid>.jpg` is a perfectly shaped
 * key that belongs to a different product, and deleting it because this product's row
 * was edited would destroy another product's image. The product id is the one part of
 * the key a row cannot legitimately change.
 */
export function dedupeOwnedKeys(productId: string, keys: Array<string | null>): string[] {
  const owned = new Set<string>();

  for (const key of keys) {
    if (!key) {
      continue;
    }

    if (!isProductImageKey(key) || !key.startsWith(`products/${productId}/`)) {
      logger.warn("product row carries a storage key outside its own namespace", {
        productId,
        context: "product.delete",
      });

      continue;
    }

    owned.add(key);
  }

  return [...owned];
}

/** Tally of what a cleanup pass did, recorded in the audit metadata. */
interface RemovalTally {
  deleted: number;
  skipped: number;
  failed: number;
}

async function deleteStoredObjects(keys: string[], context: string): Promise<RemovalTally> {
  const tally: RemovalTally = { deleted: 0, skipped: 0, failed: 0 };

  for (const key of keys) {
    tally[await safeDeleteObject(key, context)] += 1;
  }

  return tally;
}

/**
 * Delete a product and everything that hangs off it.
 *
 * The order stays row-first, object-second: the database is the source of truth and a
 * leaked object is invisible to the API, whereas an object deleted while its row
 * survives is a permanently broken image. A storage failure after the rows are gone is
 * therefore recorded rather than returned — the caller's product really is deleted, and
 * a 500 would invite a retry that now 404s.
 */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const [existing] = await db.select().from(products).where(eq(products.id, id)).limit(1);

  if (!existing) {
    throw notFound("Product not found");
  }

  const keys = await collectStorageKeys(id, existing.thumbnailStorageKey);

  await db.delete(products).where(eq(products.id, id));

  const removed = await deleteStoredObjects(keys, "product.delete");

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product.delete",
    entityType: "product",
    entityId: id,
    metadata: {
      sku: existing.sku,
      slug: existing.slug,
      objectsDeleted: removed.deleted,
      objectsFailed: removed.failed,
      objectsSkipped: removed.skipped,
    },
    req,
  });

  sendSuccess(res, { deleted: true });
}
