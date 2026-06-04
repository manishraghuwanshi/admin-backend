# Database Documentation

## 1. Database Provider

The project uses Neon Serverless PostgreSQL.

The backend uses:

- Drizzle ORM for database queries
- Drizzle Kit for schema migrations
- `postgres` for the PostgreSQL driver

The database connection string is loaded from environment variables.

Secrets must never be committed to Git.

---

## 2. Current Schema

The current schema contains these tables:

```text
brands
categories
products
product_categories
watch_details
product_images
inventory
admin_users
refresh_sessions
audit_logs
```

The first seven tables belong to the catalog and inventory domain. The last
three support administrative authentication, authorization, and audit logging,
and were added by migration `0002`.

The schema is defined in:

```text
src/db/schema.ts
```

Database migrations are stored in:

```text
drizzle/
```

---

## 3. Entity Relationships

```text
brands
  │
  └── products
        ├── product_categories ── categories
        ├── watch_details
        ├── product_images
        └── inventory

admin_users
  ├── refresh_sessions
  └── audit_logs (actor_id, nullable on delete)
```

---

## 4. brands

Stores product-brand information.

Important fields include:

- `id`
- `name`
- `slug`
- `description`
- `logo_storage_key`
- `website_url`
- `is_active`
- `created_at`
- `updated_at`

A brand may be associated with multiple products.

The brand name and slug should be validated.

---

## 5. categories

Stores product categories and subcategories.

Important fields include:

- `id`
- `parent_id`
- `name`
- `slug`
- `description`
- `image_storage_key`
- `is_active`
- `sort_order`
- `created_at`
- `updated_at`

### Category hierarchy

`parent_id` is a nullable UUID that can represent a parent category.

At present, `parent_id` is stored as a plain UUID without a database-level self-referencing foreign-key constraint.

This was intentionally done to avoid the current TypeScript circular table-initialization issue.

This design must not be changed casually.

Any future change must include:

1. Schema review
2. Migration generation
3. SQL migration review
4. Testing

---

## 6. products

Stores the primary product information.

Important fields include:

- `id`
- `brand_id`
- `name`
- `slug`
- `sku`
- `short_description`
- `description`
- `price`
- `compare_at_price`
- `currency`
- `thumbnail_storage_key`
- `is_featured`
- `is_active`
- `created_at`
- `updated_at`

Product prices use integer values representing the smallest currency unit.

For example, an INR price of ₹12,999 should be stored as:

```text
12999
```

The application must consistently use the same price representation.

Products may belong to multiple categories through the `product_categories` table.

---

## 7. product_categories

This is a junction table that represents the many-to-many relationship between products and categories.

Important fields:

- `product_id`
- `category_id`

The combination of `product_id` and `category_id` forms the composite primary key.

A product can belong to multiple categories.

A category can contain multiple products.

---

## 8. watch_details

Stores watch-specific information associated with a product.

This table has a one-to-one relationship with `products`.

Important fields include watch-related attributes such as:

- Case information
- Strap information
- Movement information
- Water resistance
- Dial information
- Additional specifications

The exact fields should be inspected in `src/db/schema.ts` before implementation.

Additional specifications may be stored as JSON data.

---

## 9. product_images

Stores image metadata for products.

The actual image files are stored in Neon Object Storage.

Important fields include:

- `id`
- `product_id`
- `storage_key`
- `alt_text`
- `sort_order`
- `is_primary`
- `created_at`

The database stores the storage key instead of the image binary.

Image uploads must be validated for:

- File type
- File size
- File name
- Storage path
- Product ownership or association

---

## 10. inventory

Stores stock information for products.

Important fields include:

- `id`
- `product_id`
- `quantity`
- `reserved_quantity`
- `low_stock_threshold`
- `updated_at`

Each product has at most one inventory record.

Important constraints include:

- Quantity cannot be negative.
- Reserved quantity cannot be negative.
- Reserved quantity cannot exceed available quantity.
- Low-stock threshold cannot be negative.

Inventory updates should be handled carefully to avoid inconsistent stock levels.

---

## 11. admin_users

Stores administrative accounts used to authenticate against this backend. It is
**not** the customer account table; customer identities remain deferred.

Important fields include:

- `id`
- `email` (unique)
- `password_hash` (Argon2id hash; never returned by the API)
- `name`
- `role` (`owner`, `manager`, `editor`)
- `is_active`
- `last_login_at`
- `created_at`
- `updated_at`

Roles are enforced server-side through the permission map in
`src/lib/auth/permissions.ts`. Client-supplied role information is never trusted.

---

## 12. refresh_sessions

Tracks issued refresh tokens so sessions can be rotated and revoked.

Important fields include:

- `id`
- `admin_user_id` (foreign key to `admin_users`, cascades on delete)
- `token_hash` (unique; the raw refresh token is never stored)
- `expires_at`
- `revoked_at`
- `ip_address`
- `user_agent`
- `created_at`

Refresh tokens rotate on every use. Presenting an already-rotated token is
treated as token reuse and revokes the remaining sessions for that administrator.

---

## 13. audit_logs

Append-only record of security-relevant and catalog-mutating actions.

Important fields include:

- `id`
- `actor_id` (foreign key to `admin_users`, set to null when the actor is deleted)
- `action` (for example `auth.login`, `brand.create`, `product.delete`)
- `entity_type`
- `entity_id`
- `metadata` (JSONB context; never contains secrets or password material)
- `ip_address`
- `user_agent`
- `created_at`

Failed logins are recorded with `action = auth.login_failed` and a non-enumerating
reason such as `unknown_user`.

---

## 14. Database Migration Rules

Before changing the schema:

1. Inspect the current schema.
2. Explain the proposed change.
3. Modify the Drizzle schema.
4. Generate a migration.
5. Review the generated SQL.
6. Run type-checking.
7. Apply the migration only after approval.
8. Update this document.

Useful commands:

```bash
pnpm exec drizzle-kit generate
pnpm exec drizzle-kit migrate
pnpm type-check
pnpm build
```

Never reset the database to resolve a migration issue without explicit approval.

---

## 15. Deferred Tables

The following tables are intentionally not implemented yet:

- `customers`
- `customer_addresses`
- `carts`
- `cart_items`
- `wishlists`
- `wishlist_items`
- `orders`
- `order_items`
- `payments`
- `payment_transactions`
- `shipments`
- `coupons`
- `reviews`

These tables will be designed after the requirements for `customer-store` are finalized.

Do not create migrations or tables for these entities without explicit approval.

---

## 16. Naming and Design Guidelines

- Use consistent snake_case names in the database.
- Use UUIDs for entity identifiers where consistent with the existing schema.
- Use foreign keys for valid entity relationships.
- Use database constraints for important data-integrity rules.
- Prefer soft deactivation using `is_active` where appropriate.
- Avoid storing files directly in database columns.
- Avoid duplicating product information unnecessarily.
- Document meaningful schema decisions.