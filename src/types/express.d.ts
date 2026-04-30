import "express-serve-static-core";
import type { AuthUser } from "./auth.js";

/**
 * Express 5 types the request object with `express-serve-static-core`, so the
 * augmentation has to target that module. The previous
 * `declare global { namespace Express }` block was silently ignored, which left
 * `req.requestId`/`req.authUser` untyped and `pnpm type-check` failing.
 *
 * `Express.Request` extends `core.Request`, so augmenting the core interface
 * surfaces the properties on both `Request` and `RequestHandler` usage.
 */
declare module "express-serve-static-core" {
  interface Request {
    /** Correlation id assigned by the request logger. */
    requestId: string;
    authUser?: AuthUser;
    validatedBody?: unknown;
    validatedQuery?: unknown;
    validatedParams?: unknown;
  }
}
