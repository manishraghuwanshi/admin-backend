import type { RequestHandler } from "express";

import { isOriginAllowed } from "../config/cors.js";
import { AppError } from "../utils/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browser cookie-authenticated APIs are CSRF-vulnerable on cross-site POSTs.
 * Reject state-changing requests whose Origin is not in the CORS allow-list.
 * Requests without Origin (curl, server-to-server) are allowed.
 */
export const csrfOriginCheck: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();

    return;
  }

  const origin = req.get("origin");

  if (isOriginAllowed(origin)) {
    next();

    return;
  }

  next(
    new AppError("Cross-origin request blocked", 403, {
      code: "CSRF_REJECTED",
    }),
  );
};
