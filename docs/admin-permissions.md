# Administrative Permissions

## Purpose

This document describes the permission model used by the administrative backend.

The backend is the final security boundary.

The frontend must never be relied upon to enforce permissions.

---

## Source of Truth

The authoritative implementation is:

```text
src/lib/auth/permissions.ts
```

When this document and the implementation disagree, inspect the implementation before making authorization changes and then synchronize this document.

Do not infer permissions from old versions of this document.

---

## Roles

The backend defines three administrative roles:

* `owner`
* `manager`
* `editor`

The role stored for an authenticated administrator is used by the backend to determine the permissions available to that administrator.

Clients must not be able to assign or elevate their own roles.

---

## Permission Definitions

The current permission concepts defined by the backend are:

| Permission              | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `products.read`         | Read product information                                        |
| `products.write`        | Create/update products                                          |
| `products.delete`       | Delete products                                                 |
| `brands.manage`         | Manage brands                                                   |
| `categories.manage`     | Manage categories                                               |
| `adminUsers.manage`     | Manage administrator accounts                                   |
| `images.manage`         | Manage product images                                           |
| `inventory.read`        | Read inventory information                                      |
| `inventory.write`       | Modify inventory                                                |
| `auditLogs.read`        | Read the whole audit log                                          |
| `auditLogs.readLimited` | Read only the audit rows whose actor is the caller                  |

---

## Current Enforcement Status

Every permission defined by the backend is enforced by a route. Previously some existed
without one; if a new permission is added to `permissions.ts` before its API exists,
list it separately rather than implying it is enforced.

### Enforced

| Permission              | Current backend usage                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `products.read`         | Product read routes                                                |
| `products.write`        | Product create/update routes                                       |
| `products.delete`       | Product delete route                                               |
| `brands.manage`         | Brand routes                                                       |
| `categories.manage`     | Category routes                                                    |
| `images.manage`         | `/api/products/:productId/images` routes                           |
| `inventory.read`        | `GET /api/inventory`, `GET /api/inventory/:productId`              |
| `inventory.write`       | `PUT /api/inventory/:productId`, `POST /api/inventory/:productId/adjust` |
| `adminUsers.manage`     | All `/api/admin-users` routes                                      |
| `auditLogs.read`        | `/api/audit-logs` routes (full history scope)                      |
| `auditLogs.readLimited` | `/api/audit-logs` routes (own-actor scope)                         |

`auditLogs.read` and `auditLogs.readLimited` are alternatives rather than
requirements: `/api/audit-logs` accepts a caller holding either one
(`requireAnyPermission`), and the service resolves the query scope from which
permission the caller actually has. A caller holding both is treated as
`auditLogs.read`.

Route-level authorization tests cover `adminUsers.manage`, `inventory.read`,
`inventory.write`, `auditLogs.read`, and `auditLogs.readLimited`, in both the allowed
and denied direction. The remaining permissions are held by all three roles (or, for
`products.delete`, denied to `editor` with no dedicated route test yet), so the role →
permission matrix in `src/tests/permissions.test.ts` is what pins them.

`editor` deliberately holds `images.manage`, which is why image *deletion* is
available to it. The compensating control is not the permission but the key check:
a stored key is re-validated against the full expected `products/<productId>/<uuid>.<ext>`
format before any object delete, so no role can aim a delete at an arbitrary object in
the shared bucket. There is no separate `images.delete` permission.

Do not add route checks for APIs that do not yet exist merely to make the permission appear "used."

---

## Role Mapping

The exact role-to-permission mapping must be taken from:

```text
src/lib/auth/permissions.ts
```

Do not copy or recreate a stale role matrix here without first comparing it against that implementation.

The current implementation defines the actual mapping.

When the role mapping is intentionally changed:

1. update `src/lib/auth/permissions.ts`
2. add or update authorization tests
3. update this document
4. verify affected routes
5. ensure documentation and tests match the implementation

---

## Authorization Rules

### Backend enforcement

Every protected administrative operation must enforce authorization on the server.

The frontend may hide or show UI based on role/permission information, but this is only a usability feature.

A malicious client must not be able to bypass permissions by directly calling the API.

### Client-supplied role information

Never trust role or permission information supplied by the client.

The authenticated administrator identity must come from the backend authentication/session mechanism.

### Least privilege

When new administrative APIs are added:

* define the required permission
* enforce it on the backend
* test both allowed and denied roles
* document it here

Do not grant broader permissions merely because it is convenient for the frontend.

---

## Authentication and Permission Flow

The intended backend flow is:

```text
HTTP request
    ↓
Authentication middleware
    ↓
Authenticated administrator
    ↓
Role lookup
    ↓
Permission check
    ↓
Protected route/service
    ↓
Database/storage operation
```

The frontend is not part of the security decision.

---

## Permission Checks

The permission middleware lives in `src/middleware/authorize.ts` and offers two
forms, which differ in how multiple permissions combine:

* `requirePermission(a, b, ...)` — AND semantics; the caller must hold every one.
* `requireAnyPermission(a, b, ...)` — OR semantics; the caller must hold at least one.

Both derive the answer from `src/lib/auth/permissions.ts` on the server for every
request; neither consults anything the client supplied.

Do not assume one form when adding a route: pick AND for compound operations and OR
for alternatives, and note that when alternatives change the *query* rather than the
verdict (as with the audit-log scopes), the branch is resolved inside the service.

---

## Administrator Management

Administrator management exists at `/api/admin-users` and every route on it is
gated by `requireAuth` followed by `requirePermission("adminUsers.manage")`,
which only the `owner` role holds.

Covered operations:

* listing administrators (pagination, role/active filters, search, sorting, and a
  per-row active session count)
* reading one administrator
* creating administrators
* updating name, email, role, and activation state
* setting a password
* deleting an administrator
* listing and revoking an administrator's refresh sessions
* reading the actions an administrator performed

Two guards sit on top of the permission check, because knowing a caller *may*
manage admins says nothing about whether a specific mutation is safe:

1. **Self-lockout.** An administrator cannot deactivate, demote, or delete its own
   account. Both failures are `422`.
2. **Last active owner.** The final active `owner` cannot be deleted, deactivated,
   or demoted (`409`). `owner` is the only role holding `adminUsers.manage`, so
   losing it would strand the console with no way back in.

Mutations that make a live session observably wrong — role change, deactivation,
email change, password change, deletion — revoke that administrator's refresh
sessions, so a token carrying a stale `role` claim cannot keep working. A pure
rename revokes nothing.

`passwordHash` is never selected by this module, so it cannot appear in a
response. Audit metadata records which fields changed and how many sessions were
revoked, never a password.

---

## Product Image Management

Product-image management exists at `/api/products/:productId/images` and every
route there is gated by `requireAuth` followed by
`requirePermission("images.manage")`, which `owner`, `manager`, and `editor` hold.

Enforced operations:

* image upload (base64 body, decoded and validated server-side)
* image listing and single-image read
* image metadata update (alt text, ordering position)
* image reorder
* primary-image change
* image deletion

Object keys are generated by the server (`src/lib/storage/keys.ts`) from a fixed
`products/` prefix, the product id, and a fresh UUID — never from user text. The
bucket is private, so images are served through short-lived signed download URLs.

---

## Inventory

A dedicated inventory API exists at `/api/inventory`, and reads and writes are
separately permissioned:

* `inventory.read` — `GET /api/inventory`, `GET /api/inventory/:productId`
* `inventory.write` — `PUT /api/inventory/:productId`,
  `POST /api/inventory/:productId/adjust`

`editor` holds `inventory.read` but not `inventory.write`, so it can see stock and
cannot change it. The nested inventory input accepted by the product create/update
routes is governed by `products.write`, as before.

Quantity mutations are concurrency-safe: the row is locked before the new value is
computed, so two simultaneous adjustments cannot overwrite one another, and
`reservedQuantity` can never exceed `quantity`.

---

## Audit Logs

Audit events are written by the backend for authentication and catalog, inventory,
image, and administrator mutations.

A query API exists at `/api/audit-logs` and is gated by
`requireAnyPermission("auditLogs.read", "auditLogs.readLimited")`:

* `auditLogs.read` (`owner`) sees the full history.
* `auditLogs.readLimited` (`manager`) sees only rows whose actor is themselves.

The scope is resolved from the caller's server-side role, never from a query
parameter. A caller holding both permissions is treated as `auditLogs.read`.
Filtering and pagination semantics live in `audit-logs.service.ts`.

Additional access points:

* `GET /api/audit-logs/actions` — the distinct action names in use, to drive filters.
* `GET /api/audit-logs/entity/:entityType/:entityId` — history for one entity.
* `GET /api/admin-users/:id/audit-logs` — the actions one administrator performed.

Retention is bounded by `GET`/query limits rather than a purge job; there is no
audit-log deletion path.

---

## Testing Requirements

Authorization changes should include tests for:

* unauthenticated access → `401`
* authenticated user without required permission → `403`
* authorized user → expected success
* each affected role
* sensitive administrator operations
* permission combinations where applicable

A permission is not considered fully implemented until both code enforcement and appropriate verification exist.

---

## Documentation Synchronization

Whenever the permission model changes:

* update `src/lib/auth/permissions.ts`
* update this document
* update authorization tests
* verify affected routes
* ensure the frontend contract remains compatible

Never update this document alone and assume the backend changed.

---

## Security Principles

* Backend authorization is mandatory.
* Frontend authorization is only a UI concern.
* Users cannot assign themselves roles.
* Users cannot grant themselves permissions.
* Authentication identity comes from the backend.
* Sensitive administrator actions should be audited.
* Permission checks should remain explicit and reviewable.
* New administrative endpoints must define authorization before implementation is considered complete.
