import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { uuidParamSchema } from "../../utils/schemas.js";
import * as productsService from "./products.service.js";

const router = Router();

router.use(requireAuth);

router.get(
  "/",
  requirePermission("products.read"),
  validate({ query: productsService.productListQuerySchema }),
  (req, res, next) => {
    productsService.listProducts(req, res).catch(next);
  },
);

router.get("/:id", requirePermission("products.read"), validate({ params: uuidParamSchema }), (req, res, next) => {
  productsService.getProduct(req, res).catch(next);
});

router.post(
  "/",
  requirePermission("products.write"),
  validate({ body: productsService.productCreateSchema }),
  (req, res, next) => {
    productsService.createProduct(req, res).catch(next);
  },
);

router.patch(
  "/:id",
  requirePermission("products.write"),
  validate({ params: uuidParamSchema, body: productsService.productUpdateSchema }),
  (req, res, next) => {
    productsService.updateProduct(req, res).catch(next);
  },
);

router.delete("/:id", requirePermission("products.delete"), validate({ params: uuidParamSchema }), (req, res, next) => {
  productsService.deleteProduct(req, res).catch(next);
});

export default router;
