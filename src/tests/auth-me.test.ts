import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers, refreshSessions } from "../db/schema.js";
import { signAccessToken } from "../lib/auth/tokens.js";
import { clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, dataOf, errorOf, login } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, seedAdmin, seedRefreshSession, testAdmin } from "./helpers/seed.js";

const ACCESS_COOKIE = "admin_access_token";

/** Mint a token that is structurally valid but references an arbitrary session. */
async function accessTokenFor(
  admin: typeof adminUsers.$inferSelect,
  sessionId: string,
): Promise<string> {
  return signAccessToken({
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    sid: sessionId,
  });
}

/**
 * `GET /api/auth/me` proves that `requireAuth` validates the signature, the
 * session row, its expiry, its revocation state, and the user's active flag.
 */
describe("auth: /me and access-token validation", () => {
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

  it("returns the profile for a logged-in admin", async () => {
    const admin = await seedAdmin(testAdmin.manager);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const res = await agent.get("/api/auth/me").expect(200);

    expect(dataOf(res)).toMatchObject({ id: admin.id, role: "manager" });
    expect((dataOf(res) as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("rejects anonymous requests and unrelated cookies", async () => {
    await createAgent().get("/api/auth/me").expect(401);
    await createAgent().get("/api/auth/me").set("Cookie", "other=1").expect(401);
  });

  it("rejects a malformed access token", async () => {
    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=garbage`);

    expect(res.status).toBe(401);
    expect(errorOf(res).message).toBe("Invalid or expired session");
  });

  it("rejects a token signed with a different secret", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const foreign = await new SignJWT({ email: admin.email, role: "owner", sid: admin.id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(admin.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-completely-different-secret-value-32"));

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${foreign}`);

    expect(res.status).toBe(401);
  });

  it("rejects an expired token even though its session is still valid", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const { session } = await seedRefreshSession(admin.id);
    const expired = await new SignJWT({ email: admin.email, role: admin.role, sid: session.id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(admin.id)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.AUTH_ACCESS_TOKEN_SECRET!));

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${expired}`);

    expect(res.status).toBe(401);
  });

  it("rejects a valid signature whose session row does not exist", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const token = await accessTokenFor(admin, "00000000-0000-4000-8000-000000000000");

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${token}`);

    expect(res.status).toBe(401);
  });

  it("rejects a session belonging to a different admin", async () => {
    const victim = await seedAdmin(testAdmin.owner);
    const attacker = await seedAdmin(testAdmin.editor);
    const { session } = await seedRefreshSession(attacker.id);
    const token = await accessTokenFor(victim, session.id);

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${token}`);

    expect(res.status).toBe(401);
  });

  it("rejects a revoked session", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const { session } = await seedRefreshSession(admin.id);
    const token = await accessTokenFor(admin, session.id);

    await db
      .update(refreshSessions)
      .set({ revokedAt: new Date() })
      .where(eq(refreshSessions.id, session.id));

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${token}`);

    expect(res.status).toBe(401);
  });

  it("rejects a session past its expiry", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const { session } = await seedRefreshSession(admin.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const token = await accessTokenFor(admin, session.id);

    const res = await createAgent().get("/api/auth/me").set("Cookie", `${ACCESS_COOKIE}=${token}`);

    expect(res.status).toBe(401);
  });

  it("rejects a deactivated admin mid-session", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });
    await agent.get("/api/auth/me").expect(200);

    await db.update(adminUsers).set({ isActive: false }).where(eq(adminUsers.id, admin.id));
    await agent.get("/api/auth/me").expect(401);
  });

  it("reflects profile changes without re-authentication", async () => {
    const admin = await seedAdmin(testAdmin.editor);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    await db.update(adminUsers).set({ name: "Renamed" }).where(eq(adminUsers.id, admin.id));

    const res = await agent.get("/api/auth/me").expect(200);

    expect(dataOf<Record<string, unknown>>(res).name).toBe("Renamed");
  });
});
