import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The watchdog reads health from the database and writes capacity controls there,
 * because the two `/openclaw-health/v1/*` URLs it used to call would have required
 * an INBOUND port on the VPS that holds the Zalo session - forbidden by the frozen
 * design spec. These assertions pin the properties that make that safe.
 */
const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql",
);
// Normalised so assertions do not depend on the checkout's line endings.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/gu, "\n");

function section(name: string): string {
  const start = migration.indexOf(`create or replace function ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} is unterminated`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("OpenClaw watchdog egress surface migration", () => {
  it("creates the durable envelope nonce store with a one-time uniqueness rule", () => {
    expect(migration).toContain("create table public.openclaw_watchdog_envelope_nonces");
    // The replay guard IS this index. An in-process map cannot be one: Supabase
    // Edge Functions run many isolates, so a captured envelope replayed against a
    // cold isolate inside its clock window would otherwise be accepted.
    expect(migration).toContain("unique (organization_id, nonce_hash)");
    expect(migration).toMatch(
      /check \(expires_at > signed_at and expires_at <= signed_at \+ interval '2 minutes'\)/u,
    );
    const consume = section("app_private.openclaw_consume_watchdog_envelope_nonce_v1");
    expect(consume).toContain("on conflict (organization_id, nonce_hash) do nothing");
    expect(consume).toContain("watchdog envelope nonce replay rejected");
    // Domain separation keeps a watchdog nonce from colliding with any other nonce.
    expect(consume).toContain("ihome-openclaw-watchdog-envelope-nonce-v1");
    // The database refuses to store what it could not have just authenticated.
    expect(consume).toMatch(/statement_timestamp\(\) - v_signed_at\)\)\) > 90/u);
  });

  it("keeps capacity controls single-active, manual-resume, and idempotent", () => {
    expect(migration).toContain("create table public.openclaw_capacity_controls");
    expect(migration).toMatch(
      /create unique index openclaw_capacity_controls_active_uidx[\s\S]*?where released_at is null/u,
    );
    expect(migration).toContain("requires_manual_resume boolean not null default true");
    const apply = section("app_private.openclaw_apply_capacity_controls_v1");
    // A retried watchdog tick must not double-apply: the partial unique index
    // collapses the repeat instead of inserting a second active row.
    expect(apply).toContain("on conflict (organization_id, control) where released_at is null do nothing");
    expect(apply).toContain("bounded capacity controls required");
    for (const control of [
      "DISABLE_AUTOMATIC_VIDEO_FILE_CACHE",
      "PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA",
      "PAUSE_ALL_OUTBOUND_MEDIA",
      "PAUSE_OUTBOUND_AI_MEDIA",
    ]) expect(migration).toContain(control);
  });

  it("derives the snapshot from the heartbeat the cell already pushes outward", () => {
    const snapshot = section("app_private.openclaw_watchdog_snapshot_v1");
    expect(snapshot).toContain("public.openclaw_runtime_cells");
    expect(snapshot).toContain("last_heartbeat_at");
    expect(snapshot).toContain("RUNTIME_HEARTBEAT");
    expect(snapshot).toContain("content_free_metrics");
    // Content-free by construction: no message, QR, session, or provider payload.
    expect(snapshot).not.toMatch(/openclaw_messages|openclaw_qr_challenges|ciphertext|payload/u);
  });

  it("authenticates the two new operations as a maintenance principal with one scope", () => {
    const context = section("app_private.openclaw_watchdog_service_context_v1");
    expect(context).toContain("'openclaw_watchdog_snapshot_v1', 'openclaw_apply_capacity_controls_v1'");
    expect(context).toContain("watchdog service operation matrix mismatch");
    expect(context).toContain("'watchdog.health' = any(credential.allowed_scopes)");
    expect(context).toContain("lease.status = 'ACTIVE'");
    expect(context).toContain("lease.fencing_token = v_fencing_token");
    expect(context).toContain("principal.is_current and principal.revoked_at is null");
    expect(context).toContain("service request hash mismatch");
    expect(context).toContain("service envelope expired or outside DB time window");
    // A channel principal must never reach this surface.
    expect(context).toContain("watchdog principal kind mismatch");
  });

  it("spends a service nonce on both new public facades", () => {
    for (const facade of [
      "public.openclaw_service_watchdog_snapshot_v1",
      "public.openclaw_service_apply_capacity_controls_v1",
    ]) {
      const body = section(facade);
      expect(body).toContain("app_private.openclaw_watchdog_service_context_v1");
      expect(body).toContain("app_private.openclaw_consume_service_nonce_v1");
    }
  });

  it("delivers active controls in the heartbeat response without touching its reviewed body", () => {
    const wrapper = section("public.openclaw_service_runtime_heartbeat_v1");
    expect(wrapper).toContain("app_private.openclaw_runtime_heartbeat_v1(v_context, p_envelope, p_request)");
    expect(wrapper).toContain("capacityControls");
    expect(wrapper).toContain("control.released_at is null");
    // No new command kind and no change to the runtime command state machine.
    expect(wrapper).not.toContain("openclaw_runtime_commands");
  });

  it("grants each reader BOTH a policy and a privilege, since no role bypasses RLS", () => {
    for (const table of [
      "openclaw_capacity_controls",
      "openclaw_watchdog_envelope_nonces",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
    }
    // The heartbeat wrapper is owned by openclaw_service_dispatcher, the snapshot by
    // openclaw_maintenance_writer; a grant alone reads nothing under forced RLS.
    expect(migration).toContain("openclaw_capacity_controls_service_dispatcher_select");
    expect(migration).toContain("grant select on public.openclaw_capacity_controls to openclaw_service_dispatcher");
    expect(migration).toContain("openclaw_runtime_cells_watchdog_writer_select");
    expect(migration).toContain("grant select on public.openclaw_runtime_cells to openclaw_maintenance_writer");
    // The browser may audit controls, never the nonce store.
    expect(migration).toContain("openclaw_capacity_controls_authenticated_audit_select");
    expect(migration).not.toMatch(/openclaw_watchdog_envelope_nonces[\s\S]{0,200}to authenticated/u);
  });

  it("revokes the new facades from every browser-facing role", () => {
    for (const facade of [
      "public.openclaw_service_watchdog_snapshot_v1(jsonb,jsonb,jsonb)",
      "public.openclaw_service_apply_capacity_controls_v1(jsonb,jsonb,jsonb)",
      "public.openclaw_service_consume_watchdog_envelope_nonce_v1(jsonb)",
    ]) {
      expect(migration).toContain(
        `revoke all on function ${facade}\n  from public, anon, authenticated, service_role;`,
      );
      expect(migration).toContain(`grant execute on function ${facade}\n  to service_role;`);
    }
  });
});
