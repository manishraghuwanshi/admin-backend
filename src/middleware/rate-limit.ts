import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { env } from "../config/env.js";
import { tooManyRequests } from "../utils/errors.js";

/**
 * Rate limiting.
 *
 * The shared limit applied to real routes follows one rule: the test environment
 * gets a ceiling high enough that no suite can trip it by accident, because a limit
 * a test cannot disable turns an unrelated run into a flaky `429`. `limit` is a
 * parameter rather than a constant precisely so that a test can opt back into a
 * small one and assert the rejection shape.
 */
function limiter(options: {
  windowMs: number;
  limit: number;
  message: string;
  /** Override the test-environment relaxation. Only a test should need this. */
  applyInTests?: boolean;
}): RateLimitRequestHandler {
  const limit =
    env.IS_TEST && !options.applyInTests ? 1000 : options.limit;

  return rateLimit({
    windowMs: options.windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: () => {
      throw tooManyRequests(options.message);
    },
  });
}

/** Credential stuffing is the threat here, so the window is deliberately tight. */
export const authRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: "Too many authentication attempts. Try again later.",
});

/**
 * Audit-log reads are the one surface where an administrator can make the database
 * do meaningful work per request, and the only one that returns another
 * administrator's activity. A ceiling of a few hundred reads per hour is far above
 * anything a dashboard does while still capping scraping.
 */
export const auditReadRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  message: "Too many audit-log requests. Try again later.",
});

/**
 * A limiter with an explicit small limit, for tests that need to observe a `429`.
 *
 * Nothing in the production route table uses this; it exists so the rejection path
 * is verifiable without lowering a real safeguard to the point that it fires during
 * normal dashboard use.
 */
export function testRateLimiter(limit: number): RateLimitRequestHandler {
  return limiter({ windowMs: 60 * 1000, limit, message: "Too many requests.", applyInTests: true });
}

