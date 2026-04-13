import type { RequestHandler } from "express";

import { env } from "../config/env.js";

/**
 * Baseline security headers for a JSON-only API.
 *
 * `X-Powered-By` is disabled separately in `app.ts` (via `app.disable`), so the
 * framework is not advertised in responses.
 */

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );

  // HSTS only makes sense over HTTPS; harmless in development but excluded
  // there so localhost (plain HTTP) behaviour stays predictable.
  if (env.IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
};