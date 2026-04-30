import { and, eq, isNull } from "drizzle-orm";
import type { RequestHandler } from "express";

import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { adminUsers, refreshSessions } from "../db/schema.js";
import { verifyAccessToken } from "../lib/auth/tokens.js";
import type { AuthUser } from "../types/auth.js";
import { unauthorized } from "../utils/errors.js";

export type { AuthUser };

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.cookies?.[env.AUTH_COOKIE_NAME_ACCESS];

    if (!token || typeof token !== "string") {
      throw unauthorized();
    }

    let payload;

    try {
      payload = await verifyAccessToken(token);
    } catch {
      throw unauthorized("Invalid or expired session");
    }

    const [session] = await db
      .select({
        id: refreshSessions.id,
        revokedAt: refreshSessions.revokedAt,
        expiresAt: refreshSessions.expiresAt,
        adminUserId: refreshSessions.adminUserId,
      })
      .from(refreshSessions)
      .where(and(eq(refreshSessions.id, payload.sid), isNull(refreshSessions.revokedAt)))
      .limit(1);

    if (!session || session.expiresAt.getTime() <= Date.now() || session.adminUserId !== payload.sub) {
      throw unauthorized("Invalid or expired session");
    }

    const [user] = await db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        name: adminUsers.name,
        role: adminUsers.role,
        isActive: adminUsers.isActive,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, payload.sub))
      .limit(1);

    if (!user || !user.isActive) {
      throw unauthorized("Invalid or expired session");
    }

    req.authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      sessionId: session.id,
    };

    next();
  } catch (error) {
    next(error);
  }
};
