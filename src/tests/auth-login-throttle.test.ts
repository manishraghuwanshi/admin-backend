import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers } from "../db/schema.js";
import {
  applyFailedAttempt,
  evaluateLoginThrottle,
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILED_ATTEMPTS,
  LOGIN_MIN_INTERVAL_MS,
  secondsUntil,
} from "../lib/auth/login-throttle.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createAgent, errorOf, login } from "./helpers/api.js";
import { DEFAULT_ADMIN_PASSWORD, findAuditRows, seedAdmin, testAdmin } from "./helpers/seed.js";

/**
 * Per-account login throttling.
 *
 * The account-scoped state is what these tests are about: it must slow repeated
 * failures, lock the account after five of them, refuse a locked account without
 * ever verifying the password, and clear itself on success. The integration cases
 * go through the real endpoint so the `UPDATE ... RETURNING` arithmetic is executed
 * by the database rather than asserted on a JavaScript reimplementation of it.
 *
 * The cooldown is a real 5-second wall-clock window, so a test that needs several
 * consecutive failures without waiting ages the stored `last_failed_login_at` row
 * forward. That is the same correction an operator would apply when reconciling a
 * legitimate lockout, and it keeps the suite fast without faking timers globally.
 */

const WRONG_PASSWORD = "WrongPassword123";

/** A fresh client per attempt, so nothing is explained by a shared cookie jar. */
function attempt(email: string, password: string) {
  return createAgent().post("/api/auth/login").send({ email, password });
}

async function throttleState(adminUserId: string) {
  const [row] = await db
    .select({
      failedLoginAttempts: adminUsers.failedLoginAttempts,
      lastFailedLoginAt: adminUsers.lastFailedLoginAt,
      lockedUntil: adminUsers.lockedUntil,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId));

  return row!;
}

/** Make the previous failure look old enough that the 5-second interval has passed. */
async function ageLastFailure(adminUserId: string, offsetMs = 60_000): Promise<void> {
  await db
    .update(adminUsers)
    .set({ lastFailedLoginAt: new Date(Date.now() - offsetMs) })
    .where(eq(adminUsers.id, adminUserId));
}

/** Simulate the whole lockout window elapsing, without waiting 15 minutes. */
async function expireLock(adminUserId: string): Promise<void> {
  await db
    .update(adminUsers)
    .set({
      lockedUntil: new Date(Date.now() - 1_000),
      // A real 15-minute lockout implies the failure that tripped it is at least
      // that old, so the short interval from it has passed too.
      lastFailedLoginAt: new Date(Date.now() - LOGIN_LOCKOUT_MS),
    })
    .where(eq(adminUsers.id, adminUserId));
}

/** Seed a row that is one failure away from locking. */
async function seedAlmostLocked(adminUserId: string): Promise<void> {
  await db
    .update(adminUsers)
    .set({
      failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1,
      lastFailedLoginAt: new Date(Date.now() - 60_000),
    })
    .where(eq(adminUsers.id, adminUserId));
}

const reasonsOf = (rows: Awaited<ReturnType<typeof findAuditRows>>) =>
  rows.map((row) => (row.metadata as { reason: string }).reason);

describe("auth: login throttling", () => {
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

  it("increments the failure counter and stamps the attempt time", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    const res = await attempt(admin.email, WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(errorOf(res).message).toBe("Invalid email or password");

    const state = await throttleState(admin.id);

    expect(state.failedLoginAttempts).toBe(1);
    expect(state.lastFailedLoginAt).toBeInstanceOf(Date);
    expect(state.lockedUntil).toBeNull();

    // The failure is still audited exactly as before, plus the counter.
    const [row] = await findAuditRows("auth.login_failed");

    expect(row!.actorId).toBe(admin.id);
    expect(row!.metadata).toMatchObject({ reason: "bad_password", failedLoginAttempts: 1 });
    expect(JSON.stringify(row!.metadata)).not.toContain(WRONG_PASSWORD);
  });

  it("refuses a second attempt inside the interval without verifying the password", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    expect((await attempt(admin.email, WRONG_PASSWORD)).status).toBe(401);

    // The correct password on purpose: a 429 here can only mean the request was
    // rejected before Argon2 ran, because a verified password would have been a 200.
    const throttled = await attempt(admin.email, DEFAULT_ADMIN_PASSWORD);

    expect(throttled.status).toBe(429);
    expect(errorOf(throttled).code).toBe("TOO_MANY_REQUESTS");
    expect(errorOf(throttled).message).toBe("Too many login attempts. Try again later.");

    const retryAfter = Number(throttled.headers["retry-after"]);

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(LOGIN_MIN_INTERVAL_MS / 1000);

    expect(await countRows(handle, "refresh_sessions")).toBe(0);

    // A refused attempt must not advance the counter, or the interval itself would
    // become a way to trip the lockout.
    expect((await throttleState(admin.id)).failedLoginAttempts).toBe(1);

    expect(reasonsOf(await findAuditRows("auth.login_failed")).sort()).toEqual([
      "bad_password",
      "rate_limited",
    ]);
  });

  it("locks the account on the fifth consecutive failure and restarts the counter", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    for (let n = 1; n <= LOGIN_MAX_FAILED_ATTEMPTS - 1; n += 1) {
      const res = await attempt(admin.email, WRONG_PASSWORD);

      expect(res.status, `attempt ${n}`).toBe(401);
      expect((await throttleState(admin.id)).failedLoginAttempts).toBe(n);

      // Wait out the interval rather than skip it, so the sequence is honest.
      await ageLastFailure(admin.id);
    }

    const locking = await attempt(admin.email, WRONG_PASSWORD);

    expect(locking.status).toBe(401);

    const state = await throttleState(admin.id);

    expect(state.failedLoginAttempts).toBe(0);
    expect(state.lockedUntil).toBeInstanceOf(Date);
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(state.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + LOGIN_LOCKOUT_MS);
  });

  it("refuses a locked account even when the password is correct", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    await seedAlmostLocked(admin.id);
    expect((await attempt(admin.email, WRONG_PASSWORD)).status).toBe(401);

    const locked = await attempt(admin.email, DEFAULT_ADMIN_PASSWORD);

    expect(locked.status).toBe(429);
    expect(errorOf(locked).code).toBe("TOO_MANY_REQUESTS");
    // The lock is what is being reported, not a 5-second interval.
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(LOGIN_MIN_INTERVAL_MS / 1000);

    expect(await countRows(handle, "refresh_sessions")).toBe(0);
    expect(await findAuditRows("auth.login")).toHaveLength(0);
    expect(reasonsOf(await findAuditRows("auth.login_failed"))).toContain("locked");
  });

  it("allows login once the lockout has expired and starts a fresh sequence", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    await seedAlmostLocked(admin.id);
    expect((await attempt(admin.email, WRONG_PASSWORD)).status).toBe(401);

    await expireLock(admin.id);

    const res = await login(createAgent(), {
      email: admin.email,
      password: DEFAULT_ADMIN_PASSWORD,
    });

    expect(res.body.success).toBe(true);

    const state = await throttleState(admin.id);

    expect(state.failedLoginAttempts).toBe(0);
    expect(state.lockedUntil).toBeNull();

    // The next failure starts from 1, not from the threshold, so an expired lock
    // does not re-trip on the first mistake.
    expect((await attempt(admin.email, WRONG_PASSWORD)).status).toBe(401);
    expect((await throttleState(admin.id)).failedLoginAttempts).toBe(1);
  });

  it("clears the counter on a successful login", async () => {
    const admin = await seedAdmin(testAdmin.owner);

    await db
      .update(adminUsers)
      .set({ failedLoginAttempts: 3, lastFailedLoginAt: new Date(Date.now() - 60_000) })
      .where(eq(adminUsers.id, admin.id));

    expect((await attempt(admin.email, WRONG_PASSWORD)).status).toBe(401);
    expect((await throttleState(admin.id)).failedLoginAttempts).toBe(4);

    await ageLastFailure(admin.id);
    await login(createAgent(), { email: admin.email, password: DEFAULT_ADMIN_PASSWORD });

    const state = await throttleState(admin.id);

    expect(state.failedLoginAttempts).toBe(0);
    expect(state.lockedUntil).toBeNull();
  });

  it("keeps the throttle state per account", async () => {
    const victim = await seedAdmin(testAdmin.owner);
    const other = await seedAdmin(testAdmin.manager);

    expect((await attempt(victim.email, WRONG_PASSWORD)).status).toBe(401);

    // A different account is untouched by the victim's failure.
    await login(createAgent(), { email: other.email, password: DEFAULT_ADMIN_PASSWORD });

    expect((await throttleState(victim.id)).failedLoginAttempts).toBe(1);
    expect((await throttleState(other.id)).failedLoginAttempts).toBe(0);
  });

  it("does not throttle an unknown or deactivated account", async () => {
    const disabled = await seedAdmin({ ...testAdmin.owner, isActive: false });

    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS + 2; i += 1) {
      expect((await attempt("ghost@example.test", DEFAULT_ADMIN_PASSWORD)).status).toBe(401);
      expect((await attempt(disabled.email, DEFAULT_ADMIN_PASSWORD)).status).toBe(401);
    }

    // Nothing to store and nothing to leak: neither email is a real, active account.
    const state = await throttleState(disabled.id);

    expect(state.failedLoginAttempts).toBe(0);
    expect(state.lastFailedLoginAt).toBeNull();
    expect(state.lockedUntil).toBeNull();
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });
});

describe("auth: login throttle decision logic", () => {
  const base = { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null };

  it("allows the first attempt", () => {
    expect(evaluateLoginThrottle(base)).toEqual({ allowed: true });
  });

  it("allows an attempt once the interval has passed", () => {
    const now = Date.now();

    expect(
      evaluateLoginThrottle(
        { ...base, lastFailedLoginAt: new Date(now - LOGIN_MIN_INTERVAL_MS) },
        now,
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses an attempt inside the interval and reports the remaining time", () => {
    const now = Date.now();
    const decision = evaluateLoginThrottle(
      { ...base, lastFailedLoginAt: new Date(now - 1_000) },
      now,
    );

    expect(decision).toEqual({ allowed: false, reason: "rate_limited", retryAfterSeconds: 4 });
  });

  it("lets an active lock outrank the interval", () => {
    const now = Date.now();
    const lockedUntil = new Date(now + 10 * 60 * 1000);
    const decision = evaluateLoginThrottle(
      { ...base, lastFailedLoginAt: new Date(now - 1_000), lockedUntil },
      now,
    );

    expect(decision.allowed).toBe(false);

    if (!decision.allowed) {
      expect(decision.reason).toBe("locked");
      expect(decision.retryAfterSeconds).toBe(600);
    }

    // A lock that already passed no longer refuses anything.
    expect(evaluateLoginThrottle({ ...base, lockedUntil: new Date(now - 1) }, now)).toEqual({
      allowed: true,
    });
  });

  it("counts up to the threshold, then locks and resets", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const first = applyFailedAttempt({ ...base, failedLoginAttempts: 0 }, now);

    expect(first).toEqual({ failedLoginAttempts: 1, lockedUntil: null, locked: false });

    const penultimate = applyFailedAttempt(
      {
        failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 2,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
      now,
    );

    expect(penultimate.locked).toBe(false);
    expect(penultimate.failedLoginAttempts).toBe(LOGIN_MAX_FAILED_ATTEMPTS - 1);

    const locking = applyFailedAttempt(
      {
        failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
      now,
    );

    expect(locking.locked).toBe(true);
    expect(locking.failedLoginAttempts).toBe(0);
    expect(locking.lockedUntil!.getTime()).toBe(now.getTime() + LOGIN_LOCKOUT_MS);
  });

  it("never reports a negative wait", () => {
    const now = Date.now();

    expect(secondsUntil(new Date(now - 5_000), now)).toBe(0);
    expect(secondsUntil(new Date(now), now)).toBe(0);
    expect(secondsUntil(new Date(now + 1), now)).toBe(1);
  });
});