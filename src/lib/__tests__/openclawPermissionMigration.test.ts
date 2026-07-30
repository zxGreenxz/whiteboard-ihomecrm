import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql",
);

function readMigration(): string {
  return readFileSync(migrationPath, "utf8");
}

const expectedPermissions = [
  ["openclaw_zalo.view", "view", "VIEW"],
  ["openclaw_zalo.send", "send", "MANAGE"],
  ["openclaw_zalo.manage_connections", "manage_connections", "ELEVATED"],
  ["openclaw_zalo.manage_automation", "manage_automation", "ELEVATED"],
  ["openclaw_zalo.manage_knowledge", "manage_knowledge", "MANAGE"],
  ["openclaw_zalo.manage_handoff", "manage_handoff", "MANAGE"],
  ["openclaw_zalo.manage_operations", "manage_operations", "ELEVATED"],
  ["openclaw_zalo.audit", "audit", "ELEVATED"],
] as const;

describe("OpenClaw permission foundation migration", () => {
  it("is a single additive transaction and creates the dedicated function owner", () => {
    const sql = readMigration();
    expect(sql.match(/^\s*begin\s*;\s*$/gim)).toHaveLength(1);
    expect(sql.match(/^\s*commit\s*;\s*$/gim)).toHaveLength(1);
    expect(sql).toMatch(/create role openclaw_function_owner\s+with\s+NOLOGIN\s+NOINHERIT\s+NOBYPASSRLS/i);
  });

  it("defines exactly the approved organization-scoped catalog entries before grants", () => {
    const sql = readMigration();
    for (const [key, action, sensitivity] of expectedPermissions) {
      expect(sql).toContain(`('${key}', 'openclaw_zalo', '${action}', '${sensitivity}'`);
    }
    expect(sql.match(/\('openclaw_zalo\.[a-z_]+',\s*'openclaw_zalo'/g)).toHaveLength(8);
    expect(sql).toContain("'TENANT'");
    expect(sql).toContain("ARRAY['ORGANIZATION']::text[]");
    expect(sql).toContain("'{}'::text[]");
    expect(sql.indexOf("insert into public.permission_definitions")).toBeLessThan(
      sql.indexOf("insert into public.role_permissions"),
    );
  });

  it("grants only active exact-name system owner roles, including future organizations", () => {
    const sql = readMigration();
    expect(sql).toContain("r.is_system IS TRUE");
    expect(sql).toContain("r.status = 'ACTIVE'");
    expect(sql).toContain("r.name = 'Chủ sở hữu tổ chức'");
    expect(sql).toMatch(/after insert on public\.organization_roles/i);
    expect(sql).toContain("NEW.is_system IS TRUE");
    expect(sql).toContain("NEW.status = 'ACTIVE'");
    expect(sql).toContain("NEW.name = 'Chủ sở hữu tổ chức'");
    expect(sql).not.toContain("Chu so huu to chuc");
  });

  it("keeps provisioning helpers internal and isolated from legacy Zalo", () => {
    const sql = readMigration();
    expect(sql).toMatch(/revoke all on function app_private\.grant_openclaw_owner_permissions_v1\(uuid,uuid\)/i);
    expect(sql).toMatch(/revoke all on function app_private\.provision_openclaw_owner_role_v1\(\)/i);
    expect(sql).not.toMatch(/chat_zalo/i);
    expect(sql).not.toMatch(/\bzalo_[a-z_]+/i);
    expect(sql).not.toMatch(/grant\s+.*openclaw_[a-z_]+.*on\s+table/i);
  });
});
