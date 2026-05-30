import { count, eq } from "drizzle-orm";

import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { adminUsers, auditLogs } from "../db/schema.js";
import { assertPasswordStrength, hashPassword } from "../lib/auth/password.js";
import { logger } from "../utils/logger.js";
import { isDirectExecution, requiredEnv, runScript } from "./lib/cli.js";

/**
 * Create the first administrator (an `owner`).
 *
 * This is the only sanctioned way to get the initial account, because every
 * administrative endpoint is behind `adminUsers.manage`: with zero rows in
 * `admin_users`, nobody can create the first one over HTTP.
 *
 * Rules:
 * - Credentials come from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`, so
 *   a password never lands in shell history or in the process listing (`ps`),
 *   where argv would be visible to every user on the host.
 * - The script is a no-op once any administrator exists. It cannot be used to mint
 *   extra owners or to reset a forgotten password, which keeps it safe to leave
 *   wired up in a deployed image.
 * - Nothing it logs identifies a credential: the email is reported only in a
 *   masked form, and the password is never read into a log payload.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.com BOOTSTRAP_ADMIN_PASSWORD='...' \
 *     pnpm bootstrap:owner
 */

/**
 * Mask an email for log output: `you@example.com` -> `yo*@example.com`.
 *
 * The full address is never needed to confirm which account was created, and a
 * log line is the sort of thing that ends up in a aggregated log service.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");

  if (!local || !domain) {
    return "***";
  }

  const visible = local.slice(0, 2);

  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
}

/** What the run did, so a caller can report it and a test can assert on it. */
export interface BootstrapResult {
  status: "created" | "already-seeded";
  id?: string;
  role?: string;
  maskedEmail?: string;
}

export async function bootstrapOwner(): Promise<BootstrapResult> {
  const email = requiredEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const password = requiredEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Platform Owner";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL is not a valid email address");
  }

  const weakness = assertPasswordStrength(password);

  if (weakness) {
    // The reason is safe to print; the value never is.
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD is not acceptable: ${weakness}`);
  }

  const [existing] = await db.select({ total: count() }).from(adminUsers);

  if (Number(existing?.total ?? 0) > 0) {
    return { status: "already-seeded" };
  }

  const passwordHash = await hashPassword(password);

  const [created] = await db
    .insert(adminUsers)
    .values({
      email,
      name,
      role: "owner",
      passwordHash,
      isActive: true,
    })
    .returning({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role });

  // Recorded with no actor: this event has no authenticated caller, which is the
  // accurate record rather than a fabricated self-reference.
  await db.insert(auditLogs).values({
    actorId: null,
    action: "admin_user.bootstrap",
    entityType: "admin_user",
    entityId: created.id,
    metadata: { role: created.role, source: "bootstrap-script" },
  });

  // Belt and braces: confirm the account can actually be read back before the
  // operator walks away from a "successful" run.
  const [verify] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, created.id))
    .limit(1);

  if (!verify) {
    throw new Error("bootstrap: created owner could not be read back");
  }

  return {
    status: "created",
    id: created.id,
    role: created.role,
    maskedEmail: maskEmail(created.email),
  };
}

async function main(): Promise<void> {
  const result = await bootstrapOwner();

  if (result.status === "already-seeded") {
    logger.info("bootstrap: administrators already exist, nothing to do", {
      database: env.IS_PRODUCTION ? "production" : env.NODE_ENV,
    });

    return;
  }

  logger.info("bootstrap: first owner created", {
    id: result.id,
    email: result.maskedEmail,
    role: result.role,
  });
}

if (isDirectExecution(import.meta.url)) {
  await runScript("bootstrap-owner", main);
}

