import type { RequestHandler } from "express";
import type { ZodType } from "zod";

import { badRequest } from "../utils/errors.js";

interface ValidateOptions {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function validate(schemas: ValidateOptions): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) {
        req.validatedBody = schemas.body.parse(req.body);
      }

      if (schemas.query) {
        req.validatedQuery = schemas.query.parse(req.query);
      }

      if (schemas.params) {
        req.validatedParams = schemas.params.parse(req.params);
      }

      next();
    } catch (error) {
      next(toValidationError(error));
    }
  };
}

function toValidationError(error: unknown): Error {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: unknown }).issues;

    return badRequest("Validation failed", issues);
  }

  return badRequest("Validation failed");
}
