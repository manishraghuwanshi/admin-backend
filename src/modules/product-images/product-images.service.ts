import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { productImages, products } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { getSignedDownloadUrl, isStorageConfigured, putObject } from "../../lib/storage/s3.js";
import {
  buildProductImageKey,
  decodeImagePayload,
  isProductImageKey,
} from "../../lib/storage/keys.js";
import { safeDeleteObject } from "../../lib/storage/delete.js";
import { logger } from "../../utils/logger.js";
import { notFound, storageKeyInvalid, unprocessable, AppError } from "../../utils/errors.js";
import { sendSuccess } from "../../utils/http.js";

/**
 * Product image administration.
 *
 * An image is a row in `product_images` plus one object in the private
 * `product-images` bucket. The database never stores bytes, and the client never
 * chooses a storage key (see `lib/storage/keys.ts`).
 *
 * Uploads arrive as base64 inside JSON rather than as multipart. That keeps the
 * existing JSON body limit and content-type handling intact and avoids adding an
 * upload middleware dependency. The decoded payload is bounded by
 * `MAX_UPLOAD_BYTES`, and its type comes from magic bytes - never from a
 * client-declared filename or MIME string.
 *
 * Object Storage and PostgreSQL cannot share a transaction, so writes are ordered
 * and compensated: put the object, then insert the row; if the insert fails, delete
 * the object back. The reverse order would leave a row pointing at a missing object
 * (a broken image in the UI), whereas a leaked object is invisible to the API and
 * can be swept. Deletion mirrors it: row first, object second, and a failed object
 * delete is logged rather than surfaced, because the API is already consistent.
 */

export const imageCreateSchema = z.object({
  /** Raw base64, or a `data:image/...;base64,` URL. */
  data: z.string().min(1).max(40 * 1024 * 1024),
  altText: z.string().trim().max(255).nullable().optional(),
  /** Promote immediately; otherwise the first image of a product becomes primary. */
  isPrimary: z.boolean().optional(),
});

export const imageUpdateSchema = z
  .object({
    altText: z.string().trim().max(255).nullable(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const imageReorderSchema = z.object({
  imageIds: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "imageIds must not contain duplicates",
    }),
});

/** The image columns this module reads; `storageKey` stays visible to operators. */
const imageSelect = {
  id: productImages.id,
  productId: productImages.productId,
  storageKey: productImages.storageKey,
  altText: productImages.altText,
  sortOrder: productImages.sortOrder,
  isPrimary: productImages.isPrimary,
  createdAt: productImages.createdAt,
};

/**
 * Sign one stored key.
 *
 * The key comes out of the database, so it is re-validated before being handed to
 * the signer: a hand-edited or tampered row must not be able to aim a signed URL at
 * an arbitrary object in the shared bucket. A failure here is an integrity signal,
 * not a client mistake, so it surfaces as a 422 rather than being papered over.
 *
 * When storage is not configured the URL is `null` rather than an error, matching
 * the read-side behaviour in the products service: catalog metadata stays readable
 * in environments that simply have no bucket wired up.
 */
async function signedUrlFor(storageKey: string): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }

  if (!isProductImageKey(storageKey)) {
    throw storageKeyInvalid("Stored image key is not in the expected format", { storageKey });
  }

  return getSignedDownloadUrl(storageKey);
}

async function withSignedUrl<T extends { storageKey: string }>(row: T) {
  return { ...row, url: await signedUrlFor(row.storageKey) };
}

/**
 * List variant: one bad row must not blank an entire gallery.
 *
 * A tampered key in a single row is reported as a per-item `url: null` plus an error
 * log, because the other rows in the page are fine and the operator can still see the
 * sort order they are trying to fix. The key is never signed regardless.
 */
async function withSignedUrls<T extends { id: string; storageKey: string }>(rows: T[]) {
  return Promise.all(
    rows.map(async (row) => {
      try {
        return await withSignedUrl(row);
      } catch (error) {
        logger.error("product image row carries an unusable storage key", {
          imageId: row.id,
          error,
        });

        return { ...row, url: null as string | null };
      }
    }),
  );
}

async function assertProductExists(productId: string): Promise<void> {
  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!existing) {
    throw notFound("Product not found");
  }
}


/*
 * `safeDeleteObject` lives in `lib/storage/delete.ts` so the product routes can
 * reuse the same stored-key revalidation when they remove a whole gallery.
 */


/**
 * Load an image and confirm it belongs to the product in the path.
 *
 * Every image route is nested under `/api/products/:productId`, so the pair is
 * always checked together: another product's image is a 404 rather than a
 * successful cross-product mutation.
 */
async function loadImage(params: { productId: string; imageId: string }) {
  const [row] = await db
    .select(imageSelect)
    .from(productImages)
    .where(
      and(eq(productImages.id, params.imageId), eq(productImages.productId, params.productId)),
    )
    .limit(1);

  if (!row) {
    throw notFound("Product image not found");
  }

  return row;
}

export async function listImages(req: Request, res: Response): Promise<void> {
  const productId = (req.validatedParams as { productId: string }).productId;

  await assertProductExists(productId);

  const rows = await db
    .select(imageSelect)
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

  sendSuccess(res, await withSignedUrls(rows));
}

export async function getImage(req: Request, res: Response): Promise<void> {
  const image = await loadImage(req.validatedParams as { productId: string; imageId: string });

  sendSuccess(res, await withSignedUrl(image));
}

/**
 * Upload one image for a product.
 *
 * Order of operations: validate bytes -> put object -> insert row -> compensate.
 * Because Object Storage cannot join the database transaction, a failed insert
 * deletes the object it just wrote. The opposite order would leave a row pointing
 * at a missing object (a permanently broken image in the UI), while a leaked
 * object is invisible to the API and can be swept later.
 */
export async function createImage(req: Request, res: Response): Promise<void> {
  const productId = (req.validatedParams as { productId: string }).productId;
  const body = req.validatedBody as z.infer<typeof imageCreateSchema>;

  await assertProductExists(productId);

  const decoded = decodeImagePayload(body.data, { maxBytes: env.MAX_UPLOAD_BYTES });
  const storageKey = buildProductImageKey(productId, decoded.mimeType);

  const [counted] = await db
    .select({ total: count() })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  // The first image of a product becomes its primary image unless the caller asks
  // for the new one to be, so a freshly populated product never lacks one.
  const isFirstImage = Number(counted?.total ?? 0) === 0;
  const makePrimary = body.isPrimary === true || isFirstImage;

  try {
    await putObject({
      key: storageKey,
      body: decoded.buffer,
      contentType: decoded.mimeType,
    });
  } catch (error) {
    throw new AppError("Image could not be stored", 502, {
      code: "INTERNAL_ERROR",
      cause: error,
    });
  }

  let created;

  try {
    created = await db.transaction(async (tx) => {
      if (makePrimary) {
        await tx
          .update(productImages)
          .set({ isPrimary: false })
          .where(and(eq(productImages.productId, productId), eq(productImages.isPrimary, true)));
      }

      const [orderRow] = await tx
        .select({
          max: sql<number>`coalesce(max(${productImages.sortOrder}), -1)::int`.mapWith(Number),
        })
        .from(productImages)
        .where(eq(productImages.productId, productId));

      const [row] = await tx
        .insert(productImages)
        .values({
          productId,
          storageKey,
          altText: body.altText ?? null,
          sortOrder: Number(orderRow?.max ?? -1) + 1,
          isPrimary: makePrimary,
        })
        .returning(imageSelect);

      return row;
    });
  } catch (error) {
    await safeDeleteObject(storageKey, "image.create-compensation");

    throw error;
  }

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product_image.create",
    entityType: "product_image",
    entityId: created.id,
    metadata: {
      productId,
      mimeType: decoded.mimeType,
      byteLength: decoded.byteLength,
      isPrimary: created.isPrimary,
    },
    req,
  });

  sendSuccess(res, await withSignedUrl(created), 201);
}

export async function updateImage(req: Request, res: Response): Promise<void> {
  const params = req.validatedParams as { productId: string; imageId: string };
  const body = req.validatedBody as z.infer<typeof imageUpdateSchema>;

  await loadImage(params);

  const [updated] = await db
    .update(productImages)
    .set({ altText: body.altText })
    .where(
      and(eq(productImages.id, params.imageId), eq(productImages.productId, params.productId)),
    )
    .returning(imageSelect);

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product_image.update",
    entityType: "product_image",
    entityId: params.imageId,
    metadata: { productId: params.productId },
    req,
  });

  sendSuccess(res, await withSignedUrl(updated));
}

/**
 * Delete an image row and its object.
 *
 * The row goes first. If the object delete then fails, the API is already
 * consistent and only an unreachable object remains, so the failure is logged
 * rather than returned - surfacing it would invite a retry that now 404s.
 *
 * A product is never left with zero primaries by accident: if the deleted row was
 * primary, the earliest surviving image is promoted in the same transaction.
 */
export async function deleteImage(req: Request, res: Response): Promise<void> {
  const params = req.validatedParams as { productId: string; imageId: string };
  const image = await loadImage(params);

  // The key came from the database. Validating it here means a hand-edited or
  // corrupted row cannot point a delete at an arbitrary object in the bucket.
  if (!isProductImageKey(image.storageKey)) {
    throw storageKeyInvalid("Stored image key is not in the expected format", {
      imageId: params.imageId,
    });
  }

  const successor = await db.transaction(async (tx) => {
    await tx.delete(productImages).where(eq(productImages.id, params.imageId));

    if (!image.isPrimary) {
      return null;
    }

    const [candidate] = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(eq(productImages.productId, params.productId))
      .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt))
      .limit(1);

    if (candidate) {
      await tx
        .update(productImages)
        .set({ isPrimary: true })
        .where(eq(productImages.id, candidate.id));
    }

    return candidate?.id ?? null;
  });

  await safeDeleteObject(image.storageKey, "image.delete");

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product_image.delete",
    entityType: "product_image",
    entityId: params.imageId,
    metadata: { productId: params.productId, promotedImageId: successor },
    req,
  });

  sendSuccess(res, { deleted: true, promotedImageId: successor });
}

/**
 * Make one image the product's primary image.
 *
 * "Exactly one primary per product" is maintained in application code: a partial
 * unique index would express it in the database, but adding one now means a
 * migration over live data, so the previous primary is demoted inside the same
 * transaction that promotes the new one.
 */
export async function setPrimaryImage(req: Request, res: Response): Promise<void> {
  const params = req.validatedParams as { productId: string; imageId: string };

  await loadImage(params);

  await db.transaction(async (tx) => {
    await tx
      .update(productImages)
      .set({ isPrimary: false })
      .where(
        and(
          eq(productImages.productId, params.productId),
          eq(productImages.isPrimary, true),
          ne(productImages.id, params.imageId),
        ),
      );

    await tx
      .update(productImages)
      .set({ isPrimary: true })
      .where(eq(productImages.id, params.imageId));
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product_image.set_primary",
    entityType: "product_image",
    entityId: params.imageId,
    metadata: { productId: params.productId },
    req,
  });

  sendSuccess(res, await withSignedUrl(await loadImage(params)));
}

/**
 * Replace the display order of a product's images in one write.
 *
 * The payload must list exactly the images the product has. A partial list would
 * silently push the omitted ones to the tail, which is almost never what an
 * operator dragging one thumbnail intended. Position `i` becomes `sortOrder` `i`.
 */
export async function reorderImages(req: Request, res: Response): Promise<void> {
  const productId = (req.validatedParams as { productId: string }).productId;
  const { imageIds } = req.validatedBody as z.infer<typeof imageReorderSchema>;

  const current = await db
    .select({ id: productImages.id })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  const currentIds = new Set(current.map((row) => row.id));
  const requested = new Set(imageIds);

  const unknown = [...requested].filter((id) => !currentIds.has(id));
  const missing = [...currentIds].filter((id) => !requested.has(id));

  if (unknown.length > 0 || missing.length > 0) {
    throw unprocessable("imageIds must list exactly the images this product has", {
      unknownImageIds: unknown,
      missingImageIds: missing,
    });
  }

  await db.transaction(async (tx) => {
    for (const [index, imageId] of imageIds.entries()) {
      await tx
        .update(productImages)
        .set({ sortOrder: index })
        .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)));
    }
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "product_image.reorder",
    // The ordered thing is the product's gallery, so the entity recorded is the
    // product: `entityId` must stay a real id of `entityType` for the entity-history
    // query to remain meaningful.
    entityType: "product",
    entityId: productId,
    metadata: { count: imageIds.length },
    req,
  });

  const rows = await db
    .select(imageSelect)
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

  sendSuccess(res, await withSignedUrls(rows));
}
