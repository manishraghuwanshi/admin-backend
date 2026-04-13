import type { ErrorRequestHandler } from "express";

import { env } from "../config/env.js";
import {
  AppError,
  getErrorStatus,
  mapDatabaseError,
  toError,
  type HttpLikeError,
} from "../utils/errors.js";
import { logger } from "../utils/logger.js";

interface MappedError {
  statusCode: number;
  message: string;
  code: string;
  details?: unknown;
}

function mapError(error: HttpLikeError): MappedError {
  const fromDatabase = mapDatabaseError(error);

  if (fromDatabase) {
    return {
      statusCode: fromDatabase.statusCode,
      message: fromDatabase.message,
      code: fromDatabase.code,
      details: fromDatabase.details,
    };
  }

  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }

  const statusCode = getErrorStatus(error);

  if (error.type === "entity.parse.failed") {
    return {
      statusCode: 400,
      message: "Request body is not valid JSON",
      code: "INVALID_JSON",
    };
  }

  if (error.type === "entity.too.large") {
    return {
      statusCode: 413,
      message: `Request body is too large (limit ${env.JSON_BODY_LIMIT})`,
      code: "PAYLOAD_TOO_LARGE",
    };
  }

  if (statusCode >= 500) {
    return {
      statusCode,
      message: "Internal server error",
      code: "INTERNAL_ERROR",
    };
  }

  return {
    statusCode,
    message: error.message || "Request could not be processed",
    code: "REQUEST_ERROR",
  };
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);

    return;
  }

  const normalized = toError(error);
  const { statusCode, message, code, details } = mapError(normalized as HttpLikeError);

  const logPayload = {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status: statusCode,
    code,
    error: normalized,
  };

  if (statusCode >= 500) {
    logger.error("request failed", logPayload);
  } else {
    logger.warn("request rejected", logPayload);
  }

  const errorBody: Record<string, unknown> = {
    code,
    message,
  };

  if (details !== undefined) {
    errorBody.details = details;
  }

  const body: Record<string, unknown> = {
    success: false,
    error: errorBody,
    requestId: req.requestId,
  };

  if (!env.IS_PRODUCTION && statusCode >= 500 && !(normalized instanceof AppError)) {
    errorBody.details = { detail: normalized.message };
  }

  res.status(statusCode).json(body);
};
