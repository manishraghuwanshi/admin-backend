import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { buildCorsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { csrfOriginCheck } from "./middleware/csrf.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { requestLogger } from "./middleware/request-logger.js";
import { securityHeaders } from "./middleware/security-headers.js";
import authRouter from "./modules/auth/auth.routes.js";
import auditLogsRouter from "./modules/audit-logs/audit-logs.routes.js";
import adminUsersRouter from "./modules/admin-users/admin-users.routes.js";
import brandsRouter from "./modules/brands/brands.routes.js";
import categoriesRouter from "./modules/categories/categories.routes.js";
import imagesRouter from "./modules/product-images/product-images.routes.js";
import inventoryRouter from "./modules/inventory/inventory.routes.js";
import productsRouter from "./modules/products/products.routes.js";

/**
 * Builds the Express application.
 *
 * Middleware order matters: security headers and logging wrap everything,
 * CORS runs before body parsing (so preflights short-circuit cheaply), and the
 * 404/error handlers are registered last.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  // Express default is `false`. Enable TRUST_PROXY when running behind a
  // proxy/load balancer so `req.ip` and `req.protocol` are accurate.
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(requestLogger);
  app.use(cors(buildCorsOptions()));
  app.use(cookieParser());
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  // Liveness: no I/O, so a database outage cannot make an orchestrator restart a
  // process that would come back equally unable to serve.
  app.get("/health", (_req, res) => {
    res.json({
      success: true,
      message: "Admin backend is running",
    });
  });

  // Cookie-authenticated endpoints: every state-changing request must carry a
  // same-site Origin (see `csrfOriginCheck`).
  app.use("/api", csrfOriginCheck);

  app.use("/api/auth", authRouter);
  app.use("/api/admin-users", adminUsersRouter);
  app.use("/api/audit-logs", auditLogsRouter);
  app.use("/api/brands", brandsRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/inventory", inventoryRouter);

  // Mounted before `/api/products` on purpose. Express matches a mount prefix by
  // path segment, so `productsRouter` (which calls `requireAuth` at router level)
  // would otherwise run first for every image request and pay for its own token
  // verification before this router gets the chance to do the same.
  app.use("/api/products/:productId/images", imagesRouter);
  app.use("/api/products", productsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
