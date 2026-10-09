import { and, eq } from "drizzle-orm";
import type { Agent, Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers, auditLogs, refreshSessions } from "../db/schema.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, errorOf, login } from "./helpers/api.js";
import {
  DEFAULT_ADMIN_PASSWORD,
  findAuditRows,
  seedAdmin,
  seedRefreshSession,
  testAdmin,
  type SeedAdmin,
} from "./helpers/seed.js";

/**
 * Administrator management.
 *
 * The interesting behaviour here is not CRUD; it is the three invariants the
 * service layer holds on top of `adminUsers.manage`: an active owner must always
 * survive, an administrator cannot cut their own path to the console, and claims
 * baked into live tokens (role, email, password) must be invalidated by the
 * mutation that makes them wrong. `passwordHash` must never leave the module.
 */

const BASE = "/api/admin-users";

const STRONG_PASSWORD = "RotationPass9";

interface AdminRow {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeSessionCount?: number;
}

const rowsOf = (res: Response) => dataOf<AdminRow[]>(res);
const rowOf = (res: Response) => dataOf<AdminRow>(res);

async function signedIn(
  spec: SeedAdmin,
): Promise<{ agent: Agent; admin: typeof adminUsers.$inferSelect }> {
  const admin = await seedAdmin(spec);
  const agent = createAgent();

  await login(agent, { email: spec.email, password: spec.password });

  return { agent, admin };
}

async function sessionState(adminUserId: string) {
  const rows = await db
    .select({ id: refreshSessions.id, revokedAt: refreshSessions.revokedAt })
    .from(refreshSessions)
    .where(eq(refreshSessions.adminUserId, adminUserId));

  return { total: rows.length, live: rows.filter((r) => r.revokedAt === null).length };
}

describe("admin users: access control", () => {
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

  it("requires authentication on every route", async () => {
    const anonymous = createAgent();

    expect((await anonymous.get(BASE)).status).toBe(401);
    expect((await anonymous.post(BASE).send({})).status).toBe(401);
    expect((await anonymous.delete(`/api/admin-users/${crypto.randomUUID()}`)).status).toBe(401);
  });

  it("is limited to the owner role, which alone holds adminUsers.manage", async () => {
    const owner = await signedIn(testAdmin.owner);
    const manager = await signedIn(testAdmin.manager);
    const editor = await signedIn(testAdmin.editor);

    for (const agent of [manager.agent, editor.agent]) {
      expect((await agent.get(BASE)).status).toBe(403);
      expect((await agent.post(BASE).send({})).status).toBe(403);
      expect((await agent.patch(`${BASE}/${owner.admin.id}`).send({ name: "x" })).status).toBe(
        403,
      );
      expect((await agent.delete(`${BASE}/${owner.admin.id}`)).status).toBe(403);
    }

    expect((await owner.agent.get(BASE)).status).toBe(200);
  });

  it("reports the permission table through the manager rather than pretending", async () => {
    // A 403 here must be an authorization decision, not a missing route: the same
    // caller can still reach the catalog endpoints its role allows.
    const manager = await signedIn(testAdmin.manager);

    expect(errorOf(await manager.agent.get(BASE)).code).toBe("FORBIDDEN");
    expect((await manager.agent.get("/api/products")).status).toBe(200);
  });
});

describe("admin users: reading the list", () => {
  let handle: TestDatabase;
  let agent: Agent;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);

    const session = await signedIn(testAdmin.owner);

    agent = session.agent;

    await seedAdmin({ ...testAdmin.owner, email: "dana@example.test", name: "Dana Whitfield" });
    await seedAdmin({ ...testAdmin.manager, email: "zoe@example.test", name: "Zoe Addams" });
    await seedAdmin({ ...testAdmin.editor, email: "abe@example.test", name: "Abe Mirable" });
    await seedAdmin({
      ...testAdmin.editor,
      email: "inactive@example.test",
      name: "Ida Retired",
      isActive: false,
    });
  });

  it("paginates and never includes the password hash", async () => {
    const res = await agent.get(`${BASE}?limit=2&page=1`).expect(200);

    expect(rowsOf(res)).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2, total: 5 });
    expect(res.body.pagination.totalPages).toBe(3);

    const body = JSON.stringify(res.body);

    expect(body).not.toContain("passwordHash");
    expect(body).not.toMatch(/\$argon2/);
  });

  it("excludes inactive administrators only when asked", async () => {
    const all = await agent.get(`${BASE}?limit=100`).expect(200);

    expect(rowsOf(all)).toHaveLength(5);

    const active = await agent.get(`${BASE}?isActive=true&limit=100`).expect(200);

    expect(rowsOf(active)).toHaveLength(4);

    const inactive = await agent.get(`${BASE}?isActive=false&limit=100`).expect(200);

    expect(rowsOf(inactive).map((row) => row.email)).toEqual(["inactive@example.test"]);
  });

  it("filters by role and searches name or email", async () => {
    const editors = await agent.get(`${BASE}?role=editor&limit=100`).expect(200);

    expect(rowsOf(editors).map((row) => row.email).sort()).toEqual([
      "abe@example.test",
      "inactive@example.test",
    ]);

    const owners = await agent.get(`${BASE}?role=owner&limit=100`).expect(200);

    expect(rowsOf(owners).map((row) => row.email).sort()).toEqual([
      "dana@example.test",
      "owner@example.test",
    ]);

    const byName = await agent.get(`${BASE}?search=Whitfield`).expect(200);

    expect(rowsOf(byName).map((row) => row.email)).toEqual(["dana@example.test"]);

    const byEmail = await agent.get(`${BASE}?search=zoe@`).expect(200);

    expect(rowsOf(byEmail).map((row) => row.email)).toEqual(["zoe@example.test"]);
  });

  it("sorts by the allowed columns in both directions", async () => {
    const asc = await agent.get(`${BASE}?sort=name&order=asc&limit=100`).expect(200);

    expect(rowsOf(asc)[0]!.name).toBe("Abe Mirable");

    const desc = await agent.get(`${BASE}?sort=name&order=desc&limit=100`).expect(200);

    expect(rowsOf(desc)[0]!.name).toBe("Zoe Addams");

    const byEmail = await agent.get(`${BASE}?sort=email&order=asc&limit=100`).expect(200);

    expect(rowsOf(byEmail).map((row) => row.email)).toEqual([
      "abe@example.test",
      "dana@example.test",
      "inactive@example.test",
      "owner@example.test",
      "zoe@example.test",
    ]);

    const byLastLogin = await agent.get(`${BASE}?sort=lastLoginAt&order=asc&limit=100`).expect(200);

    // Seeded admins never logged in. Postgres sorts NULLs last in `asc`, so the one
    // account with a real `lastLoginAt` - the signed-in owner - leads the list.
    expect(rowsOf(byLastLogin)[0]!.email).toBe("owner@example.test");
    expect(rowsOf(byLastLogin).at(-1)!.lastLoginAt).toBeNull();
  });

  it("rejects an unknown sort column or a nonsense page", async () => {
    expect(errorOf(await agent.get(`${BASE}?sort=passwordHash`)).code).toBe("VALIDATION_ERROR");
    expect(errorOf(await agent.get(`${BASE}?page=0`)).code).toBe("VALIDATION_ERROR");
    expect(errorOf(await agent.get(`${BASE}?isActive=maybe`)).code).toBe("VALIDATION_ERROR");
  });

  it("counts live sessions without inflating the pagination total", async () => {
    // Search matches name OR email, so two people can share one result page. Each
    // row must carry its own count, and the page total must stay the number of
    // administrators rather than the number of admin x session pairs.
    // `beforeEach` already seeds Zoe Addams; add a second "Addams" to search for.
    const nora = await seedAdmin({ ...testAdmin.editor, email: "nora@example.test", name: "Nora Addams" });
    const [zoe] = rowsOf(await agent.get(`${BASE}?search=Zoe Addams`).expect(200));

    await seedRefreshSession(zoe!.id);
    await seedRefreshSession(zoe!.id);
    await seedRefreshSession(zoe!.id, { revokedAt: new Date() });
    await seedRefreshSession(nora.id);

    const res = await agent.get(`${BASE}?search=Addams&limit=100`).expect(200);
    const byEmail = new Map(rowsOf(res).map((row) => [row.email, row]));

    expect(res.body.pagination.total).toBe(2);
    // Distinct per row: a count that collapses to 0, or to one shared value, fails here.
    expect(byEmail.get("zoe@example.test")!.activeSessionCount).toBe(2);
    expect(byEmail.get("nora@example.test")!.activeSessionCount).toBe(1);

    // Two rows across a page size of one: the sessions do not multiply the rows,
    // so exactly one extra page exists and nothing beyond it.
    const page = await agent.get(`${BASE}?search=Addams&limit=1&page=2`).expect(200);

    expect(rowsOf(page)).toHaveLength(1);
    expect(page.body.pagination).toMatchObject({ total: 2, totalPages: 2 });

    expect((await agent.get(`${BASE}?search=Addams&limit=1&page=3`).expect(200)).body.data).toEqual([]);
  });

  it("reads one administrator by id, 404s for a missing one, and 400s for a malformed id", async () => {
    const [target] = rowsOf(await agent.get(`${BASE}?search=dana@`).expect(200));

    const res = await agent.get(`${BASE}/${target!.id}`).expect(200);

    expect(rowOf(res).email).toBe("dana@example.test");
    expect(rowOf(res).activeSessionCount).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    expect((await agent.get(`${BASE}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await agent.get(`${BASE}/not-a-uuid`)).status).toBe(400);
  });
});

describe("admin users: creating", () => {
  let handle: TestDatabase;
  let agent: Agent;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);

    const session = await signedIn(testAdmin.owner);

    agent = session.agent;
  });

  it("creates an administrator that can sign straight in", async () => {
    const res = await agent
      .post(BASE)
      .send({
        email: "Nina@example.test",
        name: "Nina Hartley",
        role: "manager",
        password: STRONG_PASSWORD,
      })
      .expect(201);

    const created = rowOf(res);

    expect(created.email).toBe("nina@example.test");
    expect(created.role).toBe("manager");
    expect(created.isActive).toBe(true);
    expect(created).not.toHaveProperty("passwordHash");

    const newcomer = createAgent();

    await login(newcomer, { email: "nina@example.test", password: STRONG_PASSWORD });

    // The role the server assigned is the one that takes effect, not whatever the
    // client asked for - the token derives from the stored row.
    expect(dataOf<{ role: string }>(await newcomer.get("/api/auth/me")).role).toBe("manager");
  });

  it("honours an explicit isActive: false", async () => {
    const res = await agent
      .post(BASE)
      .send({
        email: "parked@example.test",
        name: "Parked Account",
        role: "editor",
        password: STRONG_PASSWORD,
        isActive: false,
      })
      .expect(201);

    expect(rowOf(res).isActive).toBe(false);

    const parked = createAgent();

    expect(
      (
        await parked
          .post("/api/auth/login")
          .send({ email: "parked@example.test", password: STRONG_PASSWORD })
      ).status,
    ).toBe(401);
  });

  it("rejects a weak password instead of storing it", async () => {
    const weakPasswords = ["short1A", "alllettersnodigit", "1234567890123"];

    for (const password of weakPasswords) {
      const res = await agent
        .post(BASE)
        .send({ email: "weak@example.test", name: "Weak", role: "editor", password });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe("UNPROCESSABLE_ENTITY");
      expect(errorOf(res).message).toMatch(/password/i);
    }

    // Rejected on strength grounds, so nothing was inserted at all.
    expect((await agent.get(`${BASE}?search=weak@`)).body.data).toHaveLength(0);
  });

  it("rejects malformed input with 400 rather than a database error", async () => {
    const cases: Array<Record<string, unknown>> = [
      { email: "not-an-email", name: "X", role: "editor", password: STRONG_PASSWORD },
      { email: "ok@example.test", name: "   ", role: "editor", password: STRONG_PASSWORD },
      { email: "ok@example.test", name: "X", role: "superadmin", password: STRONG_PASSWORD },
      { email: "ok@example.test", name: "X", role: "editor" },
      { email: "ok@example.test", name: "X", role: "editor", password: "" },
    ];

    for (const body of cases) {
      const res = await agent.post(BASE).send(body);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses a duplicate email, including one differing only in case", async () => {
    await agent
      .post(BASE)
      .send({
        email: "dup@example.test",
        name: "First",
        role: "editor",
        password: STRONG_PASSWORD,
      })
      .expect(201);

    const res = await agent
      .post(BASE)
      .send({
        email: "DUP@example.test",
        name: "Second",
        role: "editor",
        password: STRONG_PASSWORD,
      });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("CONFLICT");
  });

  it("audits a creation without leaking the password", async () => {
    await agent
      .post(BASE)
      .send({
        email: "audited@example.test",
        name: "Audited Admin",
        role: "manager",
        password: STRONG_PASSWORD,
      })
      .expect(201);

    const [row] = await findAuditRows("admin_user.create");

    expect(row).toBeDefined();
    expect(row!.metadata).toMatchObject({ email: "audited@example.test", role: "manager" });
    expect(JSON.stringify(row!.metadata)).not.toContain(STRONG_PASSWORD);
    expect(JSON.stringify(row!.metadata)).not.toContain("password");
  });
});

describe("admin users: updating", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let owner: typeof adminUsers.$inferSelect;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);

    const session = await signedIn(testAdmin.owner);

    agent = session.agent;
    owner = session.admin;
  });

  it("renames an administrator and audits which fields changed", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "rename@example.test" });

    const res = await agent.patch(`${BASE}/${target.id}`).send({ name: "Renamed Admin" }).expect(200);

    expect(rowOf(res).name).toBe("Renamed Admin");
    expect(rowOf(res).role).toBe("editor");

    const [row] = await findAuditRows("admin_user.update");

    expect(row!.entityId).toBe(target.id);
    expect(row!.metadata).toMatchObject({ fields: ["name"], revokedSessionCount: 0 });
  });

  it("refuses an empty patch", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "empty@example.test" });

    const res = await agent.patch(`${BASE}/${target.id}`).send({});

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    // `validate` flattens Zod issues into `error.details`; the message stays generic.
    expect(JSON.stringify(res.body)).toMatch(/at least one field/i);

    // Nothing was written, so the row is untouched.
    expect(rowOf(await agent.get(`${BASE}/${target.id}`).expect(200)).name).toBe("Test Editor");
  });

  it("keeps a signed-in administrator out of the console after a role change", async () => {
    const editor = await seedAdmin({ ...testAdmin.editor, email: "promote@example.test" });
    const editorAgent = createAgent();

    await login(editorAgent, { email: editor.email, password: DEFAULT_ADMIN_PASSWORD });

    expect((await editorAgent.get("/api/products")).status).toBe(200);

    const res = await agent.patch(`${BASE}/${editor.id}`).send({ role: "manager" }).expect(200);

    expect(rowOf(res).role).toBe("manager");
    // The old token still claims "editor" and its session has been revoked, so it
    // must stop working rather than keep a stale role alive.
    expect((await editorAgent.get("/api/products")).status).toBe(401);

    const [row] = await findAuditRows("admin_user.update");

    expect(row!.metadata).toMatchObject({ fields: ["role"], revokedSessionCount: 1 });
  });

  it("deactivates another administrator and blocks their existing session", async () => {
    const manager = await seedAdmin({ ...testAdmin.manager, email: "offboard@example.test" });
    const managerAgent = createAgent();

    await login(managerAgent, { email: manager.email, password: DEFAULT_ADMIN_PASSWORD });

    expect((await sessionState(manager.id)).live).toBe(1);

    const res = await agent.patch(`${BASE}/${manager.id}`).send({ isActive: false }).expect(200);

    expect(rowOf(res).isActive).toBe(false);
    expect((await sessionState(manager.id)).live).toBe(0);
    expect((await managerAgent.get("/api/products")).status).toBe(401);
  });

  it("reactivates an administrator without revoking anything", async () => {
    const dormant = await seedAdmin({
      ...testAdmin.editor,
      email: "dormant@example.test",
      isActive: false,
    });

    const res = await agent.patch(`${BASE}/${dormant.id}`).send({ isActive: true }).expect(200);

    expect(rowOf(res).isActive).toBe(true);

    const [row] = await findAuditRows("admin_user.update");

    expect(row!.metadata).toMatchObject({ fields: ["isActive"], revokedSessionCount: 0 });

    const revived = createAgent();

    await login(revived, { email: dormant.email, password: DEFAULT_ADMIN_PASSWORD });
    expect(dataOf<{ role: string }>(await revived.get("/api/auth/me")).role).toBe("editor");
  });

  it("changes an email address and forces a re-login under the new one", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "before@example.test" });
    const targetAgent = createAgent();

    await login(targetAgent, { email: target.email, password: DEFAULT_ADMIN_PASSWORD });

    await agent.patch(`${BASE}/${target.id}`).send({ email: "After@Example.test" }).expect(200);

    expect((await targetAgent.get("/api/products")).status).toBe(401);

    const moved = createAgent();

    await login(moved, { email: "after@example.test", password: DEFAULT_ADMIN_PASSWORD });
    expect((await moved.get("/api/auth/me")).status).toBe(200);
  });

  it("rejects an email already taken by someone else", async () => {
    const taken = await seedAdmin({ ...testAdmin.editor, email: "taken@example.test" });
    const target = await seedAdmin({ ...testAdmin.manager, email: "free@example.test" });

    const res = await agent.patch(`${BASE}/${target.id}`).send({ email: "TAKEN@example.test" });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("CONFLICT");
    expect((await agent.get(`${BASE}/${taken.id}`)).status).toBe(200);
  });

  it("stops the caller from locking themselves out of the console", async () => {
    // Self-demotion and self-deactivation are the two ways an owner can strand
    // the only role that holds `adminUsers.manage`.
    for (const role of ["manager", "editor"]) {
      const res = await agent.patch(`${BASE}/${owner.id}`).send({ role });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe("UNPROCESSABLE_ENTITY");
      expect(errorOf(res).message).toMatch(/owner role/i);
    }

    const deactivated = await agent.patch(`${BASE}/${owner.id}`).send({ isActive: false });

    expect(deactivated.status).toBe(422);
    expect(errorOf(deactivated).message).toMatch(/deactivate your own/i);

    const selfDeleted = await agent.delete(`${BASE}/${owner.id}`);

    expect(selfDeleted.status).toBe(422);
    expect(errorOf(selfDeleted).message).toMatch(/own account/i);
  });

  it("lets an owner rename and re-state their own role", async () => {
    const res = await agent
      .patch(`${BASE}/${owner.id}`)
      .send({ name: "Owner Renamed", role: "owner" })
      .expect(200);

    expect(rowOf(res).name).toBe("Owner Renamed");
    expect(rowOf(res).role).toBe("owner");
    // Nothing changed about the caller's authority, but `role` in the payload
    // still rotates sessions, so this is the one case where re-login is expected.
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("leaves no path by which the only active owner can strand the console", async () => {
    // Two owners can demote each other, because a second owner survives the change.
    for (const [index, body] of [
      { role: "manager" },
      { role: "editor" },
      { isActive: false },
    ].entries()) {
      const other = await seedAdmin({ ...testAdmin.owner, email: `pool-${index}@example.test` });

      await agent.patch(`${BASE}/${other.id}`).send(body).expect(200);
    }

    // The caller is now the only active owner, so every mutation that would take
    // it out of the pool is refused: `unprocessable` by the self-lockout guard, or
    // `conflict` from the last-owner guard. Either way the row is left alone, which
    // is the invariant that matters - the console always has a way back in.
    const mutations: Array<{ method: "patch" | "delete"; body?: Record<string, unknown> }> = [
      { method: "patch", body: { role: "manager" } },
      { method: "patch", body: { role: "editor" } },
      { method: "patch", body: { isActive: false } },
      { method: "delete" },
    ];

    for (const mutation of mutations) {
      const res =
        mutation.method === "delete"
          ? await agent.delete(`${BASE}/${owner.id}`)
          : await agent.patch(`${BASE}/${owner.id}`).send(mutation.body);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      const after = rowOf(await agent.get(`${BASE}/${owner.id}`).expect(200));

      expect(after.role).toBe("owner");
      expect(after.isActive).toBe(true);
    }

    // A dormant owner is not coverage for the invariant, so removing one is fine.
    const dormant = await seedAdmin({
      ...testAdmin.owner,
      email: "dormant-owner@example.test",
      isActive: false,
    });

    await agent.delete(`${BASE}/${dormant.id}`).expect(200);

    // A rename of the only owner is allowed: it changes nothing about coverage.
    expect((await agent.patch(`${BASE}/${owner.id}`).send({ name: "Still Owner" })).status).toBe(
      200,
    );
  });

  it("404s for an unknown administrator on every mutation and sub-resource", async () => {
    const missing = crypto.randomUUID();

    expect((await agent.patch(`${BASE}/${missing}`).send({ name: "Ghost" })).status).toBe(404);
    expect(
      (await agent.put(`${BASE}/${missing}/password`).send({ password: STRONG_PASSWORD })).status,
    ).toBe(404);
    expect((await agent.delete(`${BASE}/${missing}`)).status).toBe(404);
    expect((await agent.get(`${BASE}/${missing}/sessions`)).status).toBe(404);
    expect((await agent.post(`${BASE}/${missing}/sessions/revoke`)).status).toBe(404);
    expect((await agent.get(`${BASE}/${missing}/audit-logs`)).status).toBe(404);
  });
});

describe("admin users: passwords and sessions", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let owner: typeof adminUsers.$inferSelect;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);

    const session = await signedIn(testAdmin.owner);

    agent = session.agent;
    owner = session.admin;
  });

  it("sets a new password that replaces the old one", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "pw@example.test" });

    const res = await agent
      .put(`${BASE}/${target.id}/password`)
      .send({ password: STRONG_PASSWORD })
      .expect(200);

    expect(rowOf(res)).toMatchObject({ passwordUpdated: true });

    const stale = createAgent();

    expect(
      (
        await stale
          .post("/api/auth/login")
          .send({ email: target.email, password: DEFAULT_ADMIN_PASSWORD })
      ).status,
    ).toBe(401);

    // An immediate retry with the working password is now intentionally refused:
    // the failed attempt above started the per-account 5-second interval. Reusing
    // the initial password here would assert against that throttle, not against the
    // password change, so the check is made with the old password again and the
    // throttle is waited out before the new password is used.
    expect(
      Number(
        (
          await stale
            .post("/api/auth/login")
            .send({ email: target.email, password: DEFAULT_ADMIN_PASSWORD })
        ).headers["retry-after"],
      ),
    ).toBeGreaterThan(0);

    await db
      .update(adminUsers)
      .set({ lastFailedLoginAt: new Date(Date.now() - 60_000) })
      .where(eq(adminUsers.id, target.id));

    const rotated = createAgent();

    await login(rotated, { email: target.email, password: STRONG_PASSWORD });
    expect((await rotated.get("/api/auth/me")).status).toBe(200);
  });

  it("revokes every session when a password changes, including the caller's own", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "many@example.test" });

    await seedRefreshSession(target.id);
    await seedRefreshSession(target.id);
    const targetAgent = createAgent();

    await login(targetAgent, { email: target.email, password: DEFAULT_ADMIN_PASSWORD });

    expect((await sessionState(target.id)).live).toBe(3);

    const res = await agent
      .put(`${BASE}/${target.id}/password`)
      .send({ password: STRONG_PASSWORD })
      .expect(200);

    expect(dataOf<{ revokedSessionCount: number }>(res)).toMatchObject({ revokedSessionCount: 3 });
    expect((await sessionState(target.id)).live).toBe(0);

    // Rotating your own password logs you out everywhere - including right now.
    const self = await agent
      .put(`${BASE}/${owner.id}/password`)
      .send({ password: STRONG_PASSWORD })
      .expect(200);

    expect(dataOf<{ revokedSessionCount: number }>(self).revokedSessionCount).toBe(1);
    expect((await agent.get("/api/auth/me")).status).toBe(401);

    // ...and the old password no longer opens a session.
    expect(
      (
        await createAgent()
          .post("/api/auth/login")
          .send({ email: owner.email, password: DEFAULT_ADMIN_PASSWORD })
      ).status,
    ).toBe(401);
  });

  it("refuses a weak new password", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "weakpw@example.test" });

    for (const password of ["short1A", "alllettersnodigit"]) {
      const res = await agent.put(`${BASE}/${target.id}/password`).send({ password });

      expect(res.status).toBe(422);
      expect(errorOf(res).message).toMatch(/password/i);
    }

    // The rejection leaves the working password untouched.
    await login(createAgent(), { email: target.email, password: DEFAULT_ADMIN_PASSWORD });
  });

  it("lists sessions without exposing the token hash", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "sessions@example.test" });

    await seedRefreshSession(target.id, { userAgent: "MacBook Safari", ipAddress: "203.0.113.7" });
    await seedRefreshSession(target.id, { revokedAt: new Date() });

    const res = await agent.get(`${BASE}/${target.id}/sessions`).expect(200);

    const sessions = dataOf<Array<Record<string, unknown>>>(res);

    expect(sessions).toHaveLength(2);
    expect(sessions.find((row) => row.revokedAt === null)).toMatchObject({
      userAgent: "MacBook Safari",
      ipAddress: "203.0.113.7",
    });
    expect(sessions.some((row) => row.revokedAt !== null)).toBe(true);
    // Never the token material - the hash would be reusable, the row is not.
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");
  });

  it("revokes sessions on demand and reports how many", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "bye@example.test" });
    const targetAgent = createAgent();

    await seedRefreshSession(target.id);
    await login(targetAgent, { email: target.email, password: DEFAULT_ADMIN_PASSWORD });

    const res = await agent.post(`${BASE}/${target.id}/sessions/revoke`).expect(200);

    expect(dataOf<{ revokedSessionCount: number }>(res).revokedSessionCount).toBe(2);
    expect((await targetAgent.get("/api/products")).status).toBe(401);

    const [row] = await findAuditRows("admin_user.sessions_revoked");

    expect(row!.entityId).toBe(target.id);
    expect(row!.metadata).toMatchObject({ revokedSessionCount: 2 });

    // Revoking twice is not an error; there is simply nothing left to revoke.
    const again = await agent.post(`${BASE}/${target.id}/sessions/revoke`).expect(200);

    expect(dataOf<{ revokedSessionCount: number }>(again).revokedSessionCount).toBe(0);
  });

  it("revoking sessions does not stop the administrator signing back in", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "again@example.test" });

    await agent.post(`${BASE}/${target.id}/sessions/revoke`).expect(200);

    const fresh = createAgent();

    await login(fresh, { email: target.email, password: DEFAULT_ADMIN_PASSWORD });
    expect((await fresh.get("/api/auth/me")).status).toBe(200);
  });
});

describe("admin users: deleting", () => {
  let handle: TestDatabase;
  let agent: Agent;
  let owner: typeof adminUsers.$inferSelect;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);

    const session = await signedIn(testAdmin.owner);

    agent = session.agent;
    owner = session.admin;
  });

  it("removes the administrator and their sessions, and reports success", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "gone@example.test" });

    await seedRefreshSession(target.id);
    await seedRefreshSession(target.id);

    const res = await agent.delete(`${BASE}/${target.id}`).expect(200);

    expect(dataOf(res)).toEqual({ deleted: true });
    expect((await sessionState(target.id)).total).toBe(0);
    expect((await agent.get(`${BASE}/${target.id}`)).status).toBe(404);

    const remaining = await agent.get(`${BASE}?limit=100`).expect(200);

    expect(rowsOf(remaining).map((row) => row.email)).toEqual(["owner@example.test"]);
  });

  it("keeps what a deleted administrator did, and who did it becomes unknowable", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "history@example.test" });
    const targetAgent = createAgent();

    await login(targetAgent, { email: target.email, password: DEFAULT_ADMIN_PASSWORD });

    // Audit rows are keyed by the *entity acted on*, so an admin's own activity
    // lives under other ids. Give the account a footprint outside itself.
    const brandId = rowOf(
      await targetAgent
        .post("/api/brands")
        .send({ name: "Deleted Admin Brand", slug: "deleted-admin-brand" })
        .expect(201),
    ).id as string;

    await agent.put(`${BASE}/${target.id}/password`).send({ password: STRONG_PASSWORD }).expect(200);
    await agent.delete(`${BASE}/${target.id}`).expect(200);

    const [deletion] = await findAuditRows("admin_user.delete");

    expect(deletion!.entityId).toBe(target.id);
    // Enough detail to reconstruct the decision, and none of the password.
    expect(deletion!.metadata).toMatchObject({ email: "history@example.test", role: "editor" });
    expect(JSON.stringify(deletion!.metadata)).not.toContain("password");

    // The history survives its author: `actor_id` is nulled rather than the rows
    // cascaded away, otherwise deleting an admin would erase what they did.
    const [brandAudit] = await db
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, brandId), eq(auditLogs.action, "brand.create")));

    expect(brandAudit!.actorId).toBeNull();

    // The sub-resource is now unreachable - a 404, not a leak.
    expect((await agent.get(`${BASE}/${target.id}/audit-logs`)).status).toBe(404);
    expect((await agent.get(`${BASE}/${target.id}/sessions`)).status).toBe(404);
  });

  it("records every admin mutation in the audit trail", async () => {
    const target = await seedAdmin({ ...testAdmin.editor, email: "trail@example.test" });

    await agent.post(BASE).send({
      email: "trail-two@example.test",
      name: "Trail Two",
      role: "editor",
      password: STRONG_PASSWORD,
    }).expect(201);

    await agent.patch(`${BASE}/${target.id}`).send({ name: "Trail Renamed" }).expect(200);
    await agent.put(`${BASE}/${target.id}/password`).send({ password: STRONG_PASSWORD }).expect(200);
    await agent.post(`${BASE}/${target.id}/sessions/revoke`).expect(200);
    await agent.delete(`${BASE}/${target.id}`).expect(200);

    for (const action of [
      "admin_user.create",
      "admin_user.update",
      "admin_user.password_reset",
      "admin_user.sessions_revoked",
      "admin_user.delete",
    ]) {
      const rows = await findAuditRows(action);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(owner.id);
    }

    // The trail is readable through the owner's own history endpoint.
    const actions = dataOf<Array<{ action: string }>>(
      await agent.get(`${BASE}/${owner.id}/audit-logs`).expect(200),
    ).map((row) => row.action);

    expect(actions).toContain("admin_user.create");
    expect(actions).toContain("admin_user.delete");
  });

  it("does not audit a mutation that failed", async () => {
    await agent.post(BASE).send({ email: "bad", name: "Nope", role: "editor", password: "x" });
    await agent.patch(`${BASE}/${crypto.randomUUID()}`).send({ name: "Ghost" });

    expect(await findAuditRows("admin_user.create")).toHaveLength(0);
    expect(await findAuditRows("admin_user.update")).toHaveLength(0);
  });
});
