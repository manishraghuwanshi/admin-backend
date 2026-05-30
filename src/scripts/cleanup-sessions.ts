import { and, count, isNull, lte, or } from "drizzle-orm";

import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { refreshSessions } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { isDirectExecution, runScript } from "./lib/cli.js";

/**
 * Purge refresh sessions that can no longer be used.
 *
 * `env.SESSION_RETENTION_DAYS` is validated and documented but previously had no
 * consumer, which made it a misleading knob. This is that consumer.
 *
 * Only rows that are provably dead are removed: revoked, or expired, and in either
 * case older than the retention window. A session that expired two minutes ago is
 * kept, so a support investigation immediately after an incident still sees it.
 *
 * `audit_logs` is intentionally never trimmed here. It is the security record, and
 * a retention policy for it is a decision that needs a data-retention owner, not a
 * cron line.
 *
 * Usage:
 *   pnpm cleanup:sessions            # report what would go
 *   pnpm cleanup:sessions -- --apply # actually delete
 */

function cutoff(): Date {
  return new Date(Date.now() - env.SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Dead and past retention: revoked, or expired, and quiet for the whole window. */
function eligible(cut: Date) {
  return and(
    or(isNull(refreshSessions.revokedAt), lte(refreshSessions.revokedAt, cut)),
    lte(refreshSessions.expiresAt, cut),
  );
}

/** Outcome of a run, so the CLI can report it and a test can assert on it. */
export interface CleanupResult {
  apply: boolean;
  eligible: number;
  removed: number;
  retentionDays: number;
  cutoff: Date;
}

/**
 * Delete (or, by default, merely count) provably dead sessions.
 *
 * Dry-run is the default and `apply` must be asked for explicitly, because this is
 * one of the few code paths in the project that removes rows.
 */
export async function cleanupSessions(options: { apply?: boolean } = {}): Promise<CleanupResult> {
  const apply = options.apply ?? false;
  const cut = cutoff();

  const [pending] = await db
    .select({ total: count() })
    .from(refreshSessions)
    .where(eligible(cut));

  const eligibleTotal = Number(pending?.total ?? 0);

  if (!apply || eligibleTotal === 0) {
    return {
      apply,
      eligible: eligibleTotal,
      removed: 0,
      retentionDays: env.SESSION_RETENTION_DAYS,
      cutoff: cut,
    };
  }

  const deleted = await db
    .delete(refreshSessions)
    .where(eligible(cut))
    .returning({ id: refreshSessions.id });

  return {
    apply,
    eligible: eligibleTotal,
    removed: deleted.length,
    retentionDays: env.SESSION_RETENTION_DAYS,
    cutoff: cut,
  };
}

async function main(): Promise<void> {
  const result = await cleanupSessions({ apply: process.argv.includes("--apply") });

  if (!result.apply) {
    logger.info("cleanup-sessions: dry run", {
      wouldDelete: result.eligible,
      retentionDays: result.retentionDays,
      cutoff: result.cutoff.toISOString(),
    });

    return;
  }

  logger.info("cleanup-sessions: removed expired sessions", {
    removed: result.removed,
    retentionDays: result.retentionDays,
  });

  // `removed` is authoritative even if the eligible count moved between the scan
  // and the delete; a mismatch is worth recording because it means concurrent writes.
  if (result.removed !== result.eligible) {
    logger.warn("cleanup-sessions: count changed between scan and delete", {
      counted: result.eligible,
      removed: result.removed,
    });
  }
}

if (isDirectExecution(import.meta.url)) {
  await runScript("cleanup-sessions", main);
}
