import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPaths = [
  "../../../supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql",
  "../../../supabase/migrations/20260729131000_network_center_resource_lifecycle.sql",
].map((path) => resolve(import.meta.dirname, path));
const sql = migrationPaths.map((path) => readFileSync(path, "utf8")).join("\n");

function inventoryFunction(): string {
  const match = [...sql.matchAll(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.network_center_worker_inventory_v1\b[\s\S]*?\$fn\$;/gi,
  )].at(-1);
  expect(match, "Missing worker inventory/discovery RPC").not.toBeNull();
  return match![0];
}

describe("Network Center worker inventory discovery", () => {
  it("bounds each discovery batch without imposing an Aruba fleet quota", () => {
    const definition = inventoryFunction();

    expect(definition).toMatch(/octet_length\(p_payload::text\)\s*>\s*524288/i);
    expect(definition).toMatch(
      /jsonb_array_length\([^;]*?interfaces[^;]*?\)\s*>\s*256/i,
    );
    expect(definition).toMatch(
      /jsonb_array_length\([^;]*?aruba[^;]*?\)\s*>\s*256/i,
    );
    expect(definition).not.toMatch(
      /(?:aruba|device)[^;\n]{0,100}(?:quota|max_devices|hard_limit|slot_no)/i,
    );
  });

  it("backs unlimited Aruba keyset pagination with the matching cursor index", () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+network_devices_aruba_cursor_idx\s+ON\s+public\.network_devices\s*\(\s*organization_id\s*,\s*building_id\s*,\s*sort_order\s*,\s*id\s*\)\s+WHERE\s+device_kind\s*=\s*'ARUBA'\s+AND\s+is_active/i,
    );
  });

  it("forces Aruba display-only and returns stable external-key mappings", () => {
    const definition = inventoryFunction();

    expect(sql).toMatch(
      /network_devices_aruba_display_only[\s\S]{0,220}?device_kind\s*=\s*'ARUBA'[\s\S]{0,160}?write_capability\s*=\s*false[\s\S]{0,160}?credential_ref\s+IS\s+NULL/i,
    );
    expect(definition).toMatch(/'ARUBA'/i);
    expect(definition).toMatch(/write_capability[\s\S]*?false/i);
    expect(definition).toMatch(/credential_ref[\s\S]*?NULL/i);
    expect(definition).toMatch(
      /ON\s+CONFLICT\s*\(\s*parent_device_id\s*,\s*aruba_stable_key\s*\)[\s\S]{0,120}device_kind\s*=\s*'ARUBA'/i,
    );
    expect(definition).toMatch(/'externalKey'[\s\S]*?'id'/i);
  });

  it("upserts router interfaces without allowing protected ports to be downgraded", () => {
    const definition = inventoryFunction();

    expect(definition).toMatch(
      /ON\s+CONFLICT\s*\(\s*device_id\s*,\s*interface_key\s*\)/i,
    );
    expect(definition).toMatch(
      /is_protected\s*=\s*public\.network_interfaces\.is_protected\s+OR\s+EXCLUDED\.is_protected/i,
    );
    expect(definition).toContain(
      "app_private.network_center_assert_safe_json_v1",
    );
  });

  it("shows a discovered Aruba management address without inventing a credential", () => {
    const definition = inventoryFunction();
    const listAruba = [...sql.matchAll(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.network_center_list_aruba_v1\b[\s\S]*?\$fn\$;/gi,
    )].at(-1)?.[0];

    expect(listAruba).toBeDefined();
    expect(definition).toContain("v_item->>'managementAddress'");
    expect(definition).toMatch(
      /inventory_metadata[\s\S]*?managementAddress/i,
    );
    expect(listAruba).toMatch(
      /inventory_metadata[\s\S]*?managementAddress/i,
    );
  });

  it("keeps the discovery RPC service-role-only", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.network_center_worker_inventory_v1\(text, jsonb\)[\s\S]{0,120}?FROM PUBLIC, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.network_center_worker_inventory_v1\(text, jsonb\)[\s\S]{0,120}?TO service_role/i,
    );
  });
});
