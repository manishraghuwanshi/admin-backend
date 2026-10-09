import { and, eq, isNull, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { adminUsers, refreshSessions } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { clearAuthCookies, setAuthCookies } from "../../lib/auth/cookies.js";
import {
  evaluateLoginThrottle,
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILED_ATTEMPTS,
} from "../../lib/auth/login-throttle.js";
import { verifyPassword } from "../../lib/auth/password.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  signAccessToken,
} from "../../lib/auth/tokens.js";
import { permissionsFor } from "../../lib/auth/permissions.js";
import { env } from "../../config/env.js";
import { tooManyRequests, unauthorized } from "../../utils/errors.js";

export const loginBodySchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

const GENERIC_AUTH_FAILURE = "Invalid email or password";

/**
 * The client-facing message for both bot controls. Deliberately identical and
 * non-enumerating, so it cannot be used to tell a locked account from a
 * merely rate-limited one - or from one that does not exist at all.
 */
const GENERIC_THROTTLE_MESSAGE = "Too many login attempts. Try again later.";

/**
 * Refuse a throttled attempt.
 *
 * Audits before throwing because the response deliberately carries no
 * account-specific detail, so the audit row is the only durable record of which
 * account was targeted and why. The `Retry-After` header is what lets a frontend
 * wait exactly as long as needed instead of guessing.
 */
async function rejectThrottledLogin(
  res: Response,
  req: Request,
  decision: { reason: "locked" | "rate_limited"; retryAfterSeconds: number },
  adminUserId: string,
): Promise<never> {
  res.set("Retry-After", String(decision.retryAfterSeconds));

  await recordAudit({
    actorId: adminUserId,
    action: "auth.login_failed",
    entityType: "admin_user",
    entityId: adminUserId,
    metadata: { reason: decision.reason, retryAfterSeconds: decision.retryAfterSeconds },
    req,
  });

  throw tooManyRequests(GENERIC_THROTTLE_MESSAGE);
}

function publicAdmin(user: {
  id: string;
  email: string;
  name: string;
  role: "owner" | "manager" | "editor";
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    // Derived server-side from the authoritative table, so the frontend never has
    // to duplicate the role matrix to decide what to render. It is informational
    // only: `requirePermission()` re-derives it per request.
    permissions: permissionsFor(user.role),
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function issueSession(
  user: typeof adminUsers.$inferSelect,
  req: Request,
  res: Response,
): Promise<void> {
  const refreshToken = generateRefreshToken();
  const [session] = await db
    .insert(refreshSessions)
    .values({
      adminUserId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshTokenExpiresAt(),
      ipAddress: req.ip?.slice(0, 64) ?? null,
      userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
    })
    .returning();

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    sid: session.id,
  });

  setAuthCookies(res, { accessToken, refreshToken });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.validatedBody as z.infer<typeof loginBodySchema>;
  const normalizedEmail = email.toLowerCase();

  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, normalizedEmail))
    .limit(1);

  if (!user || !user.isActive) {
    await recordAudit({
      action: "auth.login_failed",
      entityType: "admin_user",
      entityId: user?.id ?? null,
      metadata: { reason: user && !user.isActive ? "disabled" : "unknown_user" },
      req,
    });
    throw unauthorized(GENERIC_AUTH_FAILURE);
  }

  // Throttle before verifying the password: a locked or too-soon attempt must not
  // pay for an Argon2 hash, and the check must not depend on the password being
  // correct. Inactive and unknown accounts have no stored state to consult, so
  // they pass through and fail on the same generic message as before.
  const throttle = evaluateLoginThrottle({
    failedLoginAttempts: user.failedLoginAttempts,
    lastFailedLoginAt: user.lastFailedLoginAt,
    lockedUntil: user.lockedUntil,
  });

  if (!throttle.allowed) {
    await rejectThrottledLogin(res, req, throttle, user.id);
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    // One statement, no read-then-write: the new counter and lock deadline are
    // computed by PostgreSQL from the stored row, so two simultaneous failures
    // both register instead of overwriting each other with a stale value. Nothing
    // here is derived from the password, so the statement needs no parameters.
    const reachedThreshold = sql`${adminUsers.failedLoginAttempts} + 1 >= ${LOGIN_MAX_FAILED_ATTEMPTS}`;

    const [failed] = await db
      .update(adminUsers)
      .set({
        failedLoginAttempts: sql`case when ${reachedThreshold} then 0 else ${adminUsers.failedLoginAttempts} + 1 end`,
        lastFailedLoginAt: new Date(),
        lockedUntil: sql`case when ${reachedThreshold} then now() + interval '${sql.raw(String(LOGIN_LOCKOUT_MS))} milliseconds' else ${adminUsers.lockedUntil} end`,
        updatedAt: new Date(),
      })
      .where(eq(adminUsers.id, user.id))
      .returning({ failedLoginAttempts: adminUsers.failedLoginAttempts });

    await recordAudit({
      actorId: user.id,
      action: "auth.login_failed",
      entityType: "admin_user",
      entityId: user.id,
      metadata: {
        reason: "bad_password",
        // 0 here means this failure tripped the lock, since the counter restarts at
        // one only on the next failure after the lockout expires.
        failedLoginAttempts: failed?.failedLoginAttempts ?? 0,
      },
      req,
    });
    throw unauthorized(GENERIC_AUTH_FAILURE);
  }

  // A correct password clears the throttle state in the same statement that stamps
  // `lastLoginAt`, so a successful login never leaves a "one more failure locks it"
  // counter behind.
  const [updated] = await db
    .update(adminUsers)
    .set({
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(adminUsers.id, user.id))
    .returning();

  await issueSession(updated, req, res);

  await recordAudit({
    actorId: updated.id,
    action: "auth.login",
    entityType: "admin_user",
    entityId: updated.id,
    req,
  });

  res.json({
    success: true,
    data: publicAdmin(updated),
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[env.AUTH_COOKIE_NAME_REFRESH];

  if (!token || typeof token !== "string") {
    throw unauthorized("Invalid or expired session");
  }

  const tokenHash = hashRefreshToken(token);
  const now = new Date();

  const [session] = await db
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1);

  if (!session) {
    throw unauthorized("Invalid or expired session");
  }

  if (session.revokedAt) {
    await db
      .update(refreshSessions)
      .set({ revokedAt: now })
      .where(and(eq(refreshSessions.adminUserId, session.adminUserId), isNull(refreshSessions.revokedAt)));

    clearAuthCookies(res);
    throw unauthorized("Invalid or expired session");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await db
      .update(refreshSessions)
      .set({ revokedAt: now })
      .where(eq(refreshSessions.id, session.id));
    clearAuthCookies(res);
    throw unauthorized("Invalid or expired session");
  }

  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, session.adminUserId))
    .limit(1);

  if (!user || !user.isActive) {
    await db
      .update(refreshSessions)
      .set({ revokedAt: now })
      .where(eq(refreshSessions.id, session.id));
    clearAuthCookies(res);
    throw unauthorized("Invalid or expired session");
  }

  await db
    .update(refreshSessions)
    .set({ revokedAt: now })
    .where(eq(refreshSessions.id, session.id));

  await issueSession(user, req, res);

  res.json({
    success: true,
    data: publicAdmin(user),
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const refreshToken = req.cookies?.[env.AUTH_COOKIE_NAME_REFRESH];
  const now = new Date();

  if (refreshToken && typeof refreshToken === "string") {
    const tokenHash = hashRefreshToken(refreshToken);

    await db
      .update(refreshSessions)
      .set({ revokedAt: now })
      .where(and(eq(refreshSessions.tokenHash, tokenHash), isNull(refreshSessions.revokedAt)));
  }

  if (req.authUser) {
    await db
      .update(refreshSessions)
      .set({ revokedAt: now })
      .where(and(eq(refreshSessions.id, req.authUser.sessionId), isNull(refreshSessions.revokedAt)));

    await recordAudit({
      actorId: req.authUser.id,
      action: "auth.logout",
      entityType: "admin_user",
      entityId: req.authUser.id,
      req,
    });
  }

  clearAuthCookies(res);

  res.json({
    success: true,
    data: { loggedOut: true },
  });
}

export async function me(req: Request, res: Response): Promise<void> {
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, req.authUser!.id))
    .limit(1);

  if (!user) {
    throw unauthorized();
  }

  res.json({
    success: true,
    data: publicAdmin(user),
  });
}
