/**
 * Application error with an HTTP status, machine-readable code, and a
 * safe client-facing message. Only these fields (plus optional details)
 * are sent to the client.
 */

export type ErrorCode =
  | "APP_ERROR"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_ERROR"
  | "REQUEST_ERROR"
  | "ROUTE_NOT_FOUND"
  | "CSRF_REJECTED"
  | "STORAGE_NOT_CONFIGURED"
  | "STORAGE_KEY_INVALID"
  | "SERVICE_UNAVAILABLE";

export class AppError extends Error {
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly code: ErrorCode | string;
  readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    options?: { cause?: unknown; code?: ErrorCode | string; details?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = options?.code ?? "APP_ERROR";
    this.details = options?.details;

    Error.captureStackTrace(this, AppError);
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(message, 400, { code: "VALIDATION_ERROR", details });
}

export function unauthorized(message = "Authentication required"): AppError {
  return new AppError(message, 401, { code: "UNAUTHORIZED" });
}

export function forbidden(message = "You do not have permission to perform this action"): AppError {
  return new AppError(message, 403, { code: "FORBIDDEN" });
}

export function notFound(message = "Resource not found"): AppError {
  return new AppError(message, 404, { code: "NOT_FOUND" });
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(message, 409, { code: "CONFLICT", details });
}

export function unprocessable(message: string, details?: unknown): AppError {
  return new AppError(message, 422, { code: "UNPROCESSABLE_ENTITY", details });
}

export function tooManyRequests(message = "Too many requests"): AppError {
  return new AppError(message, 429, { code: "TOO_MANY_REQUESTS" });
}

/** A required dependency did not answer. Readiness is the only current user. */
export function serviceUnavailable(message: string, details?: unknown): AppError {
  return new AppError(message, 503, { code: "SERVICE_UNAVAILABLE", details });
}

/**
 * A persisted object key failed validation. This is an integrity signal (the key
 * was written by an earlier, stricter code path or tampered with), never a plain
 * client mistake, so it is reported as 422 with a stable code.
 */
export function storageKeyInvalid(message: string, details?: unknown): AppError {
  return new AppError(message, 422, { code: "STORAGE_KEY_INVALID", details });
}

/** Normalizes any thrown value into a real Error instance. */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "string") {
    return new Error(value);
  }

  try {
    return new Error(`Non-error value thrown: ${JSON.stringify(value)}`);
  } catch {
    return new Error("Non-error value thrown");
  }
}

/** Body-parser errors carry `status`/`statusCode` plus a `type` we can map. */
export interface HttpLikeError extends Error {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
}

export function getErrorStatus(error: HttpLikeError): number {
  for (const candidate of [error.status, error.statusCode]) {
    const status = Number(candidate);

    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }

  return 500;
}

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
}

function asPostgresError(error: unknown): PostgresErrorLike | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as PostgresErrorLike;

  if (typeof candidate.code === "string") {
    return candidate;
  }

  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;

  if (cause && typeof cause === "object" && typeof (cause as PostgresErrorLike).code === "string") {
    return cause as PostgresErrorLike;
  }

  return undefined;
}

export function mapDatabaseError(error: unknown): AppError | undefined {
  const pg = asPostgresError(error);

  if (!pg?.code) {
    return undefined;
  }

  if (pg.code === "23505") {
    return conflict("A record with that unique value already exists", {
      constraint: pg.constraint,
    });
  }

  if (pg.code === "23503") {
    return unprocessable("Referenced record does not exist", {
      constraint: pg.constraint,
    });
  }

  if (pg.code === "23514") {
    return unprocessable("The request violates a data constraint", {
      constraint: pg.constraint,
    });
  }

  if (pg.code === "23502") {
    return badRequest("A required field is missing");
  }

  return undefined;
}
