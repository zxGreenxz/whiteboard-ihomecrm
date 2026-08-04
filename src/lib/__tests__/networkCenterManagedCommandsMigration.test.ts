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

  it("adds typed intent metadata and append-only observations", () => {
    for (const column of [
      "managed_target jsonb",
      "intent_type text",
      "pre_observation jsonb",
      "expected_postcondition jsonb",
      "observation_deadline timestamptz",
      "transition_version bigint",
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
    }
    expect(sql).toMatch(/CREATE TABLE public\.network_command_observations/i);
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, building_id, command_id\)[\s\S]{0,180}REFERENCES public\.network_commands\(organization_id, building_id, id\)/i,
    );
    expect(sql).toMatch(/network_command_observations_append_only/i);
    expect(sql).toMatch(/network_center_guard_command_observations_v1/i);
    expect(sql).toMatch(/fencing_generation\s+bigint\s+not null/i);
    expect(sql).toMatch(/evidence_hash\s+(?:character\(64\)|text)\s+not null/i);
    expect(sql).toMatch(/observation_kind\s+text[\s\S]{0,220}PRE_ACTION[\s\S]{0,80}POST_ACTION[\s\S]{0,80}RECONCILIATION/i);
    expect(sql).toMatch(/UNIQUE\s*\(command_id,\s*id\)/i);
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.network_command_observations\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    const targetGuard = functionBody("network_center_guard_managed_command_target_v1");
    expect(targetGuard).toMatch(
      /TG_OP\s*=\s*'INSERT'[\s\S]{0,220}NEW\.pre_observation\s*:=\s*NULL[\s\S]{0,120}NEW\.transition_version\s*:=\s*1/i,
    );
  });

  it("makes one fenced SQL transition the only authority that can write SUCCEEDED", () => {
    const transition = functionBody("network_center_transition_command_v1");
    const successGuard = functionBody("network_center_guard_command_success_v1");

    expect(transition).toMatch(/p_transition_version bigint/i);
    expect(transition).toMatch(/p_fencing_generation bigint/i);
    expect(transition).toMatch(/lease_token\s*=\s*p_lease_token/i);
    expect(transition).toMatch(/lease\.generation\s*=\s*p_fencing_generation/i);
    expect(transition).toMatch(/lease\.expires_at\s*>\s*clock_timestamp\(\)/i);
    expect(transition).toMatch(/transition_version\s*=\s*p_transition_version/i);
    expect(transition).toMatch(/FOR UPDATE/i);
    expect(transition).not.toMatch(/p_observations|jsonb_array_elements/i);
    expect(transition).toMatch(/network_command_observations/i);
    expect(transition).toMatch(/network_center_evaluate_postcondition_v1/i);
    expect(transition).toMatch(/transition_version\s*=\s*command\.transition_version\s*\+\s*1/i);
    expect(successGuard).toMatch(/NEW\.status\s*=\s*'SUCCEEDED'/i);
    expect(successGuard).toMatch(/network_center_success_authority/i);
    expect(sql).toMatch(
      /CREATE TRIGGER network_commands_success_authority[\s\S]{0,260}network_center_guard_command_success_v1/i,
    );
  });

  it("evaluates every action-specific postcondition without generic reachability success", () => {
    const evaluator = functionBody("network_center_evaluate_postcondition_v1");
    expect(evaluator).toMatch(/FLUSH_DNS_CACHE[\s\S]{0,1000}dnsAck/i);
    expect(evaluator).toMatch(/RENEW_DHCP_LEASE[\s\S]{0,1400}DHCP_RENEW_NOT_APPLICABLE/i);
    expect(evaluator).toMatch(/leaseExpiresInSeconds/i);
    expect(evaluator).toMatch(/CYCLE_ACCESS_PORT[\s\S]{0,1600}managedResourceId/i);
    expect(evaluator).toMatch(/disabledObserved/i);
    expect(evaluator).toMatch(/REBOOT_ROUTER[\s\S]{0,1200}bootId/i);
    expect(evaluator).toMatch(/uptimeSeconds/i);
    expect(evaluator).toMatch(/CAPTURE_SNAPSHOT[\s\S]{0,1200}redactedContentHash/i);
    expect(evaluator).toMatch(/encryptedArtifactHash/i);
    expect(evaluator).toMatch(/network_config_snapshots/i);
    expect(evaluator).toMatch(/'UNCERTAIN'/i);
    expect(evaluator).not.toMatch(/reachable[^;]{0,200}'SUCCEEDED'/i);
  });

  it("provides an exact tenant-scoped command lookup for reconnect and duplicate recovery", () => {
    const lookup = functionBody("network_center_get_command_v1");
    expect(lookup).toMatch(/p_building_id uuid/i);
    expect(lookup).toMatch(/p_command_id uuid/i);
    expect(lookup).toMatch(/p_request_id uuid/i);
    expect(lookup).toMatch(/network_center_require_view_v1\(p_building_id\)/i);
    expect(lookup).toMatch(/command\.id\s*=\s*p_command_id/i);
    expect(lookup).toMatch(/command\.idempotency_key\s*=\s*p_request_id::text/i);
    expect(lookup).toMatch(/command\.requested_by\s*=\s*auth\.uid\(\)/i);
    expect(lookup).toMatch(/'transitionVersion'/i);
    expect(lookup).toMatch(/'status'/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.network_center_get_command_v1\(uuid,\s*uuid,\s*uuid\)\s+TO authenticated/i,
    );
  });

  it("persists observations before completion and retains them with command history", () => {
    const recordObservation = functionBody("network_center_record_command_observation_v1");
    expect(recordObservation).toMatch(/p_observation_id uuid/i);
    expect(recordObservation).toMatch(/p_fencing_generation bigint/i);
    expect(recordObservation).toMatch(/FOR UPDATE/i);
    expect(recordObservation).toMatch(/network_device_leases/i);
    expect(recordObservation).toMatch(/transition_version\s*=\s*command\.transition_version\s*\+\s*1/i);
    expect(recordObservation).toMatch(/p_observation_id[\s\S]{0,3500}evidence_hash/i);
    expect(sql).toMatch(
      /CREATE TRIGGER network_command_observations_append_only[\s\S]{0,220}network_center_guard_command_observations_v1/i,
    );
    expect(sql).toMatch(
      /DELETE FROM public\.network_command_observations[\s\S]{0,1200}network_center_retention_pre_observations_v1\(p_now\)/i,
    );
  });

  it("stores the encrypted backup hash on the authoritative snapshot row", () => {
    expect(sql).toMatch(/ALTER TABLE public\.network_config_snapshots[\s\S]{0,180}encrypted_artifact_hash/i);
    expect(sql).toMatch(/network_config_snapshots_encrypted_hash_check[\s\S]{0,400}encrypted_artifact_hash[\s\S]{0,180}\^\[a-f0-9\]\{64\}\$/i);
    const snapshot = functionBody("network_center_worker_snapshot_v1");
    expect(snapshot).toMatch(/encryptedArtifactHash/i);
    expect(snapshot).toMatch(/encrypted_artifact_hash/i);
    expect(snapshot).toMatch(/v_snapshot\.encrypted_artifact_hash\s+IS DISTINCT FROM\s+v_encrypted_artifact_hash/i);
  });

  it("revokes the exact fenced helper signatures", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+app_private\.network_center_record_command_observation_v1\(\s*text,\s*uuid,\s*uuid,\s*bigint,\s*bigint,\s*uuid,\s*text,\s*timestamp with time zone,\s*jsonb\s*\)/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+app_private\.network_center_transition_command_v1\(\s*text,\s*uuid,\s*uuid,\s*bigint,\s*bigint,\s*text,\s*jsonb,\s*jsonb,\s*integer\s*\)/i,
    );
  });

  it("qualifies the lease upsert conflict target inside the TABLE-returning claim function", () => {
    for (const functionName of [
      "network_center_claim_commands_v1",
      "network_center_claim_reconciliation_v1",
    ]) {
      const claim = functionBody(functionName);
      expect(claim).toMatch(
        /ON CONFLICT ON CONSTRAINT network_device_leases_pkey DO UPDATE/i,
      );
      expect(claim).not.toMatch(/ON CONFLICT\s*\(device_id\)/i);
    }
  });
});
