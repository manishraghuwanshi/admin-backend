import { eq } from "drizzle-orm";

import type { DbTransaction } from "../db/index.js";
import { inventory } from "../db/schema.js";

/**
 * Lock and read a product's inventory row.
 *
 * Shared by `PUT /api/inventory/:productId` and the nested inventory write in
 * `PATCH /api/products/:id`. Both are absolute setters that must carry over the
 * fields the caller omitted, so both have to read the row inside their own
 * transaction with the same lock — otherwise whichever write lands second silently
 * discards the first with a value it read before the other one committed.
 *
 * It lives here rather than in either module so neither service depends on the other,
 * and so there is exactly one statement of which lock is correct and why.
 *
 * `FOR NO KEY UPDATE` is the weakest row lock that still blocks a concurrent
 * `UPDATE` of the same row. It is preferred over `FOR UPDATE` because deleting a
 * product takes a key-share lock on the inventory row through the cascading foreign
 * key, and `FOR UPDATE` would deadlock against that while `FOR NO KEY UPDATE` will
 * not.
 */
export async function lockInventoryRow(run: DbTransaction, productId: string) {
  const [row] = await run
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId))
    .limit(1)
    .for("no key update");

  return row;
}
