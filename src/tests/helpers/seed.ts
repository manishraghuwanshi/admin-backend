import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { adminUsers, auditLogs, refreshSessions } from "../../db/schema.js";
import type { AdminRole } from "../../db/schema.js";
import { hashPassword } from "../../lib/auth/password.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from "../../lib/auth/tokens.js";

/**
 * Data factories for tests.
 *
 * These use the application's own `db` singleton, which `createTestDatabase()`
 * has already pointed at the in-memory PGlite instance, so seeds and the code
 * under test always observe the same connection.
 */

export interface SeedAdmin {
  email: string;
  password: string;
  name: string;
  role: AdminRole;
  isActive?: boolean;
}

export const DEFAULT_ADMIN_PASSWORD = "SuperSecret123";

export const testAdmin = {
  owner: {
    email: "owner@example.test",
    password: DEFAULT_ADMIN_PASSWORD,
    name: "Test Owner",
    role: "owner" as const,
  } satisfies SeedAdmin,
  manager: {
    email: "manager@example.test",
    password: DEFAULT_ADMIN_PASSWORD,
    name: "Test Manager",
    role: "manager" as const,
  } satisfies SeedAdmin,
  editor: {
    email: "editor@example.test",
    password: DEFAULT_ADMIN_PASSWORD,
    name: "Test Editor",
    role: "editor" as const,
  } satisfies SeedAdmin,
};

/** Creates an admin user with a real Argon2 hash and returns the stored row. */
export async function seedAdmin(
  overrides: Partial<SeedAdmin> & { email: string },
): Promise<typeof adminUsers.$inferSelect> {
  const { email, password, name, role, isActive } = {
    password: DEFAULT_ADMIN_PASSWORD,
    name: "Test Admin",
    role: "editor" as AdminRole,
    isActive: true,
    ...overrides,
  };

  const [created] = await db
    .insert(adminUsers)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      name,
      role,
      isActive,
    })
    .returning();

  return created;
}

/** Convenience: seeds one admin per role, all sharing `DEFAULT_ADMIN_PASSWORD`. */
export async function seedAdminsPerRole(): Promise<Record<AdminRole, typeof adminUsers.$inferSelect>> {
  const [owner, manager, editor] = await Promise.all([
    seedAdmin(testAdmin.owner),
    seedAdmin(testAdmin.manager),
    seedAdmin(testAdmin.editor),
  ]);

  return { owner, manager, editor };
}

export interface SeededSession {
  session: typeof refreshSessions.$inferSelect;
  /** The cleartext refresh token; only the SHA-256 hash is stored. */
  refreshToken: string;
}

/**
 * Creates a refresh session directly (without going through login), which lets a
 * test control expiry and revocation - the states that are otherwise hard to
 * reach because login always issues a fresh, valid session.
 */
export async function seedRefreshSession(
  adminUserId: string,
  options: {
    expiresAt?: Date;
    revokedAt?: Date;
    ipAddress?: string;
    userAgent?: string;
  } = {},
): Promise<SeededSession> {
  const refreshToken = generateRefreshToken();

  const [session] = await db
    .insert(refreshSessions)
    .values({
      adminUserId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: options.expiresAt ?? refreshTokenExpiresAt(),
      revokedAt: options.revokedAt ?? null,
      ipAddress: options.ipAddress ?? "127.0.0.1",
      userAgent: options.userAgent ?? "vitest",
    })
    .returning();

  return { session, refreshToken };
}

/** Reads every audit row for an action, newest first. */
export async function findAuditRows(action: string) {
  const rows = await db.select().from(auditLogs);

  return rows
    .filter((row) => row.action === action)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Hard-deletes an admin; used to prove cascade behaviour where relevant. */
export async function deleteAdmin(id: string): Promise<void> {
  await db.delete(adminUsers).where(eq(adminUsers.id, id));
}
