import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.js";
import { adminUsers, auditLogs } from "../db/schema.js";
import { verifyPassword } from "../lib/auth/password.js";
import { bootstrapOwner, maskEmail } from "../scripts/bootstrap-owner.js";
import { cleanupSessions } from "../scripts/cleanup-sessions.js";
import { clearTestData, countRows, createTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  DEFAULT_ADMIN_PASSWORD,
  findAuditRows,
  seedAdmin,
  seedRefreshSession,
  testAdmin,
} from "./helpers/seed.js";

/**
 * The operational scripts: `pnpm bootstrap:owner` and `pnpm cleanup:sessions`.
 *
 * These are the only code paths that insert an administrator without an
 * authenticated caller and the only ones that delete rows on a schedule, so the
 * rules they encode - no-op once seeded, credentials from the environment only,
 * refuse rather than half-run, dry-run by default, and never touch `audit_logs` -
 * are asserted here instead of being left to a manual pass.
 *
 * What makes them testable is the `isDirectExecution` guard in
 * `src/scripts/lib/cli.ts`: each script keeps its body in an exported function and
 * only calls `runScript()` when it is the process entry point. Importing it here
 * therefore runs no `main()` and cannot mutate the database as a side effect of
 * import; every test drives the exported function explicitly. The database is the
 * throwaway PGlite instance, freshly migrated and cleared per test, and
 * `BOOTSTRAP_ADMIN_*` are managed per test so a real environment value can never
 * influence a run.
 */

const BOOTSTRAP_KEYS = [
  "BOOTSTRAP_ADMIN_EMAIL",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "BOOTSTRAP_ADMIN_NAME",
] as const;

/** Sets or clears the bootstrap variables; `undefined` removes the key entirely. */
function bootstrapEnv(
  values: Partial<Record<(typeof BOOTSTRAP_KEYS)[number], string | undefined>>,
): void {
  for (const key of BOOTSTRAP_KEYS) {
    const value = values[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const daysFromNow = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/** The stored row for an email, so assertions read what actually landed. */
async function adminByEmail(email: string) {
  const rows = await db.select().from(adminUsers);

  return rows.find((row) => row.email === email);
}

describe("scripts: bootstrap:owner", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    bootstrapEnv({});
  });

  afterEach(() => {
    bootstrapEnv({});
  });

  it("does not run merely because it was imported", async () => {
    // The guard's whole purpose: a test importing the module must not bootstrap an
    // owner, and any other importer must not either.
    expect(await countRows(handle, "admin_users")).toBe(0);
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });

  it("creates the first owner with a real hash and an actor-less audit event", async () => {
    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "First.Owner@Example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "SuperSecret123",
    });

    const result = await bootstrapOwner();

    expect(result).toMatchObject({ status: "created", role: "owner" });

    const row = await adminByEmail("first.owner@example.test");

    expect(row).toBeDefined();
    expect(row).toMatchObject({ role: "owner", isActive: true, name: "Platform Owner" });

    // The password is stored as an Argon2 hash that verifies, and its cleartext is
    // nowhere in the column.
    expect(row!.passwordHash).not.toContain("SuperSecret123");
    expect(await verifyPassword(row!.passwordHash, "SuperSecret123")).toBe(true);

    const [audit] = await findAuditRows("admin_user.bootstrap");

    expect(audit).toMatchObject({
      actorId: null,
      entityType: "admin_user",
      entityId: row!.id,
      metadata: { role: "owner", source: "bootstrap-script" },
    });
  });

  it("reports the created account only in masked form", async () => {
    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD,
    });

    const result = await bootstrapOwner();

    expect(result.maskedEmail).toBe("ow***@example.test");
    expect(result.maskedEmail).not.toContain("owner");
  });

  it("uses BOOTSTRAP_ADMIN_NAME when set and defaults it otherwise", async () => {
    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "named@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD,
      BOOTSTRAP_ADMIN_NAME: "  Ops Lead  ",
    });

    await bootstrapOwner();

    expect((await adminByEmail("named@example.test"))!.name).toBe("Ops Lead");
  });

  it("is a no-op once any administrator exists, leaving the existing account alone", async () => {
    const existing = await seedAdmin(testAdmin.owner);

    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "second.owner@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "AnotherSecret123",
    });

    const result = await bootstrapOwner();

    expect(result).toEqual({ status: "already-seeded" });
    expect(await countRows(handle, "admin_users")).toBe(1);

    // The pre-existing account is untouched and no second owner was minted.
    const stillThere = await adminByEmail(existing.email);

    expect(stillThere).toMatchObject({ id: existing.id, passwordHash: existing.passwordHash });
    expect(await adminByEmail("second.owner@example.test")).toBeUndefined();
    expect(await findAuditRows("admin_user.bootstrap")).toHaveLength(0);
  });

  it("refuses to run without credentials and writes nothing", async () => {
    await expect(bootstrapOwner()).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL is required/);

    bootstrapEnv({ BOOTSTRAP_ADMIN_EMAIL: "owner@example.test" });

    await expect(bootstrapOwner()).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD is required/);
    expect(await countRows(handle, "admin_users")).toBe(0);
  });

  it("rejects an invalid email or a weak password before touching the database", async () => {
    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "not-an-email",
      BOOTSTRAP_ADMIN_PASSWORD: "SuperSecret123",
    });

    await expect(bootstrapOwner()).rejects.toThrow(/not a valid email/);

    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "short1",
    });

    await expect(bootstrapOwner()).rejects.toThrow(/at least 10 characters/);

    bootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "alllettersonly",
    });

    await expect(bootstrapOwner()).rejects.toThrow(/at least one letter and one number/);
    expect(await countRows(handle, "admin_users")).toBe(0);
  });
});

describe("scripts: maskEmail", () => {
  it("keeps the domain and hides the local part", () => {
    expect(maskEmail("you@example.com")).toBe("yo*@example.com");
    expect(maskEmail("ab@example.com")).toBe("ab*@example.com");
    expect(maskEmail("a@example.com")).toBe("a*@example.com");
  });

  it("returns a placeholder for a value that is not an email", () => {
    expect(maskEmail("broken")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });
});

// __PART3__
describe("scripts: cleanup:sessions", () => {
  let handle: TestDatabase;
  let adminId: string;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await clearTestData(handle);
    adminId = (await seedAdmin(testAdmin.owner)).id;
  });

  it("reports what would go without deleting anything (dry-run is the default)", async () => {
    await seedRefreshSession(adminId, { revokedAt: daysAgo(40), expiresAt: daysAgo(35) });
    await seedRefreshSession(adminId, { revokedAt: daysAgo(40), expiresAt: daysAgo(35) });

    const result = await cleanupSessions();

    expect(result).toMatchObject({ apply: false, eligible: 2, removed: 0, retentionDays: 30 });
    expect(await countRows(handle, "refresh_sessions")).toBe(2);
  });

  it("removes a revoked session past retention when applied", async () => {
    await seedRefreshSession(adminId, { revokedAt: daysAgo(40), expiresAt: daysAgo(35) });

    const result = await cleanupSessions({ apply: true });

    expect(result).toMatchObject({ apply: true, eligible: 1, removed: 1 });
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });

  it("reports zero and deletes nothing when nothing is eligible", async () => {
    await seedRefreshSession(adminId, { expiresAt: daysFromNow(7) });

    const result = await cleanupSessions({ apply: true });

    expect(result).toMatchObject({ eligible: 0, removed: 0 });
    expect(await countRows(handle, "refresh_sessions")).toBe(1);
  });

  it("keeps an expired session inside the retention window", async () => {
    // Dead two minutes ago, but recent. A support investigation right after an
    // incident still needs to see it, which is why the cutoff is the retention
    // window and not simply "now".
    await seedRefreshSession(adminId, { expiresAt: new Date(Date.now() - 2 * 60 * 1000) });

    const result = await cleanupSessions({ apply: true });

    expect(result).toMatchObject({ eligible: 0, removed: 0 });
    expect(await countRows(handle, "refresh_sessions")).toBe(1);
  });

  it("keeps a live session and a revoked session that has not yet expired", async () => {
    await seedRefreshSession(adminId, { expiresAt: daysFromNow(7) });
    // Revoked long ago but valid until next month: not dead yet as far as the row
    // can prove, and only rows past the window in both senses are removed.
    await seedRefreshSession(adminId, { revokedAt: daysAgo(40), expiresAt: daysFromNow(30) });

    const result = await cleanupSessions({ apply: true });

    expect(result).toMatchObject({ eligible: 0, removed: 0 });
    expect(await countRows(handle, "refresh_sessions")).toBe(2);
  });

  it("never trims the audit log, even when sessions are removed", async () => {
    // The audit log is the security record; a retention policy for it is a
    // data-retention decision, not something this job may make on its own.
    await db
      .insert(auditLogs)
      .values({ action: "admin_user.bootstrap", entityType: "admin_user" });
    await seedRefreshSession(adminId, { revokedAt: daysAgo(40), expiresAt: daysAgo(35) });

    await cleanupSessions({ apply: true });

    expect(await countRows(handle, "audit_logs")).toBe(1);
    expect(await countRows(handle, "refresh_sessions")).toBe(0);
  });
});