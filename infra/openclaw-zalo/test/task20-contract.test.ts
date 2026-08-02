import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const text = async (path: string) => await readFile(resolve(root, path), "utf8");

describe("Task 20 watchdog and recovery contracts", () => {
  it("owns the exact host guard shell/service/timer paths and valid source", async () => {
    const paths = [
      "infra/openclaw-zalo/scripts/openclaw-host-guard.sh",
      "infra/openclaw-zalo/systemd/user/openclaw-host-guard.service",
      "infra/openclaw-zalo/systemd/user/openclaw-host-guard.timer",
    ];
    await Promise.all(paths.map((path) => access(resolve(root, path), constants.R_OK)));
    const guard = await text(paths[0]!);
    for (const threshold of [
      "router_p95_regression\" 20", "router_error_rate\" 1", "ram_percent\" 75",
      "swap_percent\" 10", "load_one\" 12", "root_free_gib\" 200", "root_free_percent\" 20",
    ]) expect(guard).toContain(threshold);
    expect(guard).toContain("PAUSE_OUTBOUND_AI_MEDIA");
    expect(guard).toContain("openclaw_zalo.manage_operations");
    expect(guard).toContain("stop --timeout 30 cell bridge");
    expect(guard).not.toMatch(/systemctl\s+(?:stop|restart|kill)\s+(?:9router|cli-proxy)|docker\s+--host|\/var\/run\/docker\.sock/iu);

    const service = await text(paths[1]!);
    expect(service).toContain("DOCKER_HOST=unix:///run/user/%U/docker.sock");
    expect(service).toContain("openclaw-host-guard.sh --runtime-env");
    expect(service).not.toContain("User=root");
    const timer = await text(paths[2]!);
    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("Persistent=true");

    if (process.platform !== "win32") {
      for (const script of [paths[0]!, "infra/openclaw-zalo/scripts/restore-drill.sh", "infra/openclaw-zalo/scripts/migrate-cell.sh"]) {
        const result = spawnSync("sh", ["-n", resolve(root, script)], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      }
    }
  });

  it("requires restore RPO/RTO, R2 grace, key rotation and plaintext proof", async () => {
    const source = await text("infra/openclaw-zalo/scripts/restore-drill.sh");
    for (const required of [
      "rpo_seconds\" -le 900", "rto_seconds\" -le 14400", "--grace-seconds 604800",
      "openclaw_runtime_credential", "openclaw_maintenance_credential",
      "openclaw_gateway_device_token", "openclaw_audit_private_key",
      "session-reencrypt-atomic", "session-require-fresh-qr-login",
      "prove-no-plaintext-session-snapshot", "plaintextSessionSnapshotFound\\\":false",
    ]) expect(source).toContain(required);
    expect(source).toContain("dddd0000-0000-4000-8000-000000000001");
    expect(source).not.toContain("aaaa0000-0000-4000-8000-000000000001");
  });

  it("freezes migration in GLOBAL_STOP/drain/fence/revoke/relogin order", async () => {
    const source = await text("infra/openclaw-zalo/scripts/migrate-cell.sh");
    const sequence = [
      "run global-stop", "run drain-outbox", "run freeze-outbox",
      "run move-expired-dispatching-to-unknown", "run snapshot-old-cotenants",
      "run provision-new-rootless-cell", "run rotate-workload-credentials",
      "run acquire-higher-fencing-lease", "run revoke-old-credential-and-lease",
      "run require-fresh-qr-login", "run sync-history --hours 48",
      "run reconcile-gaps-and-unknown", "run controlled-smoke", "run compare-cotenants",
      "run resume-organization",
    ];
    let previous = -1;
    for (const marker of sequence) {
      const index = source.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(source).toContain("--supabase-copy false --r2-copy false");
    expect(source).toContain("target_rto_seconds=3600");
    expect(source).toContain("GLOBAL_STOP remains active");
  });

  it("documents required evidence, co-tenant comparison, and quota gates", async () => {
    const runbookPaths = [
      "deploy.md", "operations.md", "backup-restore.md", "vps-migration.md",
      "rollback.md", "secret-rotation.md", "capacity.md",
    ].map((name) => `docs/openclaw-zalo/runbooks/${name}`);
    const combined = (await Promise.all(runbookPaths.map(text))).join("\n");
    for (const required of [
      "RPO <= 15 minutes", "RTO <= 4 hours", "GLOBAL_STOP", "UNKNOWN",
      "fresh QR", "48-hour history", "co-tenant", "restore drill", "60%", "80%", "90%", "100%",
      "openclaw_zalo.manage_operations", "Supabase and R2", "not copied",
    ]) expect(combined.toLowerCase()).toContain(required.toLowerCase());
    expect(combined).toContain("actual RPO/RTO");
    expect(combined).toContain("no plaintext session snapshot");
  });
});
