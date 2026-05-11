import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { uuidParamSchema } from "../../utils/schemas.js";
import * as categoriesService from "./categories.service.js";

const router = Router();

router.use(requireAuth, requirePermission("categories.manage"));

router.get("/", validate({ query: categoriesService.categoryListQuerySchema }), (req, res, next) => {
  categoriesService.listCategories(req, res).catch(next);
});

router.get("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  categoriesService.getCategory(req, res).catch(next);
});

router.post("/", validate({ body: categoriesService.categoryBodySchema }), (req, res, next) => {
  categoriesService.createCategory(req, res).catch(next);
});

router.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: categoriesService.categoryUpdateSchema }),
  (req, res, next) => {
    categoriesService.updateCategory(req, res).catch(next);
  },
);

router.delete("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  categoriesService.deleteCategory(req, res).catch(next);
});

export default router;
