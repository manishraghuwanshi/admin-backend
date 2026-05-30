import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { refreshSessions } from "../db/schema.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  accessCookieHeader,
  authCookiesCleared,
  createAgent,
  dataOf,
  errorOf,
  login,
  readAuthCookies,
  refreshCookieHeader,
} from "./helpers/api.js";
import {
  DEFAULT_ADMIN_PASSWORD,
  findAuditRows,
  seedAdmin,
  seedRefreshSession,
  testAdmin,
} from "./helpers/seed.js";

async function activeSessions(adminUserId: string) {
  return db
    .select({ id: refreshSessions.id })
    .from(refreshSessions)
    .where(and(eq(refreshSessions.adminUserId, adminUserId), isNull(refreshSessions.revokedAt)));
}

/**
 * `POST /api/auth/logout`.
 *
 * The Phase 0 defect was this route missing `requireAuth`, which let an
 * anonymous caller (a) receive a successful-looking 200 and (b) revoke a session
 * with nothing but a stolen refresh token. Both are pinned here.
 */
describe("auth: logout", () => {
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
    const res = await createAgent().post("/api/auth/logout");

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHORIZED");
  });

  it("will not revoke a session on behalf of an anonymous caller holding a refresh token", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const { refreshToken } = await seedRefreshSession(admin.id);

    const res = await createAgent()
      .post("/api/auth/logout")
      .set("Cookie", refreshCookieHeader(refreshToken));

    expect(res.status).toBe(401);
    expect(await activeSessions(admin.id)).toHaveLength(1);
  });

  it("revokes the current session, clears cookies, and reports success", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const loginRes = await login(agent, {
      email: admin.email,
      password: DEFAULT_ADMIN_PASSWORD,
    });
    const { refreshToken } = readAuthCookies(loginRes);

    expect(authCookiesCleared(loginRes)).toBe(false);

    const res = await agent.post("/api/auth/logout").expect(200);

    expect(dataOf(res)).toEqual({ loggedOut: true });
    expect(authCookiesCleared(res)).toBe(true);
    expect(await activeSessions(admin.id)).toHaveLength(0);

    const [session] = await db.select().from(refreshSessions);

    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(refreshToken).toHaveLength(64);
  });

  it("makes both tokens unusable afterwards", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const tokens = readAuthCookies(
      await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD }),
    );

    await agent.post("/api/auth/logout").expect(200);

    await createAgent()
      .get("/api/auth/me")
      .set("Cookie", accessCookieHeader(tokens.accessToken))
      .expect(401);

    await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(tokens.refreshToken))
      .expect(401);
  });

  it("revokes only the calling session, leaving other devices signed in", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const other = await seedRefreshSession(admin.id);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(await activeSessions(admin.id)).toHaveLength(2);

    await agent.post("/api/auth/logout").expect(200);

    expect((await activeSessions(admin.id)).map((row) => row.id)).toEqual([other.session.id]);
  });

  it("audits the logout with the actor and without any credentials", async () => {
    const admin = await seedAdmin(testAdmin.editor);
    const agent = createAgent();

    const tokens = readAuthCookies(
      await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD }),
    );

    await agent.post("/api/auth/logout").expect(200);

    const [row] = await findAuditRows("auth.logout");

    expect(row.actorId).toBe(admin.id);
    expect(row.entityType).toBe("admin_user");
    expect(row.entityId).toBe(admin.id);

    const serialized = JSON.stringify(row);

    expect(serialized).not.toContain(tokens.refreshToken);
    expect(serialized).not.toContain(tokens.accessToken);
    expect(serialized).not.toContain(DEFAULT_ADMIN_PASSWORD);
  });

  it("is idempotent: a second logout is simply unauthorized", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const auditBefore = await countRows(handle, "audit_logs");

    await agent.post("/api/auth/logout").expect(200);

    const second = await agent.post("/api/auth/logout");

    expect(second.status).toBe(401);
    expect(await countRows(handle, "audit_logs")).toBe(auditBefore + 1);
  });
});

