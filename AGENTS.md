# AI Agent Instructions — Admin Backend

## 1. Project Overview

This project is the backend API for the administrative dashboard of a watch e-commerce application.

The overall project contains three independent applications:

* `admin-frontend` — React/Vite administrative dashboard
* `admin-backend` — Express/TypeScript API for administrative operations
* `customer-store` — future Next.js customer-facing application

This repository contains only `admin-backend`.

The backend is responsible for administrative authentication, authorization, audit events, product catalog management, inventory, and approved administrative operations.

Customer-facing commerce functionality is intentionally deferred.

---

## 2. Technology Stack

* Node.js
* pnpm
* TypeScript
* Express 5
* PostgreSQL
* Neon Serverless Postgres
* Drizzle ORM
* Drizzle Kit
* postgres.js
* Neon Object Storage
* `tsx`
* CORS
* dotenv
* Zod
* `jose`
* Argon2

The project uses ECMAScript modules.

---

## 3. Current Project Structure

The actual repository structure is authoritative. Inspect the real directory tree before making assumptions.

```text
admin-backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/            # env.ts, cors.ts
│   ├── db/                # index.ts, schema.ts, test-connection.ts
│   ├── lib/
│   │   ├── audit.ts
│   │   ├── auth/           # cookies.ts, password.ts, permissions.ts, tokens.ts
│   │   ├── inventory-lock.ts
│   │   └── storage/        # keys.ts, s3.ts, delete.ts
│   ├── middleware/         # auth, authorize, csrf, error-handler, not-found,
│   │                        # rate-limit, request-logger, security-headers, validate
│   ├── modules/
│   │   ├── admin-users/
│   │   ├── audit-logs/
│   │   ├── auth/
│   │   ├── brands/
│   │   ├── categories/
│   │   ├── health/         # liveness (/health) and readiness (/ready)
│   │   ├── inventory/
│   │   ├── product-images/
│   │   └── products/
│   ├── scripts/            # bootstrap-owner.ts, cleanup-sessions.ts, lib/cli.ts
│   ├── tests/              # *.test.ts, setup.ts, helpers/
│   ├── types/              # auth.ts, express.d.ts
│   └── utils/              # errors, http, logger, pagination, params, schemas
├── drizzle/
├── docs/
├── neon.ts
├── drizzle.config.ts
├── vitest.config.ts
├── tsconfig.json
├── tsconfig.tools.json
├── tsconfig.tests.json
├── package.json
├── pnpm-workspace.yaml
├── README.md
├── AGENTS.md
├── .env.example
└── .gitignore
```

Each module is a thin route file plus a service file (`<domain>.routes.ts`,
`<domain>.service.ts`). The route file wires middleware and validation; the service
file owns the Zod schemas, business rules, database access, audit recording, and the
response envelope. There is no separate controllers layer or repository layer.

Do not introduce additional architectural layers unless a concrete requirement justifies them.

---

## 4. Current Implementation Status

### Implemented

#### Application foundation

* Express 5 application
* `createApp()` application factory
* Separate server/listen lifecycle
* Environment validation
* CORS
* Security headers
* Request logging
* Request IDs
* Centralized error handling
* 404 handling
* JSON body limits
* Graceful shutdown
* Production error sanitization
* Liveness (`GET /health`, no I/O) and readiness (`GET /ready`, dependency probes)
  endpoints, mounted outside `/api` so they are neither CSRF-guarded nor authenticated

#### Authentication

* Admin login route
* Argon2 password hashing utilities
* JWT access-token implementation
* Refresh-token implementation
* Refresh-token persistence
* Refresh-token rotation
* Authentication middleware
* Active-user enforcement
* `/api/auth/me`
* `/api/auth/refresh`
* `/api/auth/logout`
* CSRF origin protection
* Authentication rate limiting
* Authentication failure audit events

#### Authorization

* `owner`
* `manager`
* `editor`
* Static permission model
* `requirePermission` (AND) and `requireAnyPermission` (OR) middleware
* Protected catalog routes

#### Administrator management

* `/api/admin-users` CRUD, owner-only via `adminUsers.manage`
* List pagination, role/active filters, search, sorting, per-row active session count
* Password set endpoint, which revokes every session of that administrator
* Self-lockout guards: cannot deactivate, demote, or delete your own account
* Last-active-owner guard: the final active owner cannot be removed from the pool
* Refresh-session listing and revocation per administrator
* Per-administrator audit trail
* `passwordHash` never selected by the module, so it cannot reach a response

#### Audit

* `audit_logs` table
* Audit event recording
* Sensitive metadata redaction
* Actor association
* Request metadata capture
* Audit failure isolation
* `/api/audit-logs` query API with filtering, pagination, and scope resolution
* `/api/audit-logs/actions` and `/api/audit-logs/entity/:type/:id`
* `auditLogs.read` (whole log) vs `auditLogs.readLimited` (own rows only)
* Audit-read rate limiting (`auditReadRateLimiter`, one budget per router rather than
  per route, so alternating endpoints cannot multiply it)

#### Catalog

* Brands CRUD
* Categories CRUD
* Parent/child category validation at application level
* Products CRUD
* Product/category relationships
* Watch details
* Nested inventory operations within products
* Product filtering
* Product pagination
* Product sorting
* Brand/category validation
* Product transactions
* Product read model with related data
* Signed image download URLs

#### Inventory

* Dedicated `/api/inventory` API (list, read, set, adjust)
* `inventory.read` and `inventory.write` enforcement
* Concurrency-safe updates: adjustments computed inside PostgreSQL under a row lock,
  so simultaneous writes both land instead of overwriting each other
* Reservation-fits-quantity and non-negative-quantity invariants

#### Product images

* Upload, list, read, update, delete
* Primary-image management and reordering
* Alt-text management
* Server-controlled object keys (`src/lib/storage/keys.ts`)
* Base64 decoding, size ceiling, and magic-byte content validation
* DB/Object Storage consistency handling, including orphan cleanup when the database
  write fails after the object was stored

#### Database

* Neon PostgreSQL
* Drizzle ORM
* Drizzle relations
* 10 current tables
* Current migrations applied
* Foreign keys
* Unique constraints
* Check constraints
* Indexes

#### Object Storage

* Private `product-images` bucket configuration
* S3-compatible client
* Storage connectivity
* Signed download URLs
* Object upload and deletion. Before any delete, the stored key is re-validated against
  the full expected format (`products/<productId>/<uuid>.<ext>`), so a hand-edited row
  cannot aim a delete at an arbitrary object in the shared bucket.
* Environment-only credentials

#### Operational scripts

* `pnpm bootstrap:owner` — creates the first owner; no-op once any administrator exists
* `pnpm cleanup:sessions` — purges dead refresh sessions past `SESSION_RETENTION_DAYS`
  (dry-run by default, `-- --apply` to delete)

Both keep their logic in an exported function behind an `isDirectExecution` guard
(`src/scripts/lib/cli.ts`), so importing a script from a test never executes it.

#### Testing

* Vitest + Supertest integration suites in `src/tests/`
* In-memory PGlite database with the real schema applied (`src/tests/helpers/db.ts`)
* Throwaway auth secrets and an inert `DATABASE_URL` per run, so tests need no `.env`
  and cannot reach the real database or bucket
* 282 tests across 18 files covering auth lifecycle, RBAC, CSRF, error handling,
  inventory concurrency, image upload and compensation, product-delete object cleanup,
  audit scoping, administrator-management invariants, readiness, and the operational
  CLI scripts

---

## 5. Current Implementation Gaps

Authentication, authorization, audit, catalog, inventory, product images, Object
Storage writes, administrator management, readiness, and the operational scripts are
implemented and covered by `pnpm test`. What remains is listed below.

### Remaining work

* Audit-log retention policy. `audit_logs` is the security record and is never trimmed
  by `cleanup:sessions`; a retention window needs a data-retention decision, not a cron line.
* CI.
* Further production hardening: broader rate limiting beyond the authentication and
  audit-log endpoints. The readiness probe now reports database reachability.
* A real-browser manual pass against Neon and the real bucket. Everything verified so
  far runs against in-memory PGlite with a mocked Object Storage client.

Linting is now configured (`eslint.config.mjs`, `pnpm lint` script) and passes.

### Logout

Fixed. `POST /api/auth/logout` is behind `requireAuth`
(`src/modules/auth/auth.routes.ts`) and is covered by `src/tests/auth-logout.test.ts`.

Do not redesign the token system for logout; the existing behaviour is verified.

### Product images

Implemented for the JSON/base64 upload path: upload, list, read, update, delete,
reorder, primary-image management, alt text, server-controlled keys, and DB/Object
Storage consistency handling including orphan cleanup.

Still absent:

* multipart/form-data upload
* presigned direct-to-bucket upload (see the body-limit note below)
* image dimension/aspect validation

### Object Storage

The write path is implemented: `putObject`, object deletion (each stored key is
re-validated against the full expected `products/<productId>/<uuid>.<ext>` format
before the delete is issued), MIME detection from magic bytes, decoded-size
enforcement, safe key generation, and path-traversal prevention.

Not implemented: presigned upload URLs.

`JSON_BODY_LIMIT` (default `100kb`) caps the raw JSON body, so it silently limits a
base64 image to roughly 75 KiB before `MAX_UPLOAD_BYTES` (default `5 MiB`) can apply.
Both must be raised together to accept larger images through the JSON endpoint —
see `README.md` → "Upload size limits". This is a documented configuration trap, not
a code defect, and it is deliberately not reconciled at startup.

### Testing

Automated integration tests exist: 282 tests across 18 files in `src/tests/`, run with
`pnpm test`. They need no `.env` and cannot reach the real database or bucket.

Gaps in coverage rather than absence of a suite:

* No coverage of multipart upload or presigned upload, because those paths do not exist.
* No coverage against real Neon/Postgres; PGlite is the engine under test.
* The CLI scripts are covered by `src/tests/scripts.test.ts`, which imports the exported
  functions behind each script's `isDirectExecution` guard rather than running `main()`.

---

## 6. Development Rules

Before modifying code:

1. Read `README.md`.
2. Read `docs/architecture.md`.
3. Read `docs/database.md`.
4. Read `docs/admin-permissions.md`.
5. Inspect the actual source tree.
6. Inspect existing routes, middleware, services, utilities, and database schema.
7. Check existing migrations before proposing schema changes.

Do not make unrelated changes.

Do not rebuild functionality that already exists.

Prefer focused changes that can be reviewed and verified independently.

Reuse existing utilities, error handling, validation, authentication, and database patterns where appropriate.

Never expose or print secrets from `.env`.

Do not initialize Git.

Do not run Git commands.

---

## 7. Database Rules

The database is Neon PostgreSQL.

Drizzle ORM is the database access layer.

Drizzle Kit manages migrations.

### Never

* reset the database
* drop the database
* truncate tables
* recreate existing tables
* delete existing migration files
* rewrite existing migration history
* destroy existing data
* create duplicate tables for existing entities
* apply destructive migrations without explicit approval

Preserve existing data.

When a schema change is genuinely required:

1. Explain why the schema change is necessary.
2. Update `src/db/schema.ts`.
3. Generate a new migration.
4. Review the generated SQL.
5. Apply only the approved migration.
6. Update `docs/database.md`.

Never silently create migrations as a side effect of unrelated work.

---

## 8. Customer-Commerce Scope

Do not implement customer-commerce functionality in this backend unless explicitly approved.

Do not create tables, routes, services, or migrations for:

* customers
* customer addresses
* carts
* cart items
* wishlists
* wishlist items
* orders
* order items
* payments
* payment transactions
* shipments
* coupons
* reviews

These features belong to the future customer-facing application.

---

## 9. Neon Object Storage Rules

Product images use Neon Object Storage.

The existing bucket is:

```text
product-images
```

The bucket is private.

Rules:

* store object keys in PostgreSQL, not image binaries
* keep credentials in environment variables
* never hardcode credentials
* never expose credentials in responses or logs
* do not change bucket permissions without explicit approval
* do not delete existing storage objects without explicit approval
* private objects should be exposed through controlled signed URLs or an approved secure flow
* validate uploaded content before storing it
* generate server-controlled object keys where upload functionality is implemented
* prevent path traversal and unsafe object names

---

## 10. Security Rules

* Authentication is enforced by the backend.
* Authorization is enforced by the backend.
* The frontend is never a security boundary.
* Never trust roles or permissions supplied by the client.
* Passwords must never be logged or stored in plaintext.
* Tokens must never be logged.
* Connection strings and API keys must never be logged.
* Error responses must not expose production internals.
* Mutating API routes must retain CSRF protection.
* Authentication failures should remain generic to clients.
* Uploaded files must be validated before storage.
* Private Object Storage content must not become publicly accessible accidentally.
* Do not weaken existing security middleware for development convenience.

---

## 11. Permission Source of Truth

The authoritative role/permission implementation is:

```text
src/lib/auth/permissions.ts
```

Do not infer the permission matrix from old documentation.

When making authorization changes:

1. inspect `permissions.ts`
2. inspect the relevant route
3. inspect authorization middleware
4. ensure the permission is actually enforced
5. update `docs/admin-permissions.md`

A permission existing in `permissions.ts` does not mean that a route currently enforces it.

---

## 12. Current Permission Enforcement

Every permission defined in `permissions.ts` is now enforced by a route.

Whether a denial case can exist at all depends on the role table: several
permissions are held by all three roles, so no authenticated administrator can be
shown a `403` for them, and only the granted path is assertable.

| Permission              | Enforced by                              | Denied to a role? | Route-level test      |
| ----------------------- | ---------------------------------------- | ----------------- | --------------------- |
| `products.read`         | Product read routes                      | no role lacks it  | none yet              |
| `products.write`        | Product create/update routes             | no role lacks it  | none yet              |
| `products.delete`       | Product delete route                     | `editor`          | allowed + denied      |
| `brands.manage`         | Brand routes                             | no role lacks it  | none yet              |
| `categories.manage`     | Category routes                          | no role lacks it  | none yet              |
| `images.manage`         | `/api/products/:productId/images` routes | no role lacks it  | granted path only     |
| `inventory.read`        | Inventory GET routes                     | no role lacks it  | granted path only     |
| `inventory.write`       | Inventory `PUT` and `adjust` routes      | `editor`          | allowed + denied      |
| `adminUsers.manage`     | All `/api/admin-users` routes            | `manager`, `editor` | allowed + denied    |
| `auditLogs.read`        | Audit-log routes, full-history scope     | `manager`, `editor` | allowed + denied    |
| `auditLogs.readLimited` | Audit-log routes, own-actor scope        | `editor`          | allowed + denied      |

The role → permission matrix itself is fully unit-tested in
`src/tests/permissions.test.ts`, including the pairs above that no route can
distinguish. `products.test.ts` asserts the `editor` → `403` case for `products.delete`
over HTTP, and `brands.test.ts` / `categories.test.ts` cover the catalog CRUD routes,
so the request/deny matrix is now exercised at the route level wherever a role
difference exists.

`auditLogs.read` and `auditLogs.readLimited` reach the same routes through
`requireAnyPermission`; which scope applies is resolved inside the service from the
caller's server-side role.

Some safety rules are deliberately *not* permissions, because a permission says a
caller may perform a class of operation and says nothing about whether one specific
mutation is safe:

* the self-lockout and last-active-owner guards in administrator management
* the reservation-fits-quantity and non-negative-quantity rules in inventory
* the stored-key revalidation before any Object Storage delete

Do not add fake enforcement to nonexistent APIs, and do not express the above rules
as new permissions.

---

## 13. API Conventions

Current API conventions include:

### Success

```json
{
  "success": true,
  "data": {}
}
```

Paginated resources may include:

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

### Error

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  },
  "requestId": "request-id"
}
```

Follow existing response/error conventions unless a deliberate contract change is approved.

Do not silently introduce a third response convention.

---

## 14. Implementation Order

Phases 0 through 5 are complete and verified by `pnpm test` (282 tests, 18 files):

* Phase 0 — authenticated logout fixed, `.env.example` completed, README / agent /
  permission documentation synchronized.
* Phase 1 — first-admin bootstrap script, plus automated verification of login, `/me`,
  refresh rotation, replay protection, logout, audit events, cookie behaviour, and RBAC.
* Phase 2 — Vitest + Supertest + PGlite test architecture and the regression suites.
* Phase 3 — administrator management, including listing, creation, updates, role
  changes, activation, password management, session revocation, owner-protection rules,
  auditing of admin mutations, and permissions exposed in `/api/auth/me`.
* Phase 4 — Object Storage and product images: safe key generation, upload flow, file
  validation, image CRUD, primary/reorder logic, Object Storage deletion, and
  DB/storage consistency handling.

### Phase 5 — hardening

Complete:

* Rate-limit expansion beyond the authentication endpoints: `auditReadRateLimiter` on
  the whole `/api/audit-logs` router.
* Readiness health check that reports database reachability: `GET /ready` with
  per-dependency states, distinct from the no-I/O `/health` liveness probe.
* Test coverage for `products.delete` denial to `editor` (`products.test.ts`), the
  catalog CRUD routes (`brands.test.ts`, `categories.test.ts`), product-delete object
  cleanup (`product-delete-storage.test.ts`), readiness (`readiness.test.ts`), and the
  CLI scripts (`scripts.test.ts`).

Still open:

* Audit-log retention policy (a data-retention decision, not a purge job).
* CI.
* Remaining contract cleanup.

Do not start customer-commerce implementation in this backend.

---

## 15. Verification Requirements

After changes, run relevant checks.

At minimum:

```bash
pnpm type-check
pnpm build
```

The automated suite is the primary verification step:

```bash
pnpm test
```

Run a single file while iterating:

```bash
pnpm exec vitest run src/tests/admin-users.test.ts
```

`pnpm type-check` covers three TypeScript configs — app, CLI scripts, and tests — so a
test-only type error fails the check rather than being missed.

When appropriate:

```bash
pnpm dev
```

Then verify:

```bash
curl http://localhost:5000/health
curl http://localhost:5000/ready
```

Note that `/health` confirms only that the process is up, not that the database is
reachable; `/ready` is the probe that reports database (and storage) reachability.

Do not claim a feature is complete merely because the code compiles.

Distinguish clearly between:

* implemented
* runtime verified
* automated-test verified
* not verified
* intentionally deferred

---

## 16. Agent Operating Procedure

For every implementation task:

1. Inspect the existing implementation.
2. Identify what already exists.
3. Identify exactly what is missing.
4. Explain the proposed scope.
5. List files expected to change.
6. Implement only the requested scope.
7. Reuse existing architecture and utilities.
8. Run relevant verification.
9. Report changed files.
10. Report commands executed.
11. Report successful verification.
12. Report limitations or remaining work.

Do not silently expand scope.

Do not rewrite working subsystems without a concrete reason.

Do not install dependencies unless they are genuinely required.

Do not modify frontend or customer-store code unless explicitly instructed.

Do not initialize Git.

Do not expose secrets.

---

## 17. Current Backend Boundary

This backend is an administrative API.

Do not add customer-facing business logic here merely because it appears useful for the future store.

The current boundary is:

```text
admin-frontend
      │
      │ HTTP
      ▼
admin-backend
      │
      ├── authentication
      ├── authorization
      ├── administrator management
      ├── audit
      ├── brands
      ├── categories
      ├── products
      ├── inventory
      └── product image/storage administration
             │
             ├── Neon PostgreSQL
             └── Neon Object Storage
```

The future `customer-store` will be designed separately.
