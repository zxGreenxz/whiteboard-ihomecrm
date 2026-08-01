import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../../supabase/migrations/20260729134000_network_center_admin_control_plane.sql",
  import.meta.url,
);

function migrationSource() {
  assert.equal(existsSync(migrationUrl), true, "additive admin control-plane migration missing");
  return readFileSync(migrationUrl, "utf8");
}

function functionBody(source, name) {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`,
    "i",
  );
  const match = source.match(pattern);
  assert.ok(match, `${name} definition missing`);
  return match[0];
}

test("admin control plane is additive and exposes only service-role RPCs", () => {
  const source = migrationSource();
  for (const name of [
    "network_center_admin_provision_connection_v1",
    "network_center_admin_set_rollout_v1",
    "network_center_admin_status_v1",
  ]) {
    assert.match(source, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(`, "i"));
    assert.match(source, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role`, "i"));
  }
  assert.match(source, /CREATE UNIQUE INDEX[\s\S]*network_device_connections[\s\S]*WHERE is_enabled/i);
  assert.match(source, /REVOKE ALL ON TABLE public\.network_device_connections[\s\S]*service_role/i);
  assert.match(source, /REVOKE ALL ON TABLE public\.network_site_settings[\s\S]*service_role/i);
});

test("connection provisioning accepts only opaque refs and pinned RouterOS SSH host keys", () => {
  const body = functionBody(migrationSource(), "network_center_admin_provision_connection_v1");
  assert.doesNotMatch(body, /p_(?:credential_)?secret|password/i);
  assert.match(body, /p_transport[\s\S]*ROUTEROS_SSH/i);
  assert.match(body, /p_credential_ref[\s\S]*\^router\//i);
  assert.match(body, /p_host_key_fingerprint[\s\S]*\^SHA256:/i);
  assert.match(body, /FROM public\.buildings[\s\S]*FOR UPDATE/i);
  assert.match(body, /FROM public\.network_site_settings[\s\S]*FOR UPDATE/i);
  assert.match(body, /FROM public\.network_devices[\s\S]*FOR UPDATE/i);
  assert.match(body, /UPDATE public\.network_device_connections[\s\S]*is_enabled = false/i);
  assert.match(body, /INSERT INTO public\.network_audit_events/i);
});

test("rollout mutation is CAS guarded, monotonic upward and durably audited", () => {
  const body = functionBody(migrationSource(), "network_center_admin_set_rollout_v1");
  assert.match(body, /p_expected_version bigint/i);
  assert.match(body, /FROM public\.buildings[\s\S]*FOR UPDATE/i);
  assert.match(body, /FROM public\.network_site_settings[\s\S]*FOR UPDATE/i);
  assert.match(body, /version[\s\S]*(?:<>|IS DISTINCT FROM)[\s\S]*p_expected_version/i);
  assert.match(body, /OFF[\s\S]*READ_ONLY[\s\S]*EXECUTE/i);
  assert.match(body, /OFF[^\n]*EXECUTE|OFF[\s\S]{0,180}EXECUTE/i);
  assert.match(body, /INSERT INTO public\.network_audit_events/i);
});

test("status is read-only, bounded and never exposes credential digests", () => {
  const body = functionBody(migrationSource(), "network_center_admin_status_v1");
  const executableBody = body.slice(body.indexOf("AS $fn$"));
  assert.match(body, /p_limit integer/i);
  assert.match(body, /BETWEEN 1 AND 200/i);
  assert.doesNotMatch(executableBody, /secret_digest|credential_secret|password/i);
  assert.doesNotMatch(executableBody, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
});
