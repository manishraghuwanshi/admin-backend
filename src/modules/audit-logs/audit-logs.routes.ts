import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requireAnyPermission } from "../../middleware/authorize.js";
import { auditReadRateLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as auditService from "./audit-logs.service.js";

/**
 * Audit-log reading.
 *
 * `requireAnyPermission` is used because the two audit permissions are
 * alternatives, not requirements, and the distinction changes the query rather
 * than the verdict - see `resolveScope()` in the service.
 *
 * `auditReadRateLimiter` is per-router rather than per-route: the three endpoints
 * are one activity (paging through a log), and counting them separately would let a
 * caller multiply the budget by alternating between them.
 */
const router = Router();

router.use(requireAuth, requireAnyPermission("auditLogs.read", "auditLogs.readLimited"));
router.use(auditReadRateLimiter);

router.get(
  "/",
  validate({ query: auditService.auditLogListQuerySchema }),
  (req, res, next) => {
    auditService.listAuditLogs(req, res).catch(next);
  },
);

router.get("/actions", (req, res, next) => {
  auditService.listAuditActions(req, res).catch(next);
});

router.get(
  "/entity/:entityType/:entityId",
  validate({ params: auditService.entityAuditParamsSchema }),
  (req, res, next) => {
    auditService.listEntityAuditLogs(req, res).catch(next);
  },
);

export default router;
