import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const inventoryMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729010000_network_center_permissions_inventory.sql",
);

const inventorySql = existsSync(inventoryMigrationPath)
  ? readFileSync(inventoryMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

describe("Network Center permission and inventory migration", () => {
  it("exists as one forward transaction and refreshes the API schema", () => {
    expect(existsSync(inventoryMigrationPath), `Missing migration: ${inventoryMigrationPath}`).toBe(true);
    expect(inventorySql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(inventorySql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(inventorySql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("registers exactly the two building-aware Network Center permissions", () => {
    expect(inventorySql).toContain("'network_center.view'");
    expect(inventorySql).toContain("'network_center.execute'");
    expect(inventorySql).toContain("ARRAY['ORGANIZATION','AREA','BUILDING']");
    expect(inventorySql).toContain("ARRAY['BUILDING']");
    expect(inventorySql).not.toMatch(/network_center\.(approve|manage|delete|create)/i);
  });

  it("creates tenant-bound inventory with one active MikroTik per building", () => {
    expect(inventorySql).toMatch(/CREATE TABLE IF NOT EXISTS public\.network_devices/i);
    expect(inventorySql).toMatch(/network_devices_one_active_mikrotik_per_building/i);
    expect(inventorySql).toMatch(/FOREIGN KEY \(organization_id, building_id\)/i);
    expect(inventorySql).toMatch(/UNIQUE \(organization_id, id\)/i);
    expect(inventorySql).toContain("credential_ref");
    expect(inventorySql).not.toMatch(/password|private_key|api_token|secret\s+text/i);
  });

  it("captures inventory identity, topology, protection, and one active desired state", () => {
    for (const column of [
      "external_key",
      "desired_firmware",
      "parent_device_id",
      "uplink_interface_key",
      "sort_order",
      "is_protected",
      "nominal_speed_bps",
      "schema_version",
    ]) {
      expect(inventorySql).toContain(column);
    }
    expect(inventorySql).toContain("network_devices_external_key_uidx");
    expect(inventorySql).toContain("network_desired_state_one_active_per_building");
  });

  it("keeps Aruba display-only and unlimited", () => {
    expect(inventorySql).toMatch(/device_kind\s*=\s*'ARUBA'[\s\S]{0,100}write_capability\s*=\s*false/i);
    expect(inventorySql).not.toMatch(/slot_no\s+BETWEEN\s+1\s+AND\s+10/i);
    expect(inventorySql).not.toMatch(/aruba[^\n]{0,80}(max|limit|quota)[^\n]{0,40}\d+/i);
  });

  it("creates interfaces, connections, settings, desired-state history, and inert building slots", () => {
    for (const table of [
      "network_interfaces",
      "network_device_connections",
      "network_site_settings",
      "network_desired_state_versions",
    ]) {
      expect(inventorySql).toContain(`public.${table}`);
    }
    expect(inventorySql).toMatch(/INSERT INTO public\.network_devices/i);
    expect(inventorySql).toMatch(/'MIKROTIK'[\s\S]{0,500}'UNPROVISIONED'/i);
    expect(inventorySql).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it("fails closed until the later RPC migration and pins every child to its building", () => {
    for (const table of [
      "network_devices",
      "network_interfaces",
      "network_device_connections",
      "network_site_settings",
      "network_desired_state_versions",
    ]) {
      expect(inventorySql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
      );
      expect(inventorySql).toMatch(
        new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`, "i"),
      );
    }

    for (const constraint of [
      "network_interfaces_org_building_fk",
      "network_device_connections_org_building_fk",
      "network_desired_state_versions_org_building_fk",
    ]) {
      expect(inventorySql).toContain(constraint);
    }
    expect(inventorySql).toMatch(/b\.is_virtual\s*=\s*false/i);
  });
});
