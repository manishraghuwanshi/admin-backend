import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { setDbOverride, type AppDatabase } from "../db/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/db.js";
import { createTestApp, dataOf, errorOf } from "./helpers/api.js";
import { TEST_ALLOWED_ORIGIN } from "./helpers/env.js";

/**
 * Liveness and readiness.
 *
 * `/ready` is the endpoint an orchestrator gates traffic on, and the one place where
 * the rules in `health.service.ts` matter: a storage outage must *not* remove a
 * healthy instance from rotation, an unreachable database must, and neither answer
 * may leak a connection string - a driver's own failure message routinely contains
 * one, which is why the response carries only booleans and labels.
 *
 * Object Storage is stubbed, as it is in the image suites: the test environment has
 * no credentials, so `isStorageConfigured()` would otherwise be permanently false and
 * the storage branches unreachable.
 */

let storageConfigured = false;
let headBehaviour: "found" | "missing" | "outage" = "found";

vi.mock("../lib/storage/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage/s3.js")>();

  return {
    ...actual,
    isStorageConfigured: () => storageConfigured,
    getS3Client: () => ({
      send: async () => {
        if (headBehaviour === "missing") {
          throw Object.assign(new Error("NotFound"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }

        if (headBehaviour === "outage") {
          throw Object.assign(new Error("Request failed"), {
            $metadata: { httpStatusCode: 503 },
          });
        }

        return {};
      },
    }),
  };
});

const readiness = (app: Express, origin = "https://evil.example.com") =>
  request(app).get("/ready").set("Origin", origin);

interface Report {
  ready: boolean;
  database: string;
  storage: string;
  branch?: string;
}

let handle: TestDatabase;
let workingDb: AppDatabase;

beforeAll(async () => {
  handle = await createTestDatabase();
  workingDb = handle.db;
});

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  storageConfigured = false;
  headBehaviour = "found";
  setDbOverride(workingDb);
});

describe("readiness", () => {
  it("reports ready when the database answers", async () => {
    const res = await readiness(createTestApp());

    expect(res.status).toBe(200);
    expect(dataOf<Report>(res)).toMatchObject({ ready: true, database: "ok", storage: "not-configured" });
  });

  it("takes a storage outage out of the storage field only, not out of rotation", async () => {
    // Object Storage is not required to serve traffic: catalog and auth work without
    // a bucket. Pulling the instance out of rotation because image uploads are down
    // would take down endpoints that are perfectly healthy.
    storageConfigured = true;
    headBehaviour = "outage";

    const res = await readiness(createTestApp());

    expect(res.status).toBe(200);
    expect(dataOf<Report>(res)).toMatchObject({ ready: true, database: "ok", storage: "unavailable" });
  });

  it("counts a 404 from the probe key as a healthy bucket", async () => {
    // The probe names a key this application never writes. A `NoSuchKey` is the
    // expected answer and still proves endpoint, credentials, and bucket resolve.
    storageConfigured = true;
    headBehaviour = "missing";

    const res = await readiness(createTestApp());

    expect(res.status).toBe(200);
    expect(dataOf<Report>(res)).toMatchObject({ ready: true, storage: "ok" });
  });

  it("reports 503 with per-dependency details when the database does not answer", async () => {
    setDbOverride({
      ...workingDb,
      execute: async () => {
        throw new Error("connection refused to postgres://user:hunter2@10.0.0.1:5432/prod");
      },
    } as unknown as AppDatabase);

    const res = await readiness(createTestApp());

    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("SERVICE_UNAVAILABLE");
    expect(errorOf(res).message).toBe("Service is not ready");

    const details = (res.body as { error?: { details?: Report } }).error?.details;

    expect(details).toMatchObject({ ready: false, database: "unavailable" });
  });

  it("never echoes a dependency error, a connection string, or a bucket name", async () => {
    setDbOverride({
      ...workingDb,
      execute: async () => {
        throw new Error("connection refused to postgres://user:hunter2@10.0.0.1:5432/prod");
      },
    } as unknown as AppDatabase);

    const res = await readiness(createTestApp());
    const text = JSON.stringify(res.body);

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("10.0.0.1");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("connection refused");
    expect(text).not.toContain("product-images");
  });

  it("stays reachable from any origin and without credentials", async () => {
    // Mounted outside `/api`, so it is neither CSRF-guarded nor authenticated. A
    // load balancer cannot send a same-site Origin, and it has no cookies.
    const app = createTestApp();

    expect((await readiness(app)).status).toBe(200);
    expect((await readiness(app, TEST_ALLOWED_ORIGIN)).status).toBe(200);
    expect((await request(app).get("/ready")).status).toBe(200);
  });

  it("keeps /health free of dependency checks so an outage cannot cause restarts", async () => {
    setDbOverride({
      ...workingDb,
      execute: async () => {
        throw new Error("database down");
      },
    } as unknown as AppDatabase);

    const app = createTestApp();

    expect((await request(app).get("/health")).status).toBe(200);
    expect((await readiness(app)).status).toBe(503);
  });

  it("omits the branch label unless NEON_BRANCH is configured", async () => {
    // The test environment strips NEON_BRANCH (see helpers/env.ts) so a real branch
    // name can never appear in a test run; the field is asserted absent.
    const res = await readiness(createTestApp());

    expect(dataOf<Report>(res).branch).toBeUndefined();
  });
});

