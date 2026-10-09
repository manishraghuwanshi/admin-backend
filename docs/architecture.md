# System Architecture

## 1. Project Overview

This is a watch e-commerce learning project consisting of three independent applications.

```text
watch-ecommerce-learning/
├── admin-frontend/
├── admin-backend/
└── customer-store/
```

Each application has a separate responsibility and may have its own Git repository.

---

## 2. Applications

### 2.1 admin-frontend

Technology:

- React
- Vite
- TypeScript or JavaScript, depending on the implementation
- Tailwind CSS

Purpose:

- Administrative dashboard
- Product management interface
- Brand and category management
- Inventory management
- Product image management
- Administrative authentication interface

The frontend must communicate with the backend API instead of directly modifying the database.

---

### 2.2 admin-backend

Technology:

- Node.js
- Express 5
- TypeScript
- Drizzle ORM
- PostgreSQL
- Neon Serverless Postgres
- Neon Object Storage

Purpose:

- Administrative API
- Admin authentication
- Role-based authorization
- Product catalog management
- Inventory management
- Product image management
- Administrative validation and business rules

The backend is responsible for enforcing authorization and validating all incoming requests.

---

### 2.3 customer-store

Planned technology:

- Next.js
- React
- TypeScript
- Tailwind CSS
- Neon PostgreSQL

Purpose:

- Customer-facing storefront
- Product browsing
- Product details
- Customer authentication
- Shopping cart
- Checkout
- Orders
- Payments
- Customer account management

This application has not been implemented yet.

Its database requirements must be finalized before customer-commerce tables are created.

---

## 3. Database Architecture

The project uses a shared Neon PostgreSQL database.

The current database schema focuses on the product catalog and inventory domain.

Current tables:

- `brands`
- `categories`
- `products`
- `product_categories`
- `watch_details`
- `product_images`
- `inventory`
- `admin_users`
- `refresh_sessions`
- `audit_logs`

The database schema is managed through Drizzle ORM and Drizzle Kit migrations.

Database access must be performed through controlled application code.

---

## 4. Object Storage Architecture

Neon Object Storage is used to store product images.

The current bucket is:

```text
product-images
```

The bucket is private.

The database stores object-storage keys rather than storing image files directly in PostgreSQL.

Example:

```text
Database:
thumbnail_storage_key = products/abc123/thumbnail.webp

Object Storage:
products/abc123/thumbnail.webp
```

The backend is responsible for handling authenticated image-upload operations.

Storage credentials must be loaded from environment variables and must never be exposed to the frontend.

---

## 5. Backend Module Organization

The backend should be organized by business domain.

The repository structure:

```text
src/
├── app.ts
├── server.ts
├── config/          # env.ts, cors.ts
├── db/              # index.ts, schema.ts
├── lib/
│   ├── audit.ts
│   ├── auth/        # cookies.ts, login-throttle.ts, password.ts, permissions.ts, tokens.ts
│   └── storage/     # keys.ts, s3.ts
├── middleware/       # auth, authorize, csrf, error-handler, rate-limit, validate, ...
├── modules/
│   ├── admin-users/
│   ├── audit-logs/
│   ├── auth/
│   ├── brands/
│   ├── categories/
│   ├── inventory/
│   ├── product-images/
│   └── products/
├── scripts/          # bootstrap-owner.ts, cleanup-sessions.ts, lib/cli.ts
├── tests/            # Vitest integration suites + helpers/
├── types/
└── utils/
```

Modules are thin route files plus a service file (`<domain>.routes.ts`,
`<domain>.service.ts`). There is no separate controller or repository layer, and
schemas live next to the service that uses them.

The route file owns middleware wiring and validation; the service file owns
validation schemas, business rules, database access, audit recording, and the
response envelope.

---

## 6. API Organization

Administrative API routes use the `/api` prefix.

Two operational endpoints live outside `/api` so that they stay out of the CSRF guard
and the audit surface, and are deliberately unauthenticated because they report
statuses rather than data:

```text
GET /health   # liveness: is the process up (no I/O)
GET /ready    # readiness: does every required dependency answer
```

`/ready` runs one cheap database query and, when storage is configured, one cheap
bucket request. It answers `503` when the database is unreachable; a storage outage
alone reports `unavailable` without pulling the instance out of rotation. Neither
endpoint echoes a connection string, bucket name, or driver error.

Current surface:

```text
/api/auth
/api/admin-users
/api/audit-logs
/api/brands
/api/categories
/api/inventory
/api/products
/api/products/:productId/images
```

Product images are nested under the product that owns them rather than living at a
top-level `/api/images`. Every handler receives `:productId` and, where relevant,
`:imageId`, and verifies the pair together, so another product's image is a `404`
rather than a successful cross-product mutation.

Protected routes must use authentication and authorization middleware.

The backend must not rely on the frontend to enforce permissions.

---

## 7. Authentication and Authorization

Authentication and authorization are implemented.

* Argon2 password hashing; access and refresh tokens signed with `jose`
* Tokens delivered as httpOnly cookies; refresh tokens rotated on use, with replay of
  a rotated-out token revoking the whole session lineage
* `requireAuth` resolves the caller from the database on every request, so a
  deactivated administrator is rejected even with a valid, unexpired token
* `requirePermission` (AND semantics) and `requireAnyPermission` (OR semantics) derive
  the role's permissions server-side from `src/lib/auth/permissions.ts`

The permission table — not this document — is the source of truth for which role holds
what. See `docs/admin-permissions.md` for the enforcement status of each permission.

Authorization guards on top of the permission check exist where a permission alone is
not enough to make a mutation safe: the self-lockout and last-active-owner rules in
administrator management, and the reservation-fits-quantity rule in inventory.

Login throttling sits alongside authentication rather than in the permission model: it
is not an authorization decision, so it is not a permission. `POST /api/auth/login`
checks a per-account failure interval and temporary lockout
(`src/lib/auth/login-throttle.ts`, state persisted on `admin_users`) **before**
verifying the password, so a throttled attempt never reaches Argon2 and a correct
password cannot be used to probe whether an account is locked. The per-client
`authRateLimiter` continues to apply on top.

The frontend may hide unavailable actions for usability, but the backend must always perform the final authorization check.

---

## 8. Data Ownership

The admin backend owns administrative operations for:

- Brands
- Categories
- Products
- Product images (and the Object Storage keys and objects behind them)
- Inventory
- Administrator accounts, their sessions, and their passwords
- Audit events

Customer-related operations will be designed later.

The customer-facing application must not bypass defined security boundaries to modify administrative data.

---

## 9. Deferred Customer-Commerce Features

The following features are intentionally deferred:

- Customer accounts
- Customer addresses
- Shopping carts
- Wishlists
- Orders
- Payments
- Refunds
- Shipments
- Coupons
- Product reviews

These features must not be implemented until the `customer-store` requirements are finalized.

---

## 10. Architectural Principles

- Keep business logic separate from route definitions.
- Validate all external input.
- Keep database access centralized and predictable.
- Do not expose secrets to clients.
- Prefer small, testable modules.
- Avoid unnecessary abstractions.
- Preserve backward compatibility where practical.
- Use migrations for approved schema changes.
- Document meaningful architectural changes.