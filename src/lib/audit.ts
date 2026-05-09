import { eq } from "drizzle-orm";
import type { Request } from "express";

import { db } from "../db/index.js";
import { adminUsers, auditLogs } from "../db/schema.js";
import { logger } from "../utils/logger.js";

const SENSITIVE_METADATA_KEYS =
  /pass|secret|token|authorization|cookie|credential|hash/i;

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    result[key] = SENSITIVE_METADATA_KEYS.test(key) ? "[REDACTED]" : value;
  }

  return result;
}

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    let actorId = input.actorId ?? null;

    if (actorId) {
      const [existing] = await db
        .select({ id: adminUsers.id })
        .from(adminUsers)
        .where(eq(adminUsers.id, actorId))
        .limit(1);

      if (!existing) {
        actorId = null;
      }
    }

    await db.insert(auditLogs).values({
      actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: sanitizeMetadata(input.metadata),
      ipAddress: input.req?.ip?.slice(0, 64) ?? null,
      userAgent: input.req?.get("user-agent")?.slice(0, 500) ?? null,
    });
  } catch (error) {
    logger.error("Failed to write audit log", { error, action: input.action });
  }
}
