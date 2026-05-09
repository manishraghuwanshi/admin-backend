import { and, eq, isNull } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { adminUsers, refreshSessions } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { clearAuthCookies, setAuthCookies } from "../../lib/auth/cookies.js";
import { verifyPassword } from "../../lib/auth/password.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  signAccessToken,
} from "../../lib/auth/tokens.js";
import { permissionsFor } from "../../lib/auth/permissions.js";
import { env } from "../../config/env.js";
import { unauthorized } from "../../utils/errors.js";

export const loginBodySchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

const GENERIC_AUTH_FAILURE = "Invalid email or password";

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

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    await recordAudit({
      actorId: user.id,
      action: "auth.login_failed",
      entityType: "admin_user",
      entityId: user.id,
      metadata: { reason: "bad_password" },
      req,
    });
    throw unauthorized(GENERIC_AUTH_FAILURE);
  }

  const [updated] = await db
    .update(adminUsers)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
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
