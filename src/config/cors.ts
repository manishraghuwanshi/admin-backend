import type { CorsOptions } from "cors";

import { env } from "./env.js";
import { logger } from "../utils/logger.js";

/**
 * CORS policy.
 *
 * - development/test: any `localhost` or `127.0.0.1` origin, any port, plus
 *   anything listed in `CORS_ORIGINS`.
 * - production: only origins listed in `CORS_ORIGINS`.
 *
 * Requests without an `Origin` header (curl, Postman, server-to-server) are
 * always allowed. A rejected origin simply receives no CORS headers, so the
 * request itself still completes server-side; the browser is what blocks the
 * response.
 */

const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function isLocalOrigin(origin: string): boolean {
  return LOCAL_ORIGIN_PATTERN.test(origin);
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  if (env.CORS_ORIGINS.includes(origin)) {
    return true;
  }

  return !env.IS_PRODUCTION && isLocalOrigin(origin);
}

export function buildCorsOptions(): CorsOptions {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);

        return;
      }

      logger.debug("CORS origin rejected", { origin, environment: env.NODE_ENV });
      callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // `allowedHeaders` is intentionally left unset: the request's
    // Access-Control-Request-Headers is reflected, as it is today.
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}
