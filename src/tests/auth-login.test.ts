import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers, refreshSessions } from "../db/schema.js";
import { hashRefreshToken } from "../lib/auth/tokens.js";
import { countRows, clearTestData, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, errorOf, login, readAuthCookies } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, findAuditRows, seedAdmin, testAdmin } from "./helpers/seed.js";

/**
 * `POST /api/auth/login`: the cookie contract, the deliberately generic failure
 * messages, and the audit events the security rules require.
 */
describe("auth: login", () => {
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

  it("issues httpOnly auth cookies and a credential-free profile", async () => {
    await seedAdmin(testAdmin.owner);

    const res = await login(createAgent(), {
      email: testAdmin.owner.email,
      password: DEFAULT_ADMIN_PASSWORD,
    });

    expect(res.body.success).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(DEFAULT_ADMIN_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("argon2");
    expect(res.body.data).toMatchObject({ email: testAdmin.owner.email, role: "owner" });
    expect(res.body.data.passwordHash).toBeUndefined();

    const cookies = readAuthCookies(res);

    expect(cookies.accessToken.split(".")).toHaveLength(3);
    expect(cookies.refreshToken).toHaveLength(64);

    const setCookies = res.headers["set-cookie"] as unknown as string[];

    expect(setCookies.length).toBeGreaterThanOrEqual(2);

    for (const cookie of setCookies) {
      expect(cookie).toMatch(/httponly/i);
      // Non-production + SameSite=lax must not be flagged Secure: a Secure
      // cookie would be dropped by clients on the plain-http test server.
      expect(cookie).not.toMatch(/;\s*secure/i);
    }
  });

  it("persists only hashes: Argon2 for the password, SHA-256 for the refresh token", async () => {
    await seedAdmin(testAdmin.manager);

    const res = await login(createAgent(), {
      email: testAdmin.manager.email,
      password: DEFAULT_ADMIN_PASSWORD,
    });

    const { refreshToken } = readAuthCookies(res);
    const [user] = await db.select().from(adminUsers);

    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(DEFAULT_ADMIN_PASSWORD);
    expect(user.lastLoginAt).toBeInstanceOf(Date);

    const [session] = await db.select().from(refreshSessions);

    expect(session.tokenHash).toBe(hashRefreshToken(refreshToken));
    expect(session.tokenHash).toHaveLength(64);
    expect(session.revokedAt).toBeNull();
  });

  it("treats the email case-insensitively", async () => {
    await seedAdmin(testAdmin.editor);

    await login(createAgent(), { email: "EDITOR@Example.TEST", password: DEFAULT_ADMIN_PASSWORD });
  });

  it("rejects an unknown email with the generic message", async () => {
    await seedAdmin(testAdmin.owner);

    const res = await createAgent()
      .post("/api/auth/login")
      .send({ email: "ghost@example.test", password: DEFAULT_ADMIN_PASSWORD });

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHORIZED");
    expect(errorOf(res).message).toBe("Invalid email or password");
  });

  it("rejects a wrong password with the same generic message", async () => {
    await seedAdmin(testAdmin.owner);

    const res = await createAgent()
      .post("/api/auth/login")
      .send({ email: testAdmin.owner.email, password: "WrongPassword123" });

    expect(res.status).toBe(401);
    expect(errorOf(res).message).toBe("Invalid email or password");
    expect(JSON.stringify(res.body)).not.toContain("WrongPassword123");
  });

  it("does not leak that a deactivated account exists", async () => {
    await seedAdmin({ ...testAdmin.owner, isActive: false });

    const wrongPassword = await createAgent()
      .post("/api/auth/login")
      .send({ email: testAdmin.owner.email, password: "WrongPassword123" });

    const rightPassword = await createAgent()
      .post("/api/auth/login")
      .send({ email: testAdmin.owner.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(rightPassword.status).toBe(401);
    // Compare the error envelope, not the per-request `requestId`.
    expect(errorOf(rightPassword)).toEqual(errorOf(wrongPassword));
    expect(errorOf(rightPassword).message).toBe("Invalid email or password");
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });

  it("audits every failure outcome without recording credentials", async () => {
    const disabled = await seedAdmin({ ...testAdmin.owner, isActive: false });
    const active = await seedAdmin(testAdmin.manager);

    await createAgent()
      .post("/api/auth/login")
      .send({ email: "ghost@example.test", password: DEFAULT_ADMIN_PASSWORD })
      .expect(401);

    await createAgent()
      .post("/api/auth/login")
      .send({ email: disabled.email, password: DEFAULT_ADMIN_PASSWORD })
      .expect(401);

    await createAgent()
      .post("/api/auth/login")
      .send({ email: active.email, password: "WrongPassword123" })
      .expect(401);

    const rows = await findAuditRows("auth.login_failed");
    const byReason = new Map(rows.map((row) => [(row.metadata as { reason: string }).reason, row]));

    expect([...byReason.keys()].sort()).toEqual(["bad_password", "disabled", "unknown_user"]);
    // Only `bad_password` proves the account exists to the caller, so only that
    // path associates an actor; the other two stay unattributed while still
    // recording the targeted row through entityId.
    expect(byReason.get("unknown_user")?.actorId).toBeNull();
    expect(byReason.get("unknown_user")?.entityId).toBeNull();
    expect(byReason.get("disabled")?.actorId).toBeNull();
    expect(byReason.get("disabled")?.entityId).toBe(disabled.id);
    expect(byReason.get("bad_password")?.actorId).toBe(active.id);
    expect(JSON.stringify([...byReason.values()])).not.toContain("WrongPassword123");
  });

  it("audits a successful login and opens exactly one session", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    await login(createAgent(), { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const [row] = await findAuditRows("auth.login");

    expect(row.actorId).toBe(admin.id);
    expect(row.entityType).toBe("admin_user");
    expect(row.entityId).toBe(admin.id);
    expect(await countRows(handle, "refresh_sessions")).toBe(1);
  });

  it("rejects malformed credentials before touching the database", async () => {
    await seedAdmin(testAdmin.owner);

    const auditBefore = await countRows(handle, "audit_logs");

    const invalidBodies: Array<Record<string, unknown>> = [
      { email: "not-an-email", password: DEFAULT_ADMIN_PASSWORD },
      { email: testAdmin.owner.email },
      { email: testAdmin.owner.email, password: "" },
      { email: 42, password: DEFAULT_ADMIN_PASSWORD },
    ];

    for (const body of invalidBodies) {
      const res = await createAgent().post("/api/auth/login").send(body);

      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    }

    expect(await countRows(handle, "audit_logs")).toBe(auditBefore);
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });

  it("rejects a body that is not an object", async () => {
    const res = await createAgent()
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(["nope"]));

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
  });

  it("keeps one session row per login so revocation stays per-device", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });
    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const sessions = await db
      .select({ id: refreshSessions.id })
      .from(refreshSessions)
      .where(eq(refreshSessions.adminUserId, admin.id));

    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
  });
});
