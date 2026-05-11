import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { uuidParamSchema } from "../../utils/schemas.js";
import * as brandsService from "./brands.service.js";

const router = Router();

router.use(requireAuth, requirePermission("brands.manage"));

router.get("/", validate({ query: brandsService.brandListQuerySchema }), (req, res, next) => {
  brandsService.listBrands(req, res).catch(next);
});

router.get("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  brandsService.getBrand(req, res).catch(next);
});

router.post("/", validate({ body: brandsService.brandBodySchema }), (req, res, next) => {
  brandsService.createBrand(req, res).catch(next);
});

router.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: brandsService.brandUpdateSchema }),
  (req, res, next) => {
    brandsService.updateBrand(req, res).catch(next);
  },
);

router.delete("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  brandsService.deleteBrand(req, res).catch(next);
});

export default router;
