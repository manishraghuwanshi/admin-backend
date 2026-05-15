import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { productIdParamSchema } from "../../utils/schemas.js";
import * as inventoryService from "./inventory.service.js";

/**
 * Inventory API.
 *
 * `requireAuth` runs for the whole router, then each route declares the single
 * permission it needs. Reading stock and writing stock are separate permissions
 * because the `editor` role legitimately has `inventory.read` but must not be able
 * to change quantities.
 */
const router = Router();

router.use(requireAuth);

router.get(
  "/",
  requirePermission("inventory.read"),
  validate({ query: inventoryService.inventoryListQuerySchema }),
  (req, res, next) => {
    inventoryService.listInventory(req, res).catch(next);
  },
);

router.get(
  "/:productId",
  requirePermission("inventory.read"),
  validate({ params: productIdParamSchema }),
  (req, res, next) => {
    inventoryService.getInventory(req, res).catch(next);
  },
);

router.put(
  "/:productId",
  requirePermission("inventory.write"),
  validate({ params: productIdParamSchema, body: inventoryService.inventorySetSchema }),
  (req, res, next) => {
    inventoryService.setInventory(req, res).catch(next);
  },
);

router.post(
  "/:productId/adjust",
  requirePermission("inventory.write"),
  validate({ params: productIdParamSchema, body: inventoryService.inventoryAdjustSchema }),
  (req, res, next) => {
    inventoryService.adjustInventory(req, res).catch(next);
  },
);

export default router;
