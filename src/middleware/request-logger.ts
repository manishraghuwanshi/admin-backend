import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

import { logger } from "../utils/logger.js";

/**
 * Assigns a correlation id to every request, echoes it back in the
 * `X-Request-Id` response header, and logs one completion line per request.
 */

const REQUEST_ID_HEADER = "x-request-id";
const MAX_REQUEST_ID_LENGTH = 64;

export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER)?.trim();

  req.requestId =
    incoming && incoming.length <= MAX_REQUEST_ID_LENGTH ? incoming : randomUUID();

  res.setHeader("X-Request-Id", req.requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const status = res.statusCode;

    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

    logger[level]("request completed", {
      requestId: req.requestId,
      method: req.method,
      // `req.path` excludes the query string (may contain tokens later).
      path: req.path,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
  });

  next();
};