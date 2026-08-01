import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = [
  "preflight-host.sh",
  "provision-rootless.sh",
  "render-cell.sh",
  "deploy-cell.sh",
  "verify-isolation.sh",
  "smoke-cell.sh",
  "rollback-cell.sh",
  "snapshot-host-baseline.sh",
  "rotate-secrets.sh",
];

async function text(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("Task 19 host and lifecycle scripts", () => {
  it("ships strict POSIX entrypoints and never targets rootful/global host controls", async () => {
    for (const name of scripts) {
      const path = `infra/openclaw-zalo/scripts/${name}`;
      const [source, metadata] = await Promise.all([text(path), stat(resolve(root, path))]);
      expect(source.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
      expect(metadata.isFile()).toBe(true);
      if (name !== "verify-isolation.sh") expect(source).not.toMatch(/\/var\/run\/docker\.sock/i);
      expect(source).not.toMatch(/systemctl\s+(?:stop|restart)\s+docker\b/i);
      expect(source).not.toMatch(/\bufw\b|iptables|nft\s/i);
      expect(source).not.toMatch(/ssh[^\n]*(?:9router|cli-proxy)|DOCKER_HOST[^\n]*(?:9router|cli-proxy)/i);
      expect(source).not.toMatch(/\beval\b/);
    }
  });

  it("preflights the dedicated rootless socket, data root, filesystem budget, and quota record", async () => {
    const source = await text("infra/openclaw-zalo/scripts/preflight-host.sh");
    expect(source).toContain("openclaw-runner");
    expect(source).toContain("/srv/openclaw-runtime");
    expect(source).toContain("/run/user/$runner_uid/docker.sock");
    expect(source).toContain("OPENCLAW_TRANSFER_QUOTA_RECORD");
    expect(source).toContain("20971520");
    expect(source).toContain("docker info");
    expect(source).toContain("SecurityOptions");
    expect(source).toContain("rootless");
  });

  it("renders one canonical UUID-bound project without accepting a free-form production cell id", async () => {
    const source = await text("infra/openclaw-zalo/scripts/render-cell.sh");
    expect(source).toContain("--runtime-env");
    expect(source).not.toMatch(/--cell-id/);
    expect(source).toContain("OPENCLAW_CELL_ID");
    expect(source).toContain("canonical UUID");
    expect(source).toContain("openclaw-zalo-$cell_id");
    expect(source).toContain("docker compose");
    expect(source).toContain("config --quiet");
    expect(source).not.toMatch(/cat\s+.*(?:secret|runtime-env)|set\s+-x/i);
  });

  it("prevalidates candidates and restores the exact active stack after a failed update", async () => {
    const source = await text("infra/openclaw-zalo/scripts/deploy-cell.sh");
    const validate = source.indexOf("validate_candidate");
    const inspect = source.indexOf('docker image inspect "$image"');
    const capture = source.indexOf("capture_active_stack");
    const snapshot = source.indexOf("snapshot-host-baseline.sh");
    const mutate = source.lastIndexOf("mutation_started=1");
    const deploy = source.lastIndexOf(" up -d ");
    const verify = source.indexOf("verify-isolation.sh");
    expect(validate).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(validate);
    expect(capture).toBeGreaterThan(validate);
    expect(snapshot).toBeGreaterThan(-1);
    expect(mutate).toBeGreaterThan(snapshot);
    expect(deploy).toBeGreaterThan(snapshot);
    expect(verify).toBeGreaterThan(deploy);
    expect(source).toContain("rollback-cell.sh");
    expect(source).toContain("restore_active_stack");
    expect(source).toContain("had_active_stack");
    for (const digest of [
      "old_cell_digest",
      "old_bridge_digest",
      "old_maintenance_digest",
      "old_egress_digest",
    ]) {
      expect(source).toContain(digest);
    }
    expect(source).toContain("--project-name");
    expect(source).toContain("pull_policy");
    expect(source).not.toMatch(/compose\s+down/);
    expect(source).not.toMatch(/docker\s+(?:stop|rm|restart|system\s+prune)\b/);

    const rollback = await text("infra/openclaw-zalo/scripts/rollback-cell.sh");
    expect(rollback).toContain("docker compose");
    expect(rollback).toContain("--project-name");
    expect(rollback).toContain(" down ");
    expect(rollback).not.toMatch(/--volumes|-v\b|volume\s+(?:rm|prune)|system\s+prune/);
  });

  it("tests direct isolation from every app container and uses only the DEMO caller vector", async () => {
    const source = await text("infra/openclaw-zalo/scripts/verify-isolation.sh");
    for (const service of ["cell", "bridge", "maintenance"]) {
      expect(source).toContain(`exec -T ${service}`);
    }
    expect(source).toContain("dddd2000-0000-4000-8000-000000000001");
    expect(source).toContain("--session-encryption");
    expect(source).toContain("169.254.169.254");
    expect(source).toContain("host-gateway");
    expect(source).toContain("docker.sock");
    expect(source).toContain("dns-rebinding");
    expect(source).toContain("allowed-route");
  });

  it("uses a synthetic session canary and never reads real Zalo credentials", async () => {
    const source = await text("infra/openclaw-zalo/scripts/smoke-cell.sh");
    expect(source).toContain("--session-encryption");
    expect(source).toContain("synthetic-canary.json");
    expect(source).toContain("persist");
    expect(source).toContain("restore");
    expect(source).toContain("rotate");
    expect(source).toContain("tamper");
    expect(source).not.toMatch(/credentials(?:-[^/]+)?\.json/);
  });

  it("owns internal agent transcript cleanup at supported lifecycle and startup boundaries", async () => {
    const source = await text("services/openclaw-zalo-cell/scripts/entrypoint.sh");
    expect(source.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
    expect(source).toContain('OPENCLAW_INTERNAL_AGENT_RUNS_DIR');
    expect(source).toContain("internal-agent-runs");
    expect(source).toMatch(/find[^\n]+-name ['"]\\?\*\.jsonl['"][^\n]+-delete/);
    expect(source).toContain("trap 'shutdown TERM' TERM");
    expect(source).toContain("trap 'shutdown INT' INT");
    expect(source).toContain("session_restore");
    expect(source).toContain("session_persist");
    expect(source).toContain("wait_for_child");
    expect(source).toContain('kill -0 "$child_pid"');
    expect(source).toContain('exit "$child_status"');
    expect(source).toMatch(/AUTHENTICATION_FAILED\|UNKNOWN_KEY_GENERATION\|MALFORMED_ENVELOPE/);
    expect(source).toContain("encrypted Zalo session unavailable; starting QR login");
    expect(source).toMatch(/case "\$error_code"[\s\S]+\*\)[\s\S]+response_ok/);
    expect(source).toContain("/opt/openclaw-cell/session-crypto/dist/daemon.js");
    expect(source).not.toMatch(/npm\s+(?:install|ci)|openclaw[^\n]+rpc|zalouser\.bridge\.[a-z-]+/i);
  });

  it("forces an ordered QR relogin when rotating the session encryption key", async () => {
    const source = await text("infra/openclaw-zalo/scripts/rotate-secrets.sh");
    const stop = source.indexOf("compose stop --timeout 30 cell");
    const clear = source.indexOf("rm -f /var/lib/openclaw-session/zalouser/credentials.json");
    const replace = source.indexOf('mv -f "$tmp" "$secret_dir/$name"');
    const restart = source.lastIndexOf("compose up -d --no-build --wait cell");
    expect(stop).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(stop);
    expect(replace).toBeGreaterThan(clear);
    expect(restart).toBeGreaterThan(replace);
    expect(source).toContain("resume_after_rotation_failure");
    expect(source).toContain("QR login required");
    expect(source).not.toMatch(/cat\s+.*(?:secret|source_file)|set\s+-x/i);
  });

  it("applies the approved systemd limits to the rootless service user only", async () => {
    const userUnit = await text("infra/openclaw-zalo/systemd/user/openclaw-stack@.service");
    expect(userUnit).toContain("Environment=DOCKER_HOST=unix:///run/user/%U/docker.sock");
    expect(userUnit).toContain("Requires=docker.service");
    expect(userUnit).toContain("openclaw-zalo-%i");
    expect(userUnit).not.toContain("User=root");

    const slice = await text(
      "infra/openclaw-zalo/systemd/system/user-openclaw-runner.slice.conf.tmpl",
    );
    expect(slice).toContain("CPUQuota=180%");
    expect(slice).toContain("MemoryHigh=2200M");
    expect(slice).toContain("MemoryMax=2800M");
    expect(slice).toContain("MemorySwapMax=2G");
    expect(slice).toContain("TasksMax=512");
  });

  it("records only the dedicated rootless/OpenClaw baseline plus a content-free authenticated model probe", async () => {
    const source = await text("infra/openclaw-zalo/scripts/snapshot-host-baseline.sh");
    for (const field of ["Id", "Image", "Networks", "Mounts", "RestartCount", "Ports"]) {
      expect(source).toContain(field);
    }
    expect(source).toContain("systemctl --user");
    expect(source).toContain("/srv/openclaw-runtime");
    expect(source).toContain("ai.chillhome.io.vn");
    expect(source).toContain("--output /dev/null");
    expect(source).not.toMatch(/ssh|9router|cli-proxy|docker context/i);
  });
});
