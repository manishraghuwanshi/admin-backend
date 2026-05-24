import { logger } from "../../utils/logger.js";
import { isProductImageKey } from "./keys.js";
import { deleteObject, isStorageConfigured } from "./s3.js";

/**
 * Best-effort object removal for keys this application wrote.
 *
 * Used to compensate a failed database write (the object is already in the bucket)
 * and to finish a delete whose row is already gone. It lives here rather than inside
 * one module because both the image routes and the product routes own objects in the
 * same `products/` namespace.
 *
 * The full key check is a hard stop, not an optimisation: the key came from the
 * database, and a hand-edited row must never be able to aim a delete at an object
 * outside this project's own `products/<uuid>/<uuid>.<ext>` namespace. A prefix test
 * alone would accept `products/whatever-else`, so the whole shape is verified.
 *
 * Failures are logged, never thrown: the caller's database state is already correct,
 * and an unreachable leftover object is the smaller problem. The return value says
 * which of the three outcomes happened so a caller can audit it honestly.
 */
export type ObjectRemovalOutcome = "deleted" | "skipped" | "failed";

export async function safeDeleteObject(
  storageKey: string,
  context: string,
): Promise<ObjectRemovalOutcome> {
  if (!isStorageConfigured()) {
    return "skipped";
  }

  if (!isProductImageKey(storageKey)) {
    logger.warn("refusing to delete object with an out-of-namespace key", {
      storageKey,
      context,
    });

    return "skipped";
  }

  try {
    await deleteObject(storageKey);

    return "deleted";
  } catch (error) {
    logger.error("orphaned object could not be deleted", { storageKey, context, error });

    return "failed";
  }
}
