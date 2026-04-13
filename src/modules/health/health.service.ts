import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.js";
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
 * against the database.
 *
 * Neither response ever carries a connection string or a driver error message: a
 * dependency's own message frequently contains exactly that, which makes it
 * unusable as diagnostic output on an unauthenticated endpoint.
 */

export type DependencyState = "ok" | "unavailable";

export interface ReadinessReport {
  /** True only when every *required* dependency answered. */
  ready: boolean;
  database: DependencyState;
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

export async function probeDependencies(): Promise<ReadinessReport> {
  const database = await checkDatabase();

  return {
    ready: database === "ok",
    database,
  };
}

export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const report = await probeDependencies();

  if (!report.ready) {
    res.status(503).json({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is not ready",
        details: report,
      },
    });

    return;
  }

  sendSuccess(res, report);
}