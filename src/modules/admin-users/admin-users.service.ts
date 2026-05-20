import { and, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db, type DbTransaction } from "../../db/index.js";
import { adminUsers, auditLogs, refreshSessions } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { assertPasswordStrength, hashPassword } from "../../lib/auth/password.js";
import { conflict, notFound, unprocessable } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import {
  paginationMeta,
  paginationOffset,
  paginationQuerySchema,
} from "../../utils/pagination.js";
import { requireRow, validatedId } from "../../utils/params.js";
import { optionalBooleanQuery } from "../../utils/schemas.js";

/**
 * Administrator management.
 *
 * Three invariants are enforced here rather than in the schema, because they are
 * rules about *sets* of rows that a single-row constraint cannot express:
 *
 * 1. At least one active owner must always exist. Without that guard, the last
 *    owner could deactivate themselves and nobody would ever reach
 *    `adminUsers.manage` again.
 * 2. An administrator can never cut their own path to the console: no
 *    self-deactivation, no self-demotion, no self-deletion.
 * 3. `passwordHash` is never selected, so it can never leak into a response.
 *
 * Mutations that make a live session observably wrong (role change,
 * deactivation, email change, password change, deletion) revoke that
 * administrator's refresh sessions, forcing a re-login that mints a token whose
 * `role` claim matches the database again.
 */

export const adminUserListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  role: z.enum(["owner", "manager", "editor"]).optional(),
  isActive: optionalBooleanQuery,
  sort: z.enum(["createdAt", "name", "email", "lastLoginAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const passwordSchema = z.string().min(1).max(200);

export const adminUserCreateSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().min(1).max(120),
  role: z.enum(["owner", "manager", "editor"]),
  password: passwordSchema,
  isActive: z.boolean().optional(),
});

export const adminUserUpdateSchema = z
  .object({
    email: z.string().trim().email().max(255).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(["owner", "manager", "editor"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const adminUserPasswordSchema = z.object({
  password: passwordSchema,
});

/** The admin columns that leave this module; never includes `passwordHash`. */
const publicColumns = {
  id: adminUsers.id,
  email: adminUsers.email,
  name: adminUsers.name,
  role: adminUsers.role,
  isActive: adminUsers.isActive,
  lastLoginAt: adminUsers.lastLoginAt,
  createdAt: adminUsers.createdAt,
  updatedAt: adminUsers.updatedAt,
};

/** Validate strength before hashing, so weak candidates never reach Argon2. */
function assertUsablePassword(password: string): void {
  const weakness = assertPasswordStrength(password);

  if (weakness) {
    throw unprocessable(weakness, { path: ["password"] });
  }
}

async function findAdmin(id: string) {
  const [row] = await db
    .select(publicColumns)
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .limit(1);

  return row;
}

/** Load a row or throw 404, without exposing `passwordHash`. */
async function loadPublicAdmin(id: string) {
  return requireRow(id, findAdmin, () => notFound("Admin user not found"));
}

/**
 * Count the active owners, optionally ignoring one row that is the subject of a
 * pending mutation. Called with the mutation's transaction so the check and the
 * write observe the same snapshot.
 */
async function countActiveOwners(run: DbTransaction, excludingId?: string): Promise<number> {
  const filters: SQL[] = [eq(adminUsers.role, "owner"), eq(adminUsers.isActive, true)];

  if (excludingId) {
    filters.push(sql`${adminUsers.id} <> ${excludingId}`);
  }

  const [row] = await run
    .select({ total: count() })
    .from(adminUsers)
    .where(and(...filters));

  return Number(row?.total ?? 0);
}

/**
 * Refuse to take the last active owner out of the owner pool.
 *
 * `losesOwnerStatus` is supplied by the caller because it depends on the pending
 * mutation, not on the stored row: a rename of the only owner must succeed, while
 * deleting, deactivating, or demoting them must not. The subject is fetched
 * pre-mutation, so an already-inactive admin is a no-op for the invariant.
 */
async function assertNotLastActiveOwner(
  run: DbTransaction,
  target: typeof adminUsers.$inferSelect,
  losesOwnerStatus: boolean,
): Promise<void> {
  if (!losesOwnerStatus || target.role !== "owner" || !target.isActive) {
    return;
  }

  if ((await countActiveOwners(run, target.id)) === 0) {
    throw conflict("The last active owner cannot be deleted, deactivated, or demoted");
  }
}

/** Revoke every unrevoked session of one administrator; returns how many. */
async function revokeSessions(run: DbTransaction, adminUserId: string): Promise<number> {
  const revoked = await run
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshSessions.adminUserId, adminUserId),
        isNull(refreshSessions.revokedAt),
      ),
    )
    .returning({ id: refreshSessions.id });

  return revoked.length;
}

function listFilters(query: z.infer<typeof adminUserListQuerySchema>): SQL | undefined {
  const filters: SQL[] = [];

  if (query.search) {
    const term = `%${query.search}%`;

    filters.push(or(ilike(adminUsers.name, term), ilike(adminUsers.email, term))!);
  }

  if (query.role) {
    filters.push(eq(adminUsers.role, query.role));
  }

  if (query.isActive !== undefined) {
    filters.push(eq(adminUsers.isActive, query.isActive));
  }

  return filters.length === 0 ? undefined : and(...filters);
}

export async function listAdminUsers(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof adminUserListQuerySchema>;
  const where = listFilters(query);

  const sortColumn = {
    createdAt: adminUsers.createdAt,
    name: adminUsers.name,
    email: adminUsers.email,
    lastLoginAt: adminUsers.lastLoginAt,
  }[query.sort];

  const orderBy = query.order === "asc" ? sortColumn : desc(sortColumn);

  const [totalRow] = await db.select({ total: count() }).from(adminUsers).where(where);

  const rows = await db
    .select({
      ...publicColumns,
      // Correlated subquery instead of a join, so the pagination total stays the
      // number of administrators rather than the number of admin x session pairs.
      //
      // The outer column must be qualified. Postgres resolves an unqualified name
      // in the innermost scope, so writing `${adminUsers.id}` (which Drizzle emits
      // as bare `"id"`) binds to `refresh_sessions.id` inside the subquery - the
      // predicate becomes "this session's id = this session's id" and the count is
      // always 0.
      activeSessionCount: sql<number>`(
        select count(*) from ${refreshSessions}
        where ${refreshSessions.adminUserId} = ${sql.identifier("admin_users")}.${sql.identifier("id")}
          and ${refreshSessions.revokedAt} is null
      )`.mapWith(Number),
    })
    .from(adminUsers)
    .where(where)
    .orderBy(orderBy)
    .limit(query.limit)
    .offset(paginationOffset(query.page, query.limit));

  sendPaginated(
    res,
    rows,
    paginationMeta(query.page, query.limit, Number(totalRow?.total ?? 0)),
  );
}

export async function getAdminUser(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await loadPublicAdmin(validatedId(req)));
}

export async function createAdminUser(req: Request, res: Response): Promise<void> {
  const body = req.validatedBody as z.infer<typeof adminUserCreateSchema>;

  assertUsablePassword(body.password);

  // Hash before touching the database: Argon2 is deliberately slow, and holding a
  // write transaction open for it would serialise unrelated admin writes.
  const passwordHash = await hashPassword(body.password);
  const email = body.email.toLowerCase();

  const [clash] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  if (clash) {
    throw conflict("An admin user with that email already exists");
  }

  const [created] = await db
    .insert(adminUsers)
    .values({
      email,
      name: body.name,
      role: body.role,
      passwordHash,
      isActive: body.isActive ?? true,
    })
    .returning(publicColumns);

  await recordAudit({
    actorId: req.authUser?.id,
    action: "admin_user.create",
    entityType: "admin_user",
    entityId: created.id,
    metadata: { email: created.email, role: created.role },
    req,
  });

  sendSuccess(res, created, 201);
}

export async function updateAdminUser(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);
  const body = req.validatedBody as z.infer<typeof adminUserUpdateSchema>;
  const actorId = req.authUser!.id;

  // Self-lockout guards. `role` may only ever be set to a value; the enum has no
  // second owner-like role, so any change away from "owner" is a demotion.
  if (id === actorId && body.isActive === false) {
    throw unprocessable("You cannot deactivate your own account");
  }

  if (id === actorId && body.role && body.role !== "owner") {
    throw unprocessable("You cannot remove your own owner role");
  }

  const email = body.email?.toLowerCase();

  const result = await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1)
      .for("update");

    if (!target) {
      throw notFound("Admin user not found");
    }

    if (email) {
      const [clash] = await tx
        .select({ id: adminUsers.id })
        .from(adminUsers)
        .where(and(eq(adminUsers.email, email), sql`${adminUsers.id} <> ${id}`))
        .limit(1);

      if (clash) {
        throw conflict("An admin user with that email already exists");
      }
    }

    // Only a change that would strip owner status can breach the invariant.
    const losesOwnerStatus =
      body.isActive === false || (body.role !== undefined && body.role !== "owner");

    await assertNotLastActiveOwner(tx, target, losesOwnerStatus);

    const [updated] = await tx
      .update(adminUsers)
      .set({
        ...(email !== undefined ? { email } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(adminUsers.id, id))
      .returning(publicColumns);

    // Anything except a pure rename invalidates claims baked into live tokens.
    let revokedSessionCount = 0;

    if (body.role !== undefined || body.isActive === false || email !== undefined) {
      revokedSessionCount = await revokeSessions(tx, id);
    }

    return { updated, revokedSessionCount };
  });

  // Audited after commit, matching the products service convention, so a rolled
  // back mutation never leaves a phantom audit trail.
  await recordAudit({
    actorId,
    action: "admin_user.update",
    entityType: "admin_user",
    entityId: id,
    metadata: {
      fields: Object.keys(body),
      revokedSessionCount: result.revokedSessionCount,
    },
    req,
  });

  sendSuccess(res, result.updated);
}

export async function setAdminUserPassword(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);
  const { password } = req.validatedBody as z.infer<typeof adminUserPasswordSchema>;

  assertUsablePassword(password);

  const passwordHash = await hashPassword(password);

  const revokedSessionCount = await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1)
      .for("update");

    if (!target) {
      throw notFound("Admin user not found");
    }

    await tx
      .update(adminUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(adminUsers.id, id));

    // A password change is the canonical "someone else had this account" event,
    // so every session goes - including the caller's own if they rotate their own
    // password. The response is still delivered, then the next request 401s.
    return revokeSessions(tx, id);
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "admin_user.password_reset",
    entityType: "admin_user",
    entityId: id,
    metadata: { revokedSessionCount },
    req,
  });

  sendSuccess(res, { passwordUpdated: true, revokedSessionCount });
}

export async function deleteAdminUser(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);
  const actorId = req.authUser!.id;

  if (id === actorId) {
    throw unprocessable("You cannot delete your own account");
  }

  const deleted = await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1)
      .for("update");

    if (!target) {
      throw notFound("Admin user not found");
    }

    await assertNotLastActiveOwner(tx, target, true);

    // Sessions would cascade anyway; deleting explicitly keeps the intent visible
    // and makes the row count auditable. Audit history survives through
    // `audit_logs.actor_id` ON DELETE SET NULL.
    const revokedSessionCount = await revokeSessions(tx, id);

    await tx.delete(adminUsers).where(eq(adminUsers.id, id));

    return { email: target.email, role: target.role, revokedSessionCount };
  });

  await recordAudit({
    actorId,
    action: "admin_user.delete",
    entityType: "admin_user",
    entityId: id,
    metadata: { email: deleted.email, role: deleted.role },
    req,
  });

  sendSuccess(res, { deleted: true });
}

export async function listAdminUserSessions(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);

  await loadPublicAdmin(id);

  const rows = await db
    .select({
      id: refreshSessions.id,
      createdAt: refreshSessions.createdAt,
      expiresAt: refreshSessions.expiresAt,
      revokedAt: refreshSessions.revokedAt,
      ipAddress: refreshSessions.ipAddress,
      userAgent: refreshSessions.userAgent,
    })
    .from(refreshSessions)
    .where(eq(refreshSessions.adminUserId, id))
    .orderBy(desc(refreshSessions.createdAt))
    // Deliberately unpaginated: this backs a "sign out everywhere" screen, and the
    // cap keeps the response bounded without a second round trip.
    .limit(100);

  sendSuccess(res, rows);
}

export async function revokeAdminUserSessions(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);

  const revokedSessionCount = await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1)
      .for("update");

    if (!target) {
      throw notFound("Admin user not found");
    }

    return revokeSessions(tx, id);
  });

  await recordAudit({
    actorId: req.authUser?.id,
    action: "admin_user.sessions_revoked",
    entityType: "admin_user",
    entityId: id,
    metadata: { revokedSessionCount },
    req,
  });

  sendSuccess(res, { revokedSessionCount });
}

/** The 100 most recent actions an administrator performed, newest first. */
export async function listAdminUserAuditLogs(req: Request, res: Response): Promise<void> {
  const id = validatedId(req);

  await loadPublicAdmin(id);

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(eq(auditLogs.actorId, id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  sendSuccess(res, rows);
}

