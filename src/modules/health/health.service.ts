import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { getS3Client, isStorageConfigured } from "../../lib/storage/s3.js";
import { serviceUnavailable } from "../../utils/errors.js";
import { sendSuccess } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";

/**
 * Liveness and readiness.
 *
 * `/health` answers only "is this process up". It performs no I/O, so a database
 * outage cannot make a load balancer restart a perfectly healthy process that would
 * come back unable to serve traffic.
 *
 * `/ready` answers "should this instance receive traffic". It runs one cheap query
 * and, when storage is configured, one cheap bucket-level request.
 *
 * Neither response ever carries a connection string, bucket name, endpoint, or error
 * message from the driver. A dependency's own message frequently contains exactly
 * that, which makes it unusable as diagnostic output on an unauthenticated endpoint.
 * What is reported is a boolean and, for the branch, a non-secret label an operator
 * set themselves.
 */

export type DependencyState = "ok" | "unavailable" | "not-configured";

export interface ReadinessReport {
  /** True only when every *required* dependency answered. */
  ready: boolean;
  database: DependencyState;
  /**
   * `not-configured` rather than `unavailable` when no storage credentials exist:
   * that environment legitimately has no bucket, and calling it down would make
   * every local deployment look broken.
   */
  storage: DependencyState;
  /** The Neon branch label, when `NEON_BRANCH` is set. Never anything else. */
  branch?: string;
}

async function checkDatabase(): Promise<DependencyState> {
  try {
    await db.execute(sql`SELECT 1`);

    return "ok";
  } catch (error) {
    // Logged with full detail for the operator, reported as a bare status to the
    // caller.
    logger.error("readiness: database check failed", { error });

    return "unavailable";
  }
}

/**
 * Ask only that the bucket answers, not that any particular object exists.
 *
 * `HeadObject` on a key this application would not have written is the cheapest
 * read-only call available, and a `404` still proves the endpoint and credentials
 * work - which is all readiness can reasonably assert about storage.
 */
async function checkStorage(): Promise<DependencyState> {
  if (!isStorageConfigured()) {
    return "not-configured";
  }

  try {
    await getS3Client().send(
      new HeadObjectCommand({
        Bucket: env.STORAGE_BUCKET,
        Key: "readiness-probe",
      }),
    );

    return "ok";
  } catch (error) {
    // A missing key is the expected answer; anything else is a real dependency fault.
    if (isNotFoundResponse(error)) {
      return "ok";
    }

    logger.error("readiness: object storage check failed", { error });

    return "unavailable";
  }
}

function isNotFoundResponse(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    __type?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === "NotFound" ||
    (candidate?.__type?.endsWith("NotFound") ?? false)
  );
}

export async function probeDependencies(): Promise<ReadinessReport> {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);

  return {
    // Object Storage is not required to serve traffic: the catalog and authentication
    // paths work without it, and only image routes need it. A bucket outage must not
    // pull an otherwise healthy instance out of rotation.
    ready: database === "ok",
    database,
    storage,
    ...(env.NEON_BRANCH ? { branch: env.NEON_BRANCH } : {}),
  };
}

export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const report = await probeDependencies();

  if (!report.ready) {
    // Thrown rather than hand-built so the body keeps the standard error envelope
    // (`code`, `message`, `requestId`) instead of inventing a third shape. The
    // per-dependency states ride along as `details`, which is where an operator
    // looking at a failed probe actually wants them.
    throw serviceUnavailable("Service is not ready", report);
  }

  sendSuccess(res, report);
}
