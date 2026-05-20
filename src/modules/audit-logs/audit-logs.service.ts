import { and, count, desc, eq, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { adminUsers, auditLogs } from "../../db/schema.js";
import { hasPermission } from "../../lib/auth/permissions.js";
import { forbidden } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import {
  paginationMeta,
  paginationOffset,
  paginationQuerySchema,
} from "../../utils/pagination.js";

/**
 * Audit-log reading.
 *
 * Two permissions cover this one collection, and the difference is enforced here
 * rather than by exposing two endpoints:
 *
 * - `auditLogs.read` (owner): any actor's activity.
 * - `auditLogs.readLimited` (owner, manager): activity restricted to the caller's
 *   own rows.
 *
 * The scoping is applied to the SQL `WHERE` clause, not to the result set, so a
 * manager cannot page or filter their way to someone else's rows, and
 * `pagination.total` reports the total they are actually allowed to see.
 *
 * Metadata is already redacted at write time by `recordAudit`, so nothing further
 * needs stripping here.
 */

export const auditLogListQuerySchema = paginationQuerySchema
  .extend({
    /** Exact action, or use `*` as a wildcard within the dotted namespace. */
    action: z.string().trim().max(80).optional(),
    entityType: z.string().trim().max(80).optional(),
    entityId: z.uuid().optional(),
    actorId: z.uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    sort: z.enum(["createdAt", "action"]).default("createdAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine((value) => !value.from || !value.to || value.from.getTime() <= value.to.getTime(), {
    message: "from must be before to",
    path: ["from"],
  });

export const entityAuditParamsSchema = z.object({
  entityType: z.string().trim().min(1).max(80),
  entityId: z.uuid(),
});

const auditView = {
  id: auditLogs.id,
  actorId: auditLogs.actorId,
  actorEmail: adminUsers.email,
  actorName: adminUsers.name,
  action: auditLogs.action,
  entityType: auditLogs.entityType,
  entityId: auditLogs.entityId,
  metadata: auditLogs.metadata,
  ipAddress: auditLogs.ipAddress,
  userAgent: auditLogs.userAgent,
  createdAt: auditLogs.createdAt,
};

/**
 * Resolve the caller's effective scope.
 *
 * `requirePermission` takes an "all of" list and cannot express "full access OR
 * self-only", so that branch lives here. A caller holding neither permission is
 * rejected explicitly instead of being handed an empty page, because an empty
 * result would read as "no activity" rather than "not allowed".
 */
function resolveScope(req: Request): string | null {
  const role = req.authUser!.role;

  if (hasPermission(role, "auditLogs.read")) {
    return null;
  }

  if (hasPermission(role, "auditLogs.readLimited")) {
    return req.authUser!.id;
  }

  throw forbidden();
}

/**
 * Build the row filter.
 *
 * When the caller is self-scoped, the scope predicate is always added, and an
 * `actorId` naming someone else simply ANDs to an unsatisfiable pair. That is
 * deliberately not special-cased into an error: it keeps the response shape
 * identical to "no matches" and leaks nothing about who else has activity.
 */
function listFilters(
  query: z.infer<typeof auditLogListQuerySchema>,
  restrictedToActorId: string | null,
): SQL | undefined {
  const filters: SQL[] = [];

  if (restrictedToActorId) {
    filters.push(eq(auditLogs.actorId, restrictedToActorId));
  }

  if (query.action) {
    filters.push(
      query.action.includes("*")
        ? ilike(auditLogs.action, query.action.replace(/\*/g, "%"))
        : eq(auditLogs.action, query.action),
    );
  }

  if (query.entityType) {
    filters.push(eq(auditLogs.entityType, query.entityType));
  }

  if (query.entityId) {
    filters.push(eq(auditLogs.entityId, query.entityId));
  }

  if (query.actorId) {
    filters.push(eq(auditLogs.actorId, query.actorId));
  }

  if (query.from) {
    filters.push(gte(auditLogs.createdAt, query.from));
  }

  if (query.to) {
    filters.push(lte(auditLogs.createdAt, query.to));
  }

  return filters.length === 0 ? undefined : and(...filters);
}

/**
 * `LEFT JOIN` rather than `INNER JOIN`: `audit_logs.actor_id` is nullable with
 * `ON DELETE SET NULL`, so activity by a since-deleted administrator, and the
 * anonymous failed-login events, must still appear - with a null actor name.
 */
export async function listAuditLogs(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof auditLogListQuerySchema>;
  const where = listFilters(query, resolveScope(req));

  const sortColumn = {
    createdAt: auditLogs.createdAt,
    action: auditLogs.action,
  }[query.sort];

  // `sortColumn` is `sortColumn ASC NULLS LAST`-style SQL because Drizzle's `asc`
  // helper does not take a nulls modifier; the explicit fragment keeps the intent
  // readable and the ordering stable for rows with a null actor.
  const orderBy =
    query.order === "asc"
      ? sql`${sortColumn} ASC NULLS LAST`
      : sql`${sortColumn} DESC NULLS LAST`;

  const [totalRow] = await db
    .select({ total: count() })
    .from(auditLogs)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.actorId))
    .where(where);

  const rows = await db
    .select(auditView)
    .from(auditLogs)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.actorId))
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

/**
 * The distinct recorded actions, for a filter control in the frontend.
 *
 * Capped rather than paginated: the vocabulary only grows when code changes, so a
 * short list is the expected shape.
 */
export async function listAuditActions(req: Request, res: Response): Promise<void> {
  const restrictedToActorId = resolveScope(req);

  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(restrictedToActorId ? eq(auditLogs.actorId, restrictedToActorId) : undefined)
    .groupBy(auditLogs.action)
    .orderBy(auditLogs.action)
    .limit(200);

  sendSuccess(res, rows.map((row) => row.action));
}

/**
 * Every audit row for one entity, newest first.
 *
 * This is the "what happened to this product?" query the catalog screens need, and
 * it saves the frontend from knowing the action vocabulary.
 */
export async function listEntityAuditLogs(req: Request, res: Response): Promise<void> {
  const restrictedToActorId = resolveScope(req);
  const params = req.validatedParams as { entityType: string; entityId: string };

  const filters: SQL[] = [
    eq(auditLogs.entityType, params.entityType),
    eq(auditLogs.entityId, params.entityId),
  ];

  if (restrictedToActorId) {
    filters.push(eq(auditLogs.actorId, restrictedToActorId));
  }

  const rows = await db
    .select(auditView)
    .from(auditLogs)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.actorId))
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  sendSuccess(res, rows);
}
