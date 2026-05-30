import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  hasPermission,
  permissionsFor,
  type Permission,
} from "../lib/auth/permissions.js";

/**
 * The permission table is the single source of truth for authorization, so its
 * shape is pinned here. Two of these tests exist to stop a specific class of bug:
 * a role being added to the type without the table, or `permissionsFor` drifting
 * from `hasPermission` so that `/api/auth/me` advertises something the middleware
 * would not honour.
 */

function permissionList(role: "owner" | "manager" | "editor"): Permission[] {
  return permissionsFor(role);
}

describe("permissions: the role table", () => {
  it("lists every permission exactly once", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    expect(ALL_PERMISSIONS).toContain("adminUsers.manage");
    expect(ALL_PERMISSIONS).toContain("auditLogs.readLimited");
  });

  it("never returns more permissions than the table contains", () => {
    for (const role of ["owner", "manager", "editor"] as const) {
      for (const permission of permissionList(role)) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  it("agrees with hasPermission for every role/permission pair", () => {
    for (const role of ["owner", "manager", "editor"] as const) {
      const granted = new Set(permissionList(role));

      for (const permission of ALL_PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(granted.has(permission));
      }
    }
  });

  it("gives the owner everything, since it is the only role that can manage admins", () => {
    expect(permissionList("owner")).toEqual([...ALL_PERMISSIONS]);
  });

  it("gives the manager limited audit access but never admin management", () => {
    const manager = permissionList("manager");

    expect(manager).toContain("auditLogs.readLimited");
    expect(manager).not.toContain("auditLogs.read");
    expect(manager).not.toContain("adminUsers.manage");
    expect(manager).toContain("inventory.write");
    expect(manager).toContain("products.delete");
  });

  it("gives the editor catalog and image rights but no writes to stock or audit", () => {
    const editor = permissionList("editor");

    expect(editor).toEqual([
      "products.read",
      "products.write",
      "brands.manage",
      "categories.manage",
      "images.manage",
      "inventory.read",
    ]);
    expect(editor).not.toContain("products.delete");
    expect(editor).not.toContain("inventory.write");
    expect(editor).not.toContain("auditLogs.read");
    expect(editor).not.toContain("auditLogs.readLimited");
  });

  it("returns a fresh array each call, so a caller cannot mutate the table", () => {
    const first = permissionsFor("owner");

    expect(first).not.toBe(permissionsFor("owner"));

    first.pop();

    expect(permissionsFor("owner")).toEqual([...ALL_PERMISSIONS]);
  });

  it("denies an unknown permission rather than defaulting to allow", () => {
    expect(hasPermission("owner", "not.a.permission" as Permission)).toBe(false);
    expect(hasPermission("editor", "adminUsers.manage")).toBe(false);
  });
});
