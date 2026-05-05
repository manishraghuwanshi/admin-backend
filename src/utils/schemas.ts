import { z } from "zod";

export const slugSchema = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens");

export const uuidParamSchema = z.object({
  id: z.uuid(),
});

/**
 * Params for routes nested as `/api/products/:productId/images...`.
 *
 * `uuidParamSchema` only proves `:id` is a UUID, which says nothing about the
 * product half of a nested route - and a stripped-by-Zod object would leave the
 * unvalidated raw value in `req.params`. Declaring `:productId` explicitly is what
 * lets the nesting mean something.
 */
export const productIdParamSchema = z.object({
  productId: z.uuid(),
});

/**
 * Params for `/api/products/:productId/images/:imageId`.
 *
 * Declaring both halves keeps the nesting meaningful: every handler verifies the
 * pair together, so an image belonging to another product is a 404 rather than a
 * successful cross-product mutation.
 */
export const productImageParamsSchema = z.object({
  productId: z.uuid(),
  imageId: z.uuid(),
});

export const optionalBooleanQuery = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true"));

/**
 * Upper bound for a money amount carried as a JavaScript `number`.
 *
 * `products.price` is a PostgreSQL `bigint`, so the column itself holds values far
 * past what this API can round-trip: Drizzle reads and writes it in `number` mode,
 * and anything above `Number.MAX_SAFE_INTEGER` arrives back silently rounded. A
 * price is a monetary value, not an arbitrary integer, so the ceiling is enforced at
 * the boundary rather than trusting the column type.
 */
export const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

/** A non-negative whole monetary amount that survives a `number` round trip. */
export const amountSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SAFE_AMOUNT, `Amount must not exceed ${MAX_SAFE_AMOUNT}`);

/**
 * The same bound for a query string, where the value arrives as text.
 *
 * Kept separate from `amountSchema` because coercion is only correct for
 * transport-layer strings; a JSON body must carry a real number, and coercing one
 * would let `"price": "12999abc"` through as a silent truncation.
 */
export const amountQuerySchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_SAFE_AMOUNT, `Amount must not exceed ${MAX_SAFE_AMOUNT}`);

