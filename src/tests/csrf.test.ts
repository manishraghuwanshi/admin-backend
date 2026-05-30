import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  accessCookieHeader,
  createAgent,
  createCrossSiteAgent,
  createOriginlessAgent,
  errorOf,
  login,
  readAuthCookies,
} from "./helpers/api.js";
import { TEST_ALLOWED_ORIGIN } from "./helpers/env.js";
import { DEFAULT_ADMIN_PASSWORD, seedAdmin, testAdmin } from "./helpers/seed.js";

/**
 * CSRF origin protection mounted on `/api`.
 *
 * State-changing, cookie-authenticated requests must carry an allow-listed
 * `Origin`; requests with no `Origin` at all (curl, server-to-server) stay
 * allowed, and safe methods are never gated.
 */
describe("csrf: origin check", () => {
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

  it("rejects a cross-origin login before authentication is even attempted", async () => {
    await seedAdmin(testAdmin.owner);

    const res = await createCrossSiteAgent()
      .post("/api/auth/login")
      .send({ email: testAdmin.owner.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("CSRF_REJECTED");
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });

  it("rejects a cross-origin logout, so a foreign page cannot force a sign-out", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    const tokens = readAuthCookies(
      await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD }),
    );

    // A hostile page cannot read the victim's cookies, but it can make the
    // browser send them; the Origin check is what stops the forged POST.
    const forged = await createCrossSiteAgent()
      .post("/api/auth/logout")
      .set("Cookie", accessCookieHeader(tokens.accessToken));

    expect(forged.status).toBe(403);
    expect(errorOf(forged).code).toBe("CSRF_REJECTED");

    // Only the successful login was audited; the rejected request left no trace.
    expect(await countRows(handle, "audit_logs")).toBe(1);
    expect(await countRows(handle, "refresh_sessions")).toBe(1);
  });

  it("rejects a cross-origin refresh", async () => {
    const res = await createCrossSiteAgent().post("/api/auth/refresh");

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("CSRF_REJECTED");
  });

  it("rejects a cross-origin catalog mutation", async () => {
    const admin = await seedAdmin(testAdmin.owner);
    const agent = createAgent();

    await login(agent, { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const res = await createCrossSiteAgent()
      .post("/api/brands")
      .send({ name: "Forged Brand", slug: "forged-brand" });

    expect(res.status).toBe(403);
    expect(await countRows(handle, "brands")).toBe(0);
  });

  it("allows the origin configured through CORS_ORIGINS", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    const res = await createOriginlessAgent()
      .post("/api/auth/login")
      .set("Origin", TEST_ALLOWED_ORIGIN)
      .send({ email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
  });

  it("allows any localhost origin outside production", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    const res = await createOriginlessAgent()
      .post("/api/auth/login")
      .set("Origin", "http://127.0.0.1:4173")
      .send({ email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
  });

  it("allows requests with no Origin header (curl, server-to-server)", async () => {
    await seedAdmin(testAdmin.editor);

    const res = await createOriginlessAgent()
      .post("/api/auth/login")
      .send({ email: testAdmin.editor.email, password: DEFAULT_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
  });

  it("never gates safe methods", async () => {
    await seedAdmin(testAdmin.owner);

    const anonymousRead = await createCrossSiteAgent().get("/api/auth/me");

    // Authenticated-with-nothing, not blocked-by-CSRF.
    expect(anonymousRead.status).toBe(401);
    expect(errorOf(anonymousRead).code).toBe("UNAUTHORIZED");

    const agent = createAgent();

    const tokens = readAuthCookies(
      await login(agent, { email: testAdmin.owner.email, password: DEFAULT_ADMIN_PASSWORD }),
    );

    const authorisedRead = await createOriginlessAgent()
      .get("/api/brands")
      .set("Cookie", accessCookieHeader(tokens.accessToken));

    expect(authorisedRead.status).toBe(200);
  });

  it("leaves /health outside the /api CSRF guard", async () => {
    const res = await createOriginlessAgent().get("/health").expect(200);

    expect(res.body).toMatchObject({ success: true });
  });
});
