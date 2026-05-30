import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { refreshSessions } from "../db/schema.js";
import { hashRefreshToken } from "../lib/auth/tokens.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  authCookiesCleared,
  createAgent,
  errorOf,
  login,
  readAuthCookies,
  refreshCookieHeader,
} from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, seedAdmin, seedRefreshSession, testAdmin } from "./helpers/seed.js";

async function activeSessionIds(adminUserId: string): Promise<string[]> {
  const rows = await db
    .select({ id: refreshSessions.id })
    .from(refreshSessions)
    .where(and(eq(refreshSessions.adminUserId, adminUserId), isNull(refreshSessions.revokedAt)));

  return rows.map((row) => row.id);
}

async function sessionByToken(refreshToken: string) {
  const [session] = await db
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, hashRefreshToken(refreshToken)));

  return session;
}

/**
 * Refresh-token rotation and reuse detection: the subtlest part of the auth
 * foundation, and the easiest thing to break with a careless change.
 */
describe("auth: refresh rotation", () => {
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

  it("rotates both tokens and revokes the session it replaced", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const first = await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });
    const original = readAuthCookies(first);

    const res = await agent.post("/api/auth/refresh").expect(200);
    const rotated = readAuthCookies(res);

    expect(rotated.accessToken).not.toBe(original.accessToken);
    expect(rotated.refreshToken).not.toBe(original.refreshToken);
    expect((await sessionByToken(original.refreshToken)).revokedAt).toBeInstanceOf(Date);
    expect((await sessionByToken(rotated.refreshToken)).revokedAt).toBeNull();
    expect(await activeSessionIds(admin.id)).toHaveLength(1);
  });

  it("returns the profile and leaves the new cookies authenticated", async () => {
    const admin = await seedAdmin(testAdmin.manager);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const res = await agent.post("/api/auth/refresh").expect(200);

    expect((res.body as { data: { id: string } }).data.id).toBe(admin.id);
    await agent.get("/api/auth/me").expect(200);
  });

  it("rejects a replay of the rotated-out token", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const first = await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });
    const stale = readAuthCookies(first);

    await agent.post("/api/auth/refresh").expect(200);

    const replay = await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(stale.refreshToken));

    expect(replay.status).toBe(401);
    expect(errorOf(replay).message).toBe("Invalid or expired session");
    expect(authCookiesCleared(replay)).toBe(true);
  });

  it("kills the whole session lineage when a rotated-out token is replayed", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const first = await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });
    const stolenAtLogin = readAuthCookies(first);

    const second = await agent.post("/api/auth/refresh").expect(200);
    const secondTokens = readAuthCookies(second);

    await agent.post("/api/auth/refresh").expect(200);

    expect(await activeSessionIds(admin.id)).toHaveLength(1);

    const replay = await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(stolenAtLogin.refreshToken));

    expect(replay.status).toBe(401);
    expect(await activeSessionIds(admin.id)).toHaveLength(0);

    // The newest token in the chain is dead too: a thief must not keep a
    // session the real admin is locked out of.
    const afterRevocation = await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(secondTokens.refreshToken));

    expect(afterRevocation.status).toBe(401);
  });

  it("rejects a missing, malformed, or unknown refresh cookie", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    await createAgent().post("/api/auth/refresh").expect(401);
    await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader("does-not-exist"))
      .expect(401);

    expect(await activeSessionIds(admin.id)).toHaveLength(0);
  });

  it("rejects an expired session and stamps it revoked", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const { session, refreshToken } = await seedRefreshSession(admin.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(refreshToken));

    expect(res.status).toBe(401);
    expect(authCookiesCleared(res)).toBe(true);
    expect((await sessionByToken(refreshToken)).revokedAt).toBeInstanceOf(Date);
    expect(session.adminUserId).toBe(admin.id);
  });

  it("rejects a refresh for a deactivated admin and revokes that session", async () => {
    const admin = await seedAdmin({ ...testAdmin.editor, isActive: false });
    const { refreshToken } = await seedRefreshSession(admin.id);

    const res = await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader(refreshToken));

    expect(res.status).toBe(401);
    expect(await activeSessionIds(admin.id)).toHaveLength(0);
  });

  it("creates no session rows when refresh fails", async () => {
    await seedAdmin(testAdmin.owner);

    const before = await countRows(handle, "refresh_sessions");

    await createAgent().post("/api/auth/refresh").expect(401);
    await createAgent()
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookieHeader("nope"))
      .expect(401);

    expect(await countRows(handle, "refresh_sessions")).toBe(before);
  });
});

