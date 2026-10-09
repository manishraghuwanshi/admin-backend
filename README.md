# Admin Backend

Backend API for the administrative dashboard of a watch e-commerce learning project.

This application manages the administrative side of the watch catalog, including brands, categories, products, watch details, inventory, product images, authentication, authorization, and audit events.

The overall learning project contains three independent applications:

* `admin-frontend` — React/Vite administrative dashboard
* `admin-backend` — Express/TypeScript administrative API
* `customer-store` — future Next.js customer-facing application

This repository contains only `admin-backend`.

## Technology Stack

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
* JWT authentication with `jose`
* Argon2 password hashing
* Vitest with Supertest and PGlite (in-memory Postgres) for integration tests

The project uses ECMAScript modules.

## Current Features

### Application foundation

* Express 5 application/server separation
* Environment validation
* CORS configuration
* Security headers
* Request IDs
* Structured request logging
* Centralized error handling
* Standardized 404 handling
* JSON body-size limits
* Graceful shutdown
* Production error sanitization

### Authentication and authorization

* Admin login
* Cookie-based JWT authentication
* Refresh-token sessions
* Refresh-token rotation
* Authentication middleware
* CSRF origin protection
* Three administrative roles:

  * `owner`
  * `manager`
  * `editor`
* Backend permission checks
* Authentication failure auditing

The authentication and authorization implementation is exercised end to end by the
integration suite in `src/tests/`, which seeds real administrators, logs in through
the real endpoints, and asserts the role/permission outcomes.

### Administration

* Administrator management API (`/api/admin-users`), owner-only
* First-owner bootstrap script (`pnpm bootstrap:owner`)
* Refresh-session listing and revocation per administrator
* Per-administrator audit trail
* Expired/revoked session cleanup script (`pnpm cleanup:sessions`)

### Catalog

* Brand CRUD
* Category CRUD
* Category parent/child support at the application level
* Product CRUD
* Product/category many-to-many relationships
* Watch-specific product details
* Product filtering, pagination, and sorting
* Product inventory integration
* Product image read support
* Dedicated inventory API with separate read/write permissions and concurrency-safe
  quantity updates
* Product image write API: upload, list, read, update, delete, reorder, and
  primary-image selection

### Database

* Neon PostgreSQL
* Drizzle ORM
* Drizzle migrations
* Relational schema for the current administrative/catalog domain
* Foreign keys, unique constraints, indexes, and check constraints
* Drizzle relation definitions

### Object Storage

* Neon Object Storage integration
* Private `product-images` bucket
* S3-compatible storage client
* Signed download URLs for stored images
* Object upload and deletion under the server-generated `products/` key namespace
* Stored keys re-validated against the full expected format before any delete
* Server-controlled object-key generation (no user-supplied keys, no path traversal)
* Upload validation: base64 decoding, size ceiling, magic-byte content detection
* Orphan cleanup when a database write fails after a successful object upload

### Validation and security

* Zod request validation
* Authentication middleware on protected API routes
* Backend authorization
* CSRF origin checks
* Rate limiting for authentication endpoints
* Per-account login throttling: 5-second minimum between failed attempts, 15-minute
  lockout after 5 consecutive failures
* Secret redaction in logs
* Production error sanitization
* Secure authentication cookies

## Currently Implemented API

### Health

```text
GET /health   # liveness: is the process up (no I/O)
GET /ready    # readiness: does every required dependency answer
```

`/health` performs no I/O, so an orchestrator cannot restart an otherwise healthy
process because a dependency is down. `/ready` runs one cheap database query and,
when storage is configured, one cheap bucket request; it answers `503` when the
database is unreachable, but a storage outage alone does not remove the instance
from rotation. Neither endpoint is authenticated or CSRF-guarded — mounted outside
`/api` — and neither ever echoes a connection string, bucket name, or driver error.

### Authentication

```text
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
GET  /api/auth/me
```

Login is throttled per administrator account, on top of the per-client
`authRateLimiter`:

* at least 5 seconds must pass between two failed attempts for the same account;
* 5 consecutive failed attempts lock the account for 15 minutes.

Both refusals answer `429` with a generic message and a `Retry-After` header, and are
checked **before** the password is verified, so a throttled request never pays for an
Argon2 hash — nor can a correct password be used to probe whether an account is
locked. The state (`failed_login_attempts`, `last_failed_login_at`, `locked_until`)
lives on `admin_users`, so it survives a restart and is shared across instances, and
it is cleared by any successful login. Refused attempts are audited as
`auth.login_failed` with `reason = rate_limited` or `reason = locked`. Unknown and
deactivated accounts carry no throttle state and keep their existing generic `401`.

### Administrator management

Owner role only (`adminUsers.manage`).

```text
GET    /api/admin-users
GET    /api/admin-users/:id
POST   /api/admin-users
PATCH  /api/admin-users/:id
PUT    /api/admin-users/:id/password
DELETE /api/admin-users/:id
GET    /api/admin-users/:id/sessions
POST   /api/admin-users/:id/sessions/revoke
GET    /api/admin-users/:id/audit-logs
```

### Audit logs

```text
GET /api/audit-logs
GET /api/audit-logs/actions
GET /api/audit-logs/entity/:entityType/:entityId
```

Requires `auditLogs.read` or `auditLogs.readLimited`; the latter restricts results to
the caller's own activity.

### Inventory

```text
GET  /api/inventory
GET  /api/inventory/:productId
PUT  /api/inventory/:productId
POST /api/inventory/:productId/adjust
```

Reads require `inventory.read`; writes require `inventory.write`.

### Product images

Nested under the product that owns them; all require `images.manage`.

```text
GET    /api/products/:productId/images
POST   /api/products/:productId/images
POST   /api/products/:productId/images/reorder
GET    /api/products/:productId/images/:imageId
PATCH  /api/products/:productId/images/:imageId
PUT    /api/products/:productId/images/:imageId/primary
DELETE /api/products/:productId/images/:imageId
```

### Brands

```text
GET    /api/brands
GET    /api/brands/:id
POST   /api/brands
PATCH  /api/brands/:id
DELETE /api/brands/:id
```

### Categories

```text
GET    /api/categories
GET    /api/categories/:id
POST   /api/categories
PATCH  /api/categories/:id
DELETE /api/categories/:id
```

### Products

```text
GET    /api/products
GET    /api/products/:id
POST   /api/products
PATCH  /api/products/:id
DELETE /api/products/:id
```

All current `/api` catalog routes require an authenticated administrator and use backend permission checks.

## Remaining Backend Work

The following functionality is intentionally not complete yet:

* CI
* Audit-log retention policy (a purge decision, not a purge job)
* Further production hardening (broader rate limiting beyond the authentication and audit-log endpoints)
* Customer-commerce functionality

Linting is now configured (`eslint.config.mjs`, `pnpm lint` script) and passes.

Already implemented and covered by the integration suite: first-admin bootstrap,
administrator management and password management, product image upload/list/update/
delete, Object Storage upload/delete, object-key generation and sanitisation,
uploaded-image MIME and size enforcement, dedicated inventory API with
`inventory.read`/`inventory.write` enforcement, audit-log querying with
`auditLogs.read`/`auditLogs.readLimited` semantics, the liveness/readiness probes,
the operational scripts (`bootstrap:owner`, `cleanup:sessions`), and automated
integration tests.

## Requirements

Install:

* Node.js
* pnpm
* Access to the Neon project
* PostgreSQL/Neon database credentials
* Neon Object Storage credentials

## Installation

Enter the project directory:

```bash
cd admin-backend
```

Install dependencies:

```bash
pnpm install
```

## Environment Variables

Create a local `.env` file.

The authoritative list and validation rules are defined by:

```text
.env.example
src/config/env.ts
```

The environment includes database, server, CORS, authentication, and Object Storage configuration.

Known required/important variables include:

```env
NODE_ENV=
PORT=5000

DATABASE_URL=
DATABASE_URL_UNPOOLED=
NEON_BRANCH=

CORS_ORIGINS=

AWS_ENDPOINT_URL_S3=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

AUTH_ACCESS_TOKEN_SECRET=
AUTH_REFRESH_TOKEN_SECRET=
```

Additional optional/runtime configuration is documented by `.env.example` and `src/config/env.ts`.

Never commit the real `.env` file.

Never print secret values in logs, reports, API responses, or documentation.

## Development

Start the development server:

```bash
pnpm dev
```

The server runs on port `5000` by default.

## Testing

```bash
pnpm test
```

Watches a single file with:

```bash
pnpm exec vitest run src/tests/admin-users.test.ts
```

The suite runs on `NODE_ENV=test` with an in-memory PGlite database
(`src/tests/helpers/db.ts`) and throwaway auth secrets generated per run
(`src/tests/helpers/env.ts`). It needs no `.env`, never connects to the real Neon
database, and never touches the real Object Storage bucket. `DATABASE_URL` in tests
is an inert loopback URL that exists only to satisfy env validation.

## Type Checking

```bash
pnpm type-check
```

`pnpm type-check` covers three configs: the app (`tsconfig.json`), the CLI scripts
(`tsconfig.tools.json`), and the tests (`tsconfig.tests.json`).

## Production Build

```bash
pnpm build
```

## Start Production Build

```bash
pnpm start
```

## Health Check

With the development server running:

```bash
curl http://localhost:5000/health
```

Expected response:

```json
{
  "success": true,
  "message": "Admin backend is running"
}
```

`/health` is liveness only: it performs no I/O and confirms the process is up, not
that dependencies are reachable. Use `/ready` for that:

```bash
curl http://localhost:5000/ready
```

Ready response:

```json
{
  "success": true,
  "data": {
    "ready": true,
    "database": "ok",
    "storage": "not-configured"
  }
}
```

Not-ready response (`503`, database unreachable):

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Service is not ready",
    "details": {
      "ready": false,
      "database": "unavailable",
      "storage": "not-configured"
    }
  },
  "requestId": "..."
}
```

`database` and `storage` are each `ok`, `unavailable`, or `not-configured`. A storage
outage reports `unavailable` but does not make the instance not-ready, because the
catalog and authentication paths do not need a bucket. `branch` appears only when
`NEON_BRANCH` is set.

## Database

The current database uses Neon PostgreSQL and Drizzle ORM.

Current migrations are already applied. Do not modify or rewrite existing migration files.

Generate a new migration only when an approved schema change is genuinely required:

```bash
pnpm exec drizzle-kit generate
```

Review the generated SQL before applying it.

Apply migrations only after the generated SQL has been reviewed:

```bash
pnpm exec drizzle-kit migrate
```

Never reset, recreate, truncate, or destructively modify the database.

## Current Database Scope

The current administrative backend covers:

* `admin_users`
* `refresh_sessions`
* `audit_logs`
* `brands`
* `categories`
* `products`
* `product_categories`
* `watch_details`
* `product_images`
* `inventory`

Customer-commerce entities remain deferred.

Do not implement customer-facing schemas or routes in this backend until the requirements for `customer-store` are finalized.

## Object Storage

Product images use Neon Object Storage.

Current bucket:

```text
product-images
```

The bucket is private.

The database stores storage keys rather than image binaries.

The backend supports upload, deletion, and signed download URLs for stored objects.
Objects are written under the server-generated `products/` key namespace, and uploads
are validated (base64 decoding, size ceiling, magic-byte content detection) before
anything reaches the bucket. Before any delete, the key stored in the database is
re-validated against the full expected format, so a corrupted or hand-edited row cannot
point a delete at an arbitrary object in the shared bucket.

Uploading an image is a JSON body carrying base64 data, so the body must survive
`JSON_BODY_LIMIT` *and* the decoded image must fit `MAX_UPLOAD_BYTES`. See
[Upload size limits](#upload-size-limits) for how to configure the two together.

Storage credentials must remain environment-only.

Do not change bucket permissions or delete storage objects without explicit approval.

## Upload Size Limits

Two independent limits gate an image upload, and they must be configured together:

| Variable           | Default | Applies to                                     |
| ------------------ | ------- | ---------------------------------------------- |
| `JSON_BODY_LIMIT`  | `100kb` | the raw HTTP body, rejected with `413`         |
| `MAX_UPLOAD_BYTES` | `5 MiB` | the image after base64 decoding, `413`         |

Base64 inflates bytes by roughly 4/3, so a body of size `B` carries at most about
`B * 3 / 4` of image. With the defaults, `JSON_BODY_LIMIT` caps uploads at roughly
75 KiB **before** `MAX_UPLOAD_BYTES` ever gets a chance to apply: a larger body is
rejected by Express with `413 PAYLOAD_TOO_LARGE`, not by the image validator.

`MAX_UPLOAD_BYTES` has exactly one consumer today — this JSON upload path — so the
default configuration silently narrows it to 75 KiB. Raising it alone does nothing.
The limit is not reconciled at startup on purpose: adding a boot-time check would
break every existing deployment whose `JSON_BODY_LIMIT` is left at the default.

To accept a 5 MiB image through the JSON endpoint, set both:

```env
JSON_BODY_LIMIT=7mb
MAX_UPLOAD_BYTES=5242880
```

`7mb` is the smallest convenient setting that clears a 5 MiB image's base64 form
(about 6.67 MiB), which is what `decodeImagePayload` then enforces itself.

The order in which a too-large or malformed upload is rejected is:
`JSON_BODY_LIMIT` (Express, `413`) → Zod string maximum (`400`) → base64 length
ceiling (`413`) → decoded byte count (`413`) → magic-byte content check (`415`).

A reverse proxy in front of this API may impose its own, smaller body limit; check it
if uploads fail with `413` before suspecting these two.

## Security Rules

* Never commit `.env`.
* Never expose secrets.
* Never hardcode credentials.
* Validate external input.
* Enforce authorization on the backend.
* Do not trust client-supplied roles or permissions.
* Do not log passwords, tokens, API keys, or connection strings.
* Keep the Object Storage bucket private.
* Validate uploaded files before implementing upload functionality.
* Do not expose private storage objects directly.
* Review database migrations before applying them.

## Project Documentation

* `README.md` — project overview and operational instructions
* `AGENTS.md` — instructions for AI coding agents
* `docs/architecture.md` — backend architecture
* `docs/database.md` — database schema and migration rules
* `docs/admin-permissions.md` — administrative roles and permission rules

## Project Status

The backend foundation, database, authentication, authorization, audit logging,
catalog CRUD, inventory API, product-image API with Object Storage writes,
administrator management, audit-log querying, liveness/readiness probes, and the
operational scripts (`bootstrap:owner`, `cleanup:sessions`) are implemented.

296 automated integration tests across 19 files cover the authentication lifecycle,
per-account login throttling and lockout, RBAC, CSRF, error handling, inventory
concurrency, image upload and compensation, product-delete object cleanup, audit-log
scoping, readiness, the operational CLI scripts, and administrator management including
the self-lockout and last-active-owner invariants. Run them with `pnpm test`.

Runtime verification so far is automated-test based, against in-memory PGlite rather
than Neon. Production-shaped behaviour (real Neon, real Object Storage bucket, real
browser cookie flow) still needs a manual pass.

This project is under active development for learning and portfolio purposes.
