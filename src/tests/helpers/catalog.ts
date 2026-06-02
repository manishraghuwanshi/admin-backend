import { db } from "../../db/index.js";
import {
  auditLogs,
  brands,
  categories,
  productCategories,
  productImages,
  products,
} from "../../db/schema.js";

/**
 * Catalog factories.
 *
 * The catalog tables have real foreign keys and check constraints (they are the
 * migrations applied to PGlite), so a test cannot invent a product id out of thin
 * air - it has to insert a brand, then a product, then whatever hangs off them.
 * These helpers keep that chain to one call per test.
 */

let counter = 0;

function next(): number {
  counter += 1;

  return counter;
}

export async function seedBrand(
  overrides: Partial<{ name: string; slug: string; description: string | null; isActive: boolean }> = {},
) {
  const n = next();

  const [brand] = await db
    .insert(brands)
    .values({
      name: overrides.name ?? `Brand ${n}`,
      slug: overrides.slug ?? `brand-${n}`,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
    })
    .returning();

  return brand;
}

export async function seedProduct(
  overrides: Partial<{
    brandId: string;
    name: string;
    slug: string;
    sku: string;
    price: number;
    compareAtPrice: number | null;
    currency: string;
    thumbnailStorageKey: string | null;
    isActive: boolean;
    isFeatured: boolean;
    description: string | null;
  }> = {},
) {
  const n = next();
  const brandId = overrides.brandId ?? (await seedBrand()).id;

  const [product] = await db
    .insert(products)
    .values({
      brandId,
      name: overrides.name ?? `Product ${n}`,
      slug: overrides.slug ?? `product-${n}`,
      sku: overrides.sku ?? `SKU-${n}`,
      price: overrides.price ?? 10_000,
      ...(overrides.compareAtPrice !== undefined ? { compareAtPrice: overrides.compareAtPrice } : {}),
      ...(overrides.currency ? { currency: overrides.currency } : {}),
      ...(overrides.thumbnailStorageKey !== undefined
        ? { thumbnailStorageKey: overrides.thumbnailStorageKey }
        : {}),
      ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
      ...(overrides.isFeatured !== undefined ? { isFeatured: overrides.isFeatured } : {}),
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    })
    .returning();

  return product;
}

/**
 * Insert a category directly, bypassing the route.
 *
 * `parentId` is deliberately *not* a foreign key in this schema (see
 * docs/database.md), so a test can build a hierarchy — including a deliberately
 * broken one — without the insert refusing to run.
 */
export async function seedCategory(
  overrides: Partial<{
    name: string;
    slug: string;
    parentId: string | null;
    isActive: boolean;
    sortOrder: number;
    description: string | null;
    imageStorageKey: string | null;
  }> = {},
) {
  const n = next();

  const [category] = await db
    .insert(categories)
    .values({
      name: overrides.name ?? `Category ${n}`,
      slug: overrides.slug ?? `category-${n}`,
      parentId: overrides.parentId ?? null,
      isActive: overrides.isActive ?? true,
      sortOrder: overrides.sortOrder ?? 0,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.imageStorageKey !== undefined
        ? { imageStorageKey: overrides.imageStorageKey }
        : {}),
    })
    .returning();

  return category;
}

/** Attach a product to a category without going through the product routes. */
export async function seedProductCategory(productId: string, categoryId: string) {
  const [row] = await db
    .insert(productCategories)
    .values({ productId, categoryId })
    .returning();

  return row;
}

/**
 * Insert an image row directly, bypassing the upload route.
 *
 * Used for read/reorder tests and for states the upload path cannot produce -
 * notably a tampered `storageKey`.
 */
export async function seedProductImage(
  productId: string,
  overrides: Partial<{
    storageKey: string;
    altText: string | null;
    sortOrder: number;
    isPrimary: boolean;
  }> = {},
) {
  const n = next();

  const [image] = await db
    .insert(productImages)
    .values({
      productId,
      storageKey:
        overrides.storageKey ??
        `products/${productId}/00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}.jpg`,
      altText: overrides.altText ?? null,
      sortOrder: overrides.sortOrder ?? n - 1,
      isPrimary: overrides.isPrimary ?? false,
    })
    .returning();

  return image;
}

/** Write an audit row without going through a request. */
export async function seedAuditRow(input: {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}) {
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType ?? "test",
      entityId: input.entityId ?? null,
      metadata: input.metadata,
      createdAt: input.createdAt,
    })
    .returning();

  return row;
}
