import type { AdminRole } from "../../db/schema.js";

export type Permission =
  | "products.read"
  | "products.write"
  | "products.delete"
  | "brands.manage"
  | "categories.manage"
  | "images.manage"
  | "inventory.read"
  | "inventory.write"
  | "adminUsers.manage"
  | "auditLogs.read"
  | "auditLogs.readLimited";

/** Every permission in the model, in canonical (display) order. */
export const ALL_PERMISSIONS = [
  "products.read",
  "products.write",
  "products.delete",
  "brands.manage",
  "categories.manage",
  "images.manage",
  "inventory.read",
  "inventory.write",
  "adminUsers.manage",
  "auditLogs.read",
  "auditLogs.readLimited",
] as const satisfies readonly Permission[];

const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  owner: new Set([
    "products.read",
    "products.write",
    "products.delete",
    "brands.manage",
    "categories.manage",
    "images.manage",
    "inventory.read",
    "inventory.write",
    "adminUsers.manage",
    "auditLogs.read",
    "auditLogs.readLimited",
  ]),
  manager: new Set([
    "products.read",
    "products.write",
    "products.delete",
    "brands.manage",
    "categories.manage",
    "images.manage",
    "inventory.read",
    "inventory.write",
    "auditLogs.readLimited",
  ]),
  editor: new Set([
    "products.read",
    "products.write",
    "brands.manage",
    "categories.manage",
    "images.manage",
    "inventory.read",
  ]),
};

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * The full permission set a role holds, in the declaration order of
 * `Permission`.
 *
 * The frontend uses this to decide which screens and buttons to render, but it
 * is strictly a convenience mirror: `requirePermission()` re-derives the answer
 * from the server-side table on every request, so nothing is authorised by
 * trusting a client-supplied list.
 */
export function permissionsFor(role: AdminRole): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].has(permission));
}

export const CATALOG_ENTITY_TYPES = [
  "brand",
  "category",
  "product",
  "product_image",
  "inventory",
] as const;
