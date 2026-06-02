import { eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers, auditLogs } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, errorOf, login } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, seedAdmin, testAdmin } from "./helpers/seed.js";
import { seedAuditRow } from "./helpers/catalog.js";

/**
 * Audit-log reading.
 *
 * The part worth testing is the scope rule rather than the SQL. `auditLogs.read`
 * sees every actor, `auditLogs.readLimited` sees only the caller, and the second
 * one must not degrade into "run the wide query and filter afterwards". Scoping
 * lives in the `WHERE` clause, so paging, filtering, and the total all stay inside
 * it.
 *
 * Metadata redaction is asserted here too, because it happens at write time and a
 * leak would otherwise only be visible in stored rows.
 */

interface AuditRow {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

async function sessionFor(admin: { email: string }): Promise<Agent> {
  const agent = createAgent();

  await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

  return agent;
}

const rowsOf = (res: Response) => dataOf<AuditRow[]>(res);
const actionsOf = (res: Response) => rowsOf(res).map((row) => row.action);

describe("audit logs: authorization and scope", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
  });

  it("requires authentication", async () => {
    await createAgent().get("/api/audit-logs").expect(401);
    await createAgent().get("/api/audit-logs/actions").expect(401);
    await createAgent()
      .get(`/api/audit-logs/entity/product/${crypto.randomUUID()}`)
      .expect(401);
  });

  it("refuses an editor, who holds neither audit permission", async () => {
    const editor = await seedAdmin(testAdmin.editor);
    const agent = await sessionFor(editor);

    const res = await agent.get("/api/audit-logs").expect(403);

    expect(errorOf(res).code).toBe("FORBIDDEN");
    await agent.get("/api/audit-logs/actions").expect(403);
  });

  it("gives the owner every actor's rows", async () => {
    const owner = await seedAdmin(testAdmin.owner);
    const manager = await seedAdmin(testAdmin.manager);
    const agent = await sessionFor(owner);

    // Scoped to a private action prefix: logging in as either admin writes a real
    // `auth.login` row, and this test is about actors rather than the vocabulary.
    await seedAuditRow({ actorId: owner.id, action: "test.owner_action" });
    await seedAuditRow({ actorId: manager.id, action: "test.manager_action" });

    const res = await agent.get("/api/audit-logs?action=test.*&limit=100").expect(200);

    expect(actionsOf(res).sort()).toEqual(["test.manager_action", "test.owner_action"]);
  });

  it("restricts a manager to their own rows, including through filters", async () => {
    const owner = await seedAdmin(testAdmin.owner);
    const manager = await seedAdmin(testAdmin.manager);
    const agent = await sessionFor(manager);

    await seedAuditRow({ actorId: manager.id, action: "test.mine" });
    await seedAuditRow({ actorId: owner.id, action: "test.theirs" });

    const list = await agent.get("/api/audit-logs?action=test.*&limit=100").expect(200);

    expect(actionsOf(list)).toEqual(["test.mine"]);
    // The total counts only what this caller may see, not the table.
    expect(list.body.pagination.total).toBe(1);

    // Naming someone else explicitly ANDs to an unsatisfiable pair rather than
    // erroring, which keeps the response indistinguishable from "no matches".
    const sideways = await agent
      .get(`/api/audit-logs?action=test.*&actorId=${owner.id}`)
      .expect(200);

    expect(rowsOf(sideways)).toHaveLength(0);
  });

  it("scopes the action vocabulary to the caller as well", async () => {
    const owner = await seedAdmin(testAdmin.owner);
    const manager = await seedAdmin(testAdmin.manager);

    await seedAuditRow({ actorId: owner.id, action: "test.owner_only" });
    await seedAuditRow({ actorId: manager.id, action: "test.own" });

    const managerActions = dataOf<string[]>(
      await (await sessionFor(manager)).get("/api/audit-logs/actions").expect(200),
    );

    expect(managerActions).toContain("test.own");
    expect(managerActions).not.toContain("test.owner_only");

    const ownerActions = dataOf<string[]>(
      await (await sessionFor(owner)).get("/api/audit-logs/actions").expect(200),
    );

    expect(ownerActions).toContain("test.own");
    expect(ownerActions).toContain("test.owner_only");
  });
});

describe("audit logs: filtering and ordering", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let actor: typeof adminUsers.$inferSelect;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    actor = await seedAdmin(testAdmin.owner);
    agent = await sessionFor(actor);
  });

  it("matches the action exactly, or with a wildcard", async () => {
    await seedAuditRow({ actorId: actor.id, action: "product.create" });
    await seedAuditRow({ actorId: actor.id, action: "product.update" });
    await seedAuditRow({ actorId: actor.id, action: "brand.create" });

    expect(actionsOf(await agent.get("/api/audit-logs?action=product.create").expect(200))).toEqual(
      ["product.create"],
    );

    const prefix = await agent.get("/api/audit-logs?action=product.*").expect(200);
    const suffix = await agent.get("/api/audit-logs?action=*.create").expect(200);

    expect(rowsOf(prefix)).toHaveLength(2);
    expect(rowsOf(suffix)).toHaveLength(2);
  });

  it("filters by entity type and entity id", async () => {
    const entityId = crypto.randomUUID();

    await seedAuditRow({ actorId: actor.id, action: "a", entityType: "product", entityId });
    await seedAuditRow({ actorId: actor.id, action: "b", entityType: "brand", entityId });

    expect(actionsOf(await agent.get("/api/audit-logs?entityType=product").expect(200))).toEqual([
      "a",
    ]);

    const pair = await agent
      .get(`/api/audit-logs?entityType=brand&entityId=${entityId}`)
      .expect(200);

    expect(actionsOf(pair)).toEqual(["b"]);
  });

  it("filters by a time window and rejects a reversed one", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const yesterday = new Date(now - day).toISOString();

    await seedAuditRow({ actorId: actor.id, action: "test.old", createdAt: new Date(now - 10 * day) });
    await seedAuditRow({ actorId: actor.id, action: "test.recent", createdAt: new Date(now) });

    const from = await agent
      .get(`/api/audit-logs?action=test.*&from=${encodeURIComponent(yesterday)}`)
      .expect(200);
    const to = await agent
      .get(`/api/audit-logs?action=test.*&to=${encodeURIComponent(yesterday)}`)
      .expect(200);

    expect(actionsOf(from)).toEqual(["test.recent"]);
    expect(actionsOf(to)).toEqual(["test.old"]);

    const reversed = await agent
      .get(
        `/api/audit-logs?from=${encodeURIComponent(new Date(now).toISOString())}&to=${encodeURIComponent(yesterday)}`,
      )
      .expect(400);

    expect(errorOf(reversed).code).toBe("VALIDATION_ERROR");
  });

  it("orders by createdAt or action without dropping null actors", async () => {
    await seedAuditRow({ actorId: actor.id, action: "test.b", createdAt: new Date(1) });
    await seedAuditRow({ actorId: actor.id, action: "test.a", createdAt: new Date(2) });
    // An anonymous row (a failed login) sorts alongside authenticated ones.
    await seedAuditRow({ actorId: null, action: "test.c", createdAt: new Date(3) });

    const newest = await agent
      .get("/api/audit-logs?action=test.*&sort=createdAt&order=desc")
      .expect(200);

    expect(actionsOf(newest)).toEqual(["test.c", "test.a", "test.b"]);

    const byAction = await agent
      .get("/api/audit-logs?action=test.*&sort=action&order=asc")
      .expect(200);

    expect(actionsOf(byAction)).toEqual(["test.a", "test.b", "test.c"]);
  });

  it("keeps activity whose actor has since been deleted", async () => {
    const gone = await seedAdmin({ email: "gone@example.test", name: "Gone", role: "editor" });

    await seedAuditRow({ actorId: gone.id, action: "before.deletion" });
    await db.delete(adminUsers).where(eq(adminUsers.id, gone.id));

    const res = await agent.get("/api/audit-logs?action=before.deletion").expect(200);
    const [row] = rowsOf(res);

    expect(row).toBeDefined();
    expect(row!.actorId).toBeNull();
    expect(row!.actorName).toBeNull();
  });

  it("reports the actor's identity for rows that still have one", async () => {
    await seedAuditRow({ actorId: actor.id, action: "tagged" });

    const [row] = rowsOf(await agent.get("/api/audit-logs?action=tagged").expect(200));

    expect(row!.actorEmail).toBe(actor.email);
    expect(row!.actorName).toBe(actor.name);
  });

  it("rejects malformed filters", async () => {
    await agent.get("/api/audit-logs?entityId=not-a-uuid").expect(400);
    await agent.get("/api/audit-logs?actorId=not-a-uuid").expect(400);
    await agent.get("/api/audit-logs?limit=500").expect(400);
    await agent.get("/api/audit-logs?sort=somethingelse").expect(400);
  });
});

describe("audit logs: entity history", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let actor: typeof adminUsers.$inferSelect;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    actor = await seedAdmin(testAdmin.owner);
    agent = await sessionFor(actor);
  });

  it("returns one entity's history newest first", async () => {
    const productId = crypto.randomUUID();
    const otherId = crypto.randomUUID();

    await seedAuditRow({
      actorId: actor.id,
      action: "product.create",
      entityType: "product",
      entityId: productId,
      createdAt: new Date(1),
    });
    await seedAuditRow({
      actorId: actor.id,
      action: "product.update",
      entityType: "product",
      entityId: productId,
      createdAt: new Date(2),
    });
    // Same id, different type: the pair must be matched together.
    await seedAuditRow({
      actorId: actor.id,
      action: "brand.update",
      entityType: "brand",
      entityId: productId,
      createdAt: new Date(3),
    });
    await seedAuditRow({
      actorId: actor.id,
      action: "product.update",
      entityType: "product",
      entityId: otherId,
      createdAt: new Date(4),
    });

    const res = await agent.get(`/api/audit-logs/entity/product/${productId}`).expect(200);

    expect(actionsOf(res)).toEqual(["product.update", "product.create"]);
  });

  it("requires a non-empty entity type and a UUID entity id", async () => {
    await agent.get("/api/audit-logs/entity/product/not-a-uuid").expect(400);
    await agent.get(`/api/audit-logs/entity/%20/${crypto.randomUUID()}`).expect(400);
  });
});

describe("audit recording: what reaches the table", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
  });

  it("redacts sensitive metadata keys before the row is written", async () => {
    const actor = await seedAdmin(testAdmin.owner);

    await recordAudit({
      actorId: actor.id,
      action: "test.redaction",
      entityType: "test",
      metadata: {
        password: "hunter2",
        newPassword: "hunter2",
        refreshToken: "abc",
        authorization: "Bearer x",
        cookie: "session=1",
        secret: "s",
        credential: "c",
        tokenHash: "h",
        keptValue: "visible",
      },
    });

    const [row] = await db.select().from(auditLogs);

    expect(row!.metadata).toEqual({
      password: "[REDACTED]",
      newPassword: "[REDACTED]",
      refreshToken: "[REDACTED]",
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      secret: "[REDACTED]",
      credential: "[REDACTED]",
      tokenHash: "[REDACTED]",
      keptValue: "visible",
    });
  });

  it("nulls an actor id that does not exist instead of throwing", async () => {
    await recordAudit({
      actorId: crypto.randomUUID(),
      action: "test.orphan_actor",
      entityType: "test",
    });

    const [row] = await db.select().from(auditLogs);

    expect(row!.actorId).toBeNull();
    expect(row!.action).toBe("test.orphan_actor");
  });

  it("never lets an audit failure break the request path", async () => {
    // An actor id that is not a UUID at all cannot match the foreign key; the
    // lookup must swallow the error rather than propagate it into the handler.
    await expect(
      recordAudit({ actorId: "not-a-uuid", action: "test.bad_actor", entityType: "test" }),
    ).resolves.toBeUndefined();
  });
});
