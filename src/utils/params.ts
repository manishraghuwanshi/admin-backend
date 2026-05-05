import type { Request } from "express";
import type { z } from "zod";

import type { AppError } from "./errors.js";
import type { productIdParamSchema, uuidParamSchema } from "./schemas.js";

/**
 * Helpers shared by modules that address a single row by UUID.
 *
 * `uuidParamSchema` proves the value is a UUID, not that the row exists, so every
 * service repeats the same "load it or fail with 404" step. Sharing it keeps the
 * generated `:otherId` parameter from being read by accident.
 */

/** The validated `:id` of the current request. */
export function validatedId(req: Request): string {
  return (req.validatedParams as z.infer<typeof uuidParamSchema>).id;
}

/**
 * The validated `:productId` of a route mounted as `/api/.../:productId/...`.
 *
 * Separate from `validatedId()` because the two schemas carry different key names:
 * reading `.id` off `:productId` params yields `undefined`, which then reaches the
 * database as `where productId is null` instead of failing loudly.
 */
export function validatedProductId(req: Request): string {
  return (req.validatedParams as z.infer<typeof productIdParamSchema>).productId;
}

/** Load a row by id, or throw the supplied 404 when it does not exist. */
export async function requireRow<T>(
  id: string,
  load: (id: string) => Promise<T | undefined | null>,
  missing: () => AppError,
): Promise<T> {
  const row = await load(id);

  if (!row) {
    throw missing();
  }

  return row;
}
