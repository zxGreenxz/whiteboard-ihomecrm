import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../supabase/migrations/20260729132000_network_center_managed_commands.sql",
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string): string {
  return [...sql.matchAll(new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public|app_private)\\.${name}\\b[\\s\\S]*?\\$fn\\$;`,
    "gi",
  ))].at(-1)?.[0] ?? "";
}

describe("Network Center managed-resource migration", () => {
  it("creates a tenant-bound immutable managed-resource registry with no browser ACL", () => {
    expect(sql).toMatch(/CREATE TABLE public\.network_managed_resources/i);
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, building_id, device_id\)[\s\S]{0,180}REFERENCES public\.network_devices\(organization_id, building_id, id\)/i,
    );
    expect(sql).toMatch(
      /UNIQUE \(device_id, resource_kind, stable_key\)/i,
    );
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.network_managed_resources\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    const guard = functionBody("network_center_guard_managed_resource_v1");
    expect(guard).toMatch(/stable_key[\s\S]{0,500}cannot change/i);
    expect(guard).toMatch(/enrollment_state[\s\S]{0,700}REVOKED/i);
  });

  it("links each interface to at most one resource using composite tenant identity", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.network_interfaces[\s\S]{0,300}ADD COLUMN(?: IF NOT EXISTS)? managed_resource_id uuid/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*organization_id\s*,\s*building_id\s*,\s*device_id\s*,\s*managed_resource_id\s*\)[\s\S]{0,240}REFERENCES public\.network_managed_resources\s*\(\s*organization_id\s*,\s*building_id\s*,\s*device_id\s*,\s*id\s*\)/i,
    );
    expect(sql).toMatch(
      /UNIQUE INDEX[\s\S]{0,160}network_interfaces_managed_resource[\s\S]{0,160}\(managed_resource_id\)[\s\S]{0,100}managed_resource_id IS NOT NULL/i,
    );
    expect(sql).toMatch(
      /UPDATE public\.network_interfaces[\s\S]{0,160}SET is_managed = false[\s\S]{0,160}managed_resource_id IS NULL/i,
    );
  });

  it("derives managed identity from RouterOS default-name without trusting display name", () => {
    const binding = functionBody("network_center_bind_managed_interface_v1");
    expect(binding).toContain("immutableKey");
    expect(binding).toMatch(/routeros-default-name/i);
    expect(binding).toMatch(/NEW\.interface_role\s*=\s*'ACCESS'/i);
    expect(binding).toMatch(/\^ether/i);
    expect(binding).toMatch(/enrollment_state/i);
    expect(binding).toMatch(/v_protected\s*:=\s*true/i);
    expect(binding).toMatch(/ELSE\s+'DISCOVERED'\s+END/i);
    expect(binding).toMatch(
      /enrolled_role\s*=\s*CASE[\s\S]{0,220}enrollment_state\s*=\s*'DISCOVERED'[\s\S]{0,220}EXCLUDED\.enrolled_role/i,
    );
    expect(binding).toMatch(
      /protected\s*=\s*CASE[\s\S]{0,320}enrollment_state\s*=\s*'ENROLLED'[\s\S]{0,320}eligibleAccess/i,
    );
    expect(binding).toMatch(
      /OLD\.managed_resource_id IS NOT NULL[\s\S]{0,300}immutable identity cannot be removed/i,
    );
    expect(binding).toMatch(
      /OLD\.managed_resource_id IS NOT NULL[\s\S]{0,120}\bOR\s+NEW\.managed_resource_id IS NOT NULL[\s\S]{0,200}immutable identity cannot be removed/i,
    );
    expect(binding).toMatch(/NEW\.interface_key IS DISTINCT FROM v_immutable_key/i);
    expect(binding).toMatch(/immutable identity cannot be rebound/i);
    expect(binding).not.toMatch(/NEW\.display_name\s*~\*[^;]+(?:wan|uplink|ether1)/i);
    expect(sql).toMatch(
      /CREATE TRIGGER network_interfaces_bind_managed_resource[\s\S]{0,320}network_center_bind_managed_interface_v1/i,
    );
  });

  it("rejects cycle commands unless the exact interface resource is enrolled access and unprotected", () => {
    const guard = functionBody("network_center_guard_managed_command_target_v1");
    expect(guard).toMatch(/CYCLE_ACCESS_PORT/i);
    expect(guard).toMatch(/managed_resource_id/i);
    expect(guard).toMatch(/resource_kind\s*=\s*'INTERFACE'/i);
    expect(guard).toMatch(/enrollment_state\s*=\s*'ENROLLED'/i);
    expect(guard).toMatch(/enrolled_role\s*=\s*'ACCESS'/i);
    expect(guard).toMatch(/protected\s*=\s*false/i);
    expect(guard).toMatch(/interface_kind\s*=\s*'ETHERNET'/i);
    expect(guard).toMatch(/stable_key\s*~\*\s*'\^ether/i);
    expect(guard).toMatch(/RAISE EXCEPTION 'Managed access interface is required'/i);
    expect(sql).toMatch(
      /CREATE TRIGGER network_commands_managed_target_guard[\s\S]{0,320}network_center_guard_managed_command_target_v1/i,
    );
  });

  it("keeps discovery protected until a private helper enrolls one physical access port", () => {
    const enrollment = functionBody("network_center_enroll_access_interface_v1");
    expect(enrollment).toMatch(/resource_kind\s*=\s*'INTERFACE'/i);
    expect(enrollment).toMatch(/enrollment_state\s*=\s*'DISCOVERED'/i);
    expect(enrollment).toMatch(/enrolled_role\s*=\s*'ACCESS'/i);
    expect(enrollment).toMatch(/metadata\s*->>\s*'eligibleAccess'\s*=\s*'true'/i);
    expect(enrollment).toMatch(/stable_key\s*~\*\s*'\^ether/i);
    expect(enrollment).toMatch(/interface_kind\s*=\s*'ETHERNET'/i);
    expect(enrollment).toMatch(/SET enrollment_state = 'ENROLLED'[\s\S]{0,160}protected = false/i);
    expect(enrollment).toMatch(/SET is_protected = false/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+app_private\.network_center_enroll_access_interface_v1\(uuid\)[\s\S]{0,120}FROM PUBLIC, anon, authenticated, service_role/i,
    );
  });

  it("provides a private authoritative interface mapping for the final worker inventory RPC", () => {
    const mapping = functionBody("network_center_managed_interface_mapping_v1");
    expect(mapping).toMatch(/RETURNS jsonb/i);
    expect(mapping).toMatch(/network_interfaces[\s\S]{0,800}network_managed_resources/i);
    for (const field of [
      "managedResourceId",
      "interfaceKey",
      "currentName",
      "immutableKey",
      "enrolledRole",
      "protected",
      "enrollmentState",
    ]) expect(mapping).toContain(`'${field}'`);
    expect(mapping).toMatch(/WHERE interface\.device_id = p_device_id/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+app_private\.network_center_managed_interface_mapping_v1\(uuid\)[\s\S]{0,120}FROM PUBLIC, anon, authenticated, service_role/i,
    );
  });

  it("keeps security-definer helpers private and search-path pinned", () => {
    for (const { name, signature } of [
      { name: "network_center_guard_managed_resource_v1", signature: "" },
      { name: "network_center_bind_managed_interface_v1", signature: "" },
      { name: "network_center_enroll_access_interface_v1", signature: "uuid" },
      { name: "network_center_guard_managed_command_target_v1", signature: "" },
    ]) {
      const body = functionBody(name);
      expect(body).toMatch(/SECURITY DEFINER/i);
      expect(body).toMatch(/SET search_path TO 'pg_catalog', 'app_private', 'public'/i);
      expect(sql).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION\\s+app_private\\.${name}\\(${signature}\\)[\\s\\S]{0,100}FROM PUBLIC, anon, authenticated, service_role`,
        "i",
      ));
    }
  });
});
