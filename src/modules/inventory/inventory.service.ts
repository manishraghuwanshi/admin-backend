import { and, count, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { inventory, products } from "../../db/schema.js";
import { lockInventoryRow } from "../../lib/inventory-lock.js";
import { recordAudit } from "../../lib/audit.js";
import { notFound, unprocessable } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import {
  paginationMeta,
  paginationOffset,
  paginationQuerySchema,
} from "../../utils/pagination.js";
import { validatedProductId } from "../../utils/params.js";

/**
 * Dedicated inventory API.
 *
 * Inventory rows are created alongside products and can still be adjusted through
 * `PATCH /api/products/:id`. This module adds the two things that endpoint cannot
 * offer:
 *
 * 1. A permission-separated surface (`inventory.read` / `inventory.write`) so an
 *    editor can look at stock without being able to change it.
 * 2. `POST /:productId/adjust`, a relative delta operation. It is the only
 *    stock-write that is safe under concurrency, because the new value is computed
 *    by PostgreSQL inside the `UPDATE`: two administrators adjusting the same
 *    product at the same time both take effect, instead of the later write
 *    silently discarding the earlier one.
 *
 * The absolute setter (`PUT`) is inherently a read-modify-write, so it locks the
 * row first; the "reservation fits" check then evaluates against the value the row
 * actually holds at that moment rather than a value read earlier.
 */

export const inventorySetSchema = z
  .object({
    quantity: z.number().int().min(0),
    reservedQuantity: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(5),
  })
  .refine((value) => value.reservedQuantity <= value.quantity, {
    message: "reservedQuantity cannot exceed quantity",
    path: ["reservedQuantity"],
  });

export const inventoryAdjustSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0, { message: "delta cannot be 0" }),
  /** Optional so that restocking does not silently change reservations. */
  reservedQuantity: z.number().int().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const inventoryListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  brandId: z.uuid().optional(),
  /** `low` compares against each product's own threshold, not a global number. */
  stockState: z.enum(["any", "inStock", "low", "out"]).default("any"),
  sort: z.enum(["updatedAt", "available", "product"]).default("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** The read shape: inventory joined to the product fields an operator needs. */
const inventoryView = {
  productId: inventory.productId,
  productSku: products.sku,
  productName: products.name,
  productSlug: products.slug,
  productIsActive: products.isActive,
  brandId: products.brandId,
  quantity: inventory.quantity,
  reservedQuantity: inventory.reservedQuantity,
  lowStockThreshold: inventory.lowStockThreshold,
  availableQuantity: sql<number>`${inventory.quantity} - ${inventory.reservedQuantity}`.mapWith(
    Number,
  ),
  updatedAt: inventory.updatedAt,
};

/** Enforce the pair the caller supplied against the `inventory` check constraints. */
function assertReservationFits(quantity: number, reservedQuantity: number): void {
  if (reservedQuantity > quantity) {
    throw unprocessable("reservedQuantity cannot exceed quantity", {
      path: ["reservedQuantity"],
    });
  }
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
 * The row lock this module uses lives in `lib/inventory-lock.ts`, shared with the
 * nested inventory write in `PATCH /api/products/:id`: two statements of "which
 * lock is correct" is how one of them eventually drifts, and a drift here reopens
 * the lost-write bug the lock exists to close.
 */

async function loadInventoryView(productId: string) {
  const [row] = await db
    .select(inventoryView)
    .from(inventory)
    .innerJoin(products, eq(products.id, inventory.productId))
    .where(eq(inventory.productId, productId))
    .limit(1);

  return row;
}

export async function getInventory(req: Request, res: Response): Promise<void> {
  const productId = validatedProductId(req);
  const row = await loadInventoryView(productId);

  if (!row) {
    // A product without an inventory row is a data gap rather than a bad id, so
    // tell the caller which of the two it hit.
    await assertProductExists(productId);

    throw notFound("Inventory record not found for product");
  }

  sendSuccess(res, row);
}

/**
 * Set absolute quantities.
 *
 * The row is locked before the values are validated, so the "reservation must fit
 * the quantity" rule is checked against the state this write is about to replace
 * rather than against a read that may already be stale.
 */
export async function setInventory(req: Request, res: Response): Promise<void> {
  const productId = validatedProductId(req);
  const body = req.validatedBody as z.infer<typeof inventorySetSchema>;

  await assertProductExists(productId);

  const before = await db.transaction(async (tx) => {
    const current = await lockInventoryRow(tx, productId);

    assertReservationFits(body.quantity, body.reservedQuantity);

    const values = {
      quantity: body.quantity,
      reservedQuantity: body.reservedQuantity,
      lowStockThreshold: body.lowStockThreshold,
      updatedAt: new Date(),
    };

    if (current) {
      await tx.update(inventory).set(values).where(eq(inventory.productId, productId));
    } else {
      await tx.insert(inventory).values({ productId, ...values });
    }

    return current
      ? {
          quantity: current.quantity,
          reservedQuantity: current.reservedQuantity,
          lowStockThreshold: current.lowStockThreshold,
        }
      : null;
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "inventory.set",
    entityType: "inventory",
    entityId: productId,
    metadata: { before, after: body },
    req,
  });

  sendSuccess(res, await loadInventoryView(productId));
}

/**
 * Apply a relative stock delta.
 *
 * The whole operation is one `UPDATE`: the new quantity is computed by PostgreSQL
 * from the stored value, and both guards (never negative, reservations still fit)
 * live in the `WHERE` clause. Two concurrent adjustments therefore serialise on the
 * row and both land, which a read-modify-write cannot promise.
 *
 * Zero rows updated means either the row is missing or a guard rejected the change.
 * The follow-up read tells them apart and only runs on the failure path.
 */
export async function adjustInventory(req: Request, res: Response): Promise<void> {
  const productId = validatedProductId(req);
  const body = req.validatedBody as z.infer<typeof inventoryAdjustSchema>;

  await assertProductExists(productId);

  const newQuantity = sql`${inventory.quantity} + ${body.delta}`;
  const effectiveReserved =
    body.reservedQuantity === undefined
      ? sql`${inventory.reservedQuantity}`
      : sql`${body.reservedQuantity}`;

  const adjusted = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(inventory)
      .set({
        quantity: newQuantity,
        ...(body.reservedQuantity !== undefined
          ? { reservedQuantity: body.reservedQuantity }
          : {}),
        ...(body.lowStockThreshold !== undefined
          ? { lowStockThreshold: body.lowStockThreshold }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventory.productId, productId),
          sql`${newQuantity} >= 0`,
          sql`${effectiveReserved} <= ${newQuantity}`,
        ),
      )
      .returning({ id: inventory.id });

    if (!updated) {
      return null;
    }

    const [row] = await tx
      .select({
        quantity: inventory.quantity,
        reservedQuantity: inventory.reservedQuantity,
      })
      .from(inventory)
      .where(eq(inventory.id, updated.id));

    return row;
  });

  if (!adjusted) {
    const current = await loadInventoryView(productId);

    if (!current) {
      throw notFound("Inventory record not found for product");
    }

    // Report the guard that actually failed rather than guessing from the sign of
    // the delta: a negative delta can also collide with the reservation.
    const wouldGoNegative = current.quantity + body.delta < 0;

    throw unprocessable(
      wouldGoNegative
        ? "Adjustment would take stock below zero"
        : "Adjustment conflicts with the resulting quantity",
      {
        quantity: current.quantity,
        reservedQuantity: current.reservedQuantity,
        delta: body.delta,
      },
    );
  }

  await recordAudit({
    actorId: req.authUser?.id,
    action: "inventory.adjust",
    entityType: "inventory",
    entityId: productId,
    metadata: {
      delta: body.delta,
      reason: body.reason ?? null,
      quantity: adjusted.quantity,
      reservedQuantity: adjusted.reservedQuantity,
    },
    req,
  });

  sendSuccess(res, await loadInventoryView(productId));
}

/**
 * Filter helpers for the listing.
 *
 * `low` is deliberately relative: every product carries its own
 * `lowStockThreshold`, so "low" means "below this product's own reorder point",
 * which is the only reading that stays useful across a mixed catalogue. The
 * expression reuses the same `available` fragment as the projected column so the
 * filter and the response field cannot drift apart.
 */
function listFilters(query: z.infer<typeof inventoryListQuerySchema>): SQL | undefined {
  const available = sql`${inventory.quantity} - ${inventory.reservedQuantity}`;
  const filters: SQL[] = [];

  if (query.search) {
    const term = `%${query.search}%`;

    filters.push(or(ilike(products.name, term), ilike(products.sku, term))!);
  }

  if (query.brandId) {
    filters.push(eq(products.brandId, query.brandId));
  }

  if (query.stockState === "inStock") {
    filters.push(sql`${available} > 0`);
  } else if (query.stockState === "low") {
    filters.push(and(sql`${available} > 0`, lt(available, sql`${inventory.lowStockThreshold}`))!);
  } else if (query.stockState === "out") {
    filters.push(sql`${available} <= 0`);
  }

  return filters.length === 0 ? undefined : and(...filters);
}

export async function listInventory(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof inventoryListQuerySchema>;
  const where = listFilters(query);

  const available = sql`${inventory.quantity} - ${inventory.reservedQuantity}`;
  const sortColumn = {
    updatedAt: inventory.updatedAt,
    available,
    product: products.name,
  }[query.sort];

  const orderBy = query.order === "asc" ? sortColumn : desc(sortColumn);

  const [totalRow] = await db
    .select({ total: count() })
    .from(inventory)
    .innerJoin(products, eq(products.id, inventory.productId))
    .where(where);

  const rows = await db
    .select(inventoryView)
    .from(inventory)
    .innerJoin(products, eq(products.id, inventory.productId))
    .where(where)
    .orderBy(orderBy)
    .limit(query.limit)
    .offset(paginationOffset(query.page, query.limit));

  sendPaginated(
    res,
    rows,
    paginationMeta(query.page, query.limit, Number(totalRow?.total ?? 0)),
  );
}

