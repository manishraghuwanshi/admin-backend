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

## Project Status

Product catalog, inventory, and product-image administration are implemented.
Automated integration tests and the operational scripts are the next step.
