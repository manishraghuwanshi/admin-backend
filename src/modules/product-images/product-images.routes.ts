import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { productImageParamsSchema, productIdParamSchema } from "../../utils/schemas.js";
import * as imageService from "./product-images.service.js";

/**
 * Product image administration, nested under the product that owns the images.
 *
 * Nesting is not cosmetic: every handler receives `:productId` and, where relevant,
 * `:imageId`, and verifies the pair together. Another product's image is therefore a
 * 404 rather than a successful cross-product mutation.
 *
 * `productIdParamSchema` at router level validates `:productId` for every route
 * here; routes that also carry `:imageId` layer on `productImageParamsSchema`.
 * A dedicated schema is needed rather than reusing `uuidParamSchema`, because Zod
 * objects strip unknown keys - that one would discard `productId` entirely.
 *
 * All routes require `images.manage`, which `owner`, `manager`, and `editor` hold.
 * Editor access to *deletion* is deliberate - that is what the permission table says
 * - and it is the reason object deletes are restricted to the `products/` prefix.
 */
const router = Router({ mergeParams: true });

router.use(
  requireAuth,
  requirePermission("images.manage"),
  validate({ params: productIdParamSchema }),
);

router.post(
  "/",
  validate({ body: imageService.imageCreateSchema }),
  (req, res, next) => {
    imageService.createImage(req, res).catch(next);
  },
);

/**
 * Declared before `/:imageId` so the literal `reorder` segment is never captured by
 * the parameter route.
 */
router.post(
  "/reorder",
  validate({ body: imageService.imageReorderSchema }),
  (req, res, next) => {
    imageService.reorderImages(req, res).catch(next);
  },
);

router.get("/", (req, res, next) => {
  imageService.listImages(req, res).catch(next);
});

router.get(
  "/:imageId",
  validate({ params: productImageParamsSchema }),
  (req, res, next) => {
    imageService.getImage(req, res).catch(next);
  },
);

router.patch(
  "/:imageId",
  validate({
    params: productImageParamsSchema,
    body: imageService.imageUpdateSchema,
  }),
  (req, res, next) => {
    imageService.updateImage(req, res).catch(next);
  },
);

router.put(
  "/:imageId/primary",
  validate({ params: productImageParamsSchema }),
  (req, res, next) => {
    imageService.setPrimaryImage(req, res).catch(next);
  },
);

router.delete(
  "/:imageId",
  validate({ params: productImageParamsSchema }),
  (req, res, next) => {
    imageService.deleteImage(req, res).catch(next);
  },
);

export default router;
