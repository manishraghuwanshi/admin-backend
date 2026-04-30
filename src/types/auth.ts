import type { AdminRole } from "../db/schema.js";

/**
 * Authenticated administrator resolved from a valid access token plus a live,
 * non-revoked refresh session.
 *
 * This lives in its own module (instead of `middleware/auth.ts`) so that
 * `types/express.d.ts` can reference it without importing the Express-typed
 * middleware, which would create a circular dependency that breaks the
 * `express-serve-static-core` request augmentation.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  sessionId: string;
}
