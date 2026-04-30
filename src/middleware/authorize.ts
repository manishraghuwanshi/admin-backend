import type { RequestHandler } from "express";

import { hasPermission, type Permission } from "../lib/auth/permissions.js";
import { forbidden, unauthorized } from "../utils/errors.js";

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.authUser;

    if (!user) {
      next(unauthorized());

      return;
    }

    const allowed = permissions.every((permission) => hasPermission(user.role, permission));

    if (!allowed) {
      next(forbidden());

      return;
    }

    next();
  };
}

/**
 * Allow the request when the caller holds *at least one* of the permissions.
 *
 * `requirePermission` is an "all of" check, which is right for compound operations
 * but wrong for alternatives. The audit-log routes need this form: `auditLogs.read`
 * grants the whole log, `auditLogs.readLimited` grants only the caller's own rows,
 * and either is enough to reach the endpoint. Which of the two applies is then
 * resolved inside the service, because it changes the query rather than the
 * verdict.
 */
export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.authUser;

    if (!user) {
      next(unauthorized());

      return;
    }

    const allowed = permissions.some((permission) => hasPermission(user.role, permission));

    if (!allowed) {
      next(forbidden());

      return;
    }

    next();
  };
}

