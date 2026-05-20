import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { uuidParamSchema } from "../../utils/schemas.js";
import * as adminUsersService from "./admin-users.service.js";

/**
 * Administrator management.
 *
 * Everything here is gated on `adminUsers.manage`, which only the `owner` role
 * holds (see `src/lib/auth/permissions.ts`). The service layer adds the
 * self-lockout and last-owner guards on top, because knowing a caller *may*
 * manage admins says nothing about whether a specific mutation is safe.
 */
const router = Router();

router.use(requireAuth, requirePermission("adminUsers.manage"));

router.get(
  "/",
  validate({ query: adminUsersService.adminUserListQuerySchema }),
  (req, res, next) => {
    adminUsersService.listAdminUsers(req, res).catch(next);
  },
);

router.get("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  adminUsersService.getAdminUser(req, res).catch(next);
});

router.post(
  "/",
  validate({ body: adminUsersService.adminUserCreateSchema }),
  (req, res, next) => {
    adminUsersService.createAdminUser(req, res).catch(next);
  },
);

router.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: adminUsersService.adminUserUpdateSchema }),
  (req, res, next) => {
    adminUsersService.updateAdminUser(req, res).catch(next);
  },
);

router.put(
  "/:id/password",
  validate({ params: uuidParamSchema, body: adminUsersService.adminUserPasswordSchema }),
  (req, res, next) => {
    adminUsersService.setAdminUserPassword(req, res).catch(next);
  },
);

router.delete("/:id", validate({ params: uuidParamSchema }), (req, res, next) => {
  adminUsersService.deleteAdminUser(req, res).catch(next);
});

router.get("/:id/sessions", validate({ params: uuidParamSchema }), (req, res, next) => {
  adminUsersService.listAdminUserSessions(req, res).catch(next);
});

router.post("/:id/sessions/revoke", validate({ params: uuidParamSchema }), (req, res, next) => {
  adminUsersService.revokeAdminUserSessions(req, res).catch(next);
});

router.get("/:id/audit-logs", validate({ params: uuidParamSchema }), (req, res, next) => {
  adminUsersService.listAdminUserAuditLogs(req, res).catch(next);
});

export default router;
