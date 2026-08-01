import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pinnedNodePath = "/opt/openclaw-tools/node-v24.15.0-linux-x64/bin/node";
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
    expect(source).toContain("load_active_snapshot");
    expect(source).toContain("persist_active_snapshot");
    expect(source).toContain("cleanup_failed_snapshot");
    expect(source).toContain("cleanup_previous_snapshot");
    expect(source).toContain("active_secret_snapshot");
    expect(source).toContain("--force-recreate");
    expect(source).toContain('deployment_state_root="$runtime_root/operations/$cell_id/deployments"');
    expect(source).toContain('secret_snapshots_root="$runtime_root/secrets/$cell_id/.deployments"');
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

  it.skipIf(process.platform === "win32")(
    "restores the prior metadata, secrets, config, and images when deployment fails",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-deploy-rollback-"));
      const cellId = "dddd2000-0000-4000-8000-000000000001";
      const services = ["cell", "bridge", "maintenance", "egress-broker"] as const;
      const imageRepositories = {
        cell: "ihome/openclaw-zalo-cell",
        bridge: "ihome/openclaw-zalo-bridge",
        maintenance: "ihome/openclaw-zalo-maintenance",
        "egress-broker": "ihome/openclaw-egress-broker",
      };
      const secretNames = [
        "openclaw_session_key",
        "openclaw_zalo_bridge_hmac",
        "openclaw_customer_ai_key",
        "openclaw_runtime_credential",
        "openclaw_gateway_device_token",
        "openclaw_gateway_device_identity",
        "openclaw_qr_encryption_key",
        "openclaw_maintenance_credential",
        "openclaw_audit_private_key",
      ] as const;
      const oldDigests = {
        cell: "a".repeat(64),
        bridge: "b".repeat(64),
        maintenance: "c".repeat(64),
        "egress-broker": "d".repeat(64),
      };
      const newDigests = {
        cell: "e".repeat(64),
        bridge: "f".repeat(64),
        maintenance: "1".repeat(64),
        "egress-broker": "2".repeat(64),
      };
      const envText = (digests: typeof oldDigests) =>
        [
          "OPENCLAW_CELL_ID=" + cellId,
          "OPENCLAW_CELL_IMAGE_SHA256=" + digests.cell,
          "OPENCLAW_BRIDGE_IMAGE_SHA256=" + digests.bridge,
          "OPENCLAW_MAINTENANCE_IMAGE_SHA256=" + digests.maintenance,
          "OPENCLAW_EGRESS_BROKER_IMAGE_SHA256=" + digests["egress-broker"],
          "",
        ].join("\n");

      try {
        const fakeInfra = join(work, "infra");
        const fakeScripts = join(fakeInfra, "scripts");
        const fakeBin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "candidate.env");
        const dockerLog = join(work, "docker.log");
        const upCount = join(work, "up-count");
        const snapshotName = "snapshot-old";
        const deploymentRoot = join(runtimeRoot, "operations", cellId, "deployments");
        const snapshotRoot = join(deploymentRoot, "snapshots", snapshotName);
        const liveSecretRoot = join(runtimeRoot, "secrets", cellId);
        const oldSecretRoot = join(liveSecretRoot, ".deployments", snapshotName);
        const liveConfig = join(runtimeRoot, "config", cellId, "egress-allowlist.yaml");

        await mkdir(fakeScripts, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(snapshotRoot, { recursive: true });
        await mkdir(oldSecretRoot, { recursive: true });
        await mkdir(dirname(liveConfig), { recursive: true });
        await mkdir(join(runtimeRoot, "operations"), { recursive: true });
        await writeFile(join(runtimeRoot, "operations", "transfer-quota.json"), "{}\n");
        await copyFile(
          resolve(root, "infra/openclaw-zalo/scripts/deploy-cell.sh"),
          join(fakeScripts, "deploy-cell.sh"),
        );
        await chmod(join(fakeScripts, "deploy-cell.sh"), 0o755);
        await writeFile(join(fakeInfra, "compose.cell.yaml"), "name: candidate\n");
        await writeFile(runtimeEnv, envText(newDigests));
        await chmod(runtimeEnv, 0o600);
        await writeFile(join(snapshotRoot, "runtime.env"), envText(oldDigests));
        await chmod(join(snapshotRoot, "runtime.env"), 0o600);
        await writeFile(join(snapshotRoot, "compose.cell.yaml"), "name: active\n");
        await writeFile(join(snapshotRoot, "egress-allowlist.yaml"), "active-allowlist\n");
        await writeFile(join(deploymentRoot, "current"), snapshotName + "\n");
        await chmod(join(deploymentRoot, "current"), 0o600);
        await writeFile(liveConfig, "candidate-allowlist\n");
        for (const secret of secretNames) {
          await writeFile(join(liveSecretRoot, secret), "candidate-" + secret + "\n");
          await chmod(join(liveSecretRoot, secret), 0o400);
          await writeFile(join(oldSecretRoot, secret), "active-" + secret + "\n");
          await chmod(join(oldSecretRoot, secret), 0o400);
        }

        for (const helper of [
          "preflight-host.sh",
          "render-cell.sh",
          "snapshot-host-baseline.sh",
          "verify-isolation.sh",
          "smoke-cell.sh",
          "rollback-cell.sh",
        ]) {
          const helperPath = join(fakeScripts, helper);
          await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
          await chmod(helperPath, 0o755);
        }

        const fakeDocker = join(fakeBin, "docker");
        const dockerSource = [
          "#!/bin/sh",
          "printf '%s\\n' \"$*\" >> \"$OPENCLAW_DOCKER_LOG\"",
          "case \"$*\" in",
          "  *\" config --images\")",
          ...services.map(
            (service) =>
              "    printf '%s\\n' '" +
              imageRepositories[service] +
              "@sha256:" +
              newDigests[service] +
              "'",
          ),
          "    exit 0 ;;",
          ...services.flatMap((service) => [
            "  *\" ps -q " + service + "\") printf '%s\\n' '" + service + "-id'; exit 0 ;;",
            "  *\"{{.Config.Image}} " +
              service +
              "-id\") printf '%s\\n' '" +
              imageRepositories[service] +
              "@sha256:" +
              oldDigests[service] +
              "'; exit 0 ;;",
          ]),
          "  *\"{{.State.Running}} \"*) printf '%s\\n' true; exit 0 ;;",
          "  *\" up -d \"*)",
          "    count=0",
          "    [ ! -f \"$OPENCLAW_UP_COUNT\" ] || count=$(cat \"$OPENCLAW_UP_COUNT\")",
          "    count=$((count + 1))",
          "    printf '%s\\n' \"$count\" > \"$OPENCLAW_UP_COUNT\"",
          "    [ \"$count\" -ne 1 ] || exit 42",
          "    exit 0 ;;",
          "esac",
          "exit 0",
          "",
        ].join("\n");
        await writeFile(fakeDocker, dockerSource);
        await chmod(fakeDocker, 0o755);

        const result = spawnSync(
          "sh",
          [join(fakeScripts, "deploy-cell.sh"), "--runtime-env", runtimeEnv],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_DOCKER_LOG: dockerLog,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              OPENCLAW_TRANSFER_QUOTA_RECORD: join(
                runtimeRoot,
                "operations",
                "transfer-quota.json",
              ),
              OPENCLAW_UP_COUNT: upCount,
              PATH: [fakeBin, process.env.PATH ?? ""].join(":"),
            },
          },
        );
        expect(result.status, result.stderr).toBe(42);
        expect(await readFile(liveConfig, "utf8")).toBe("active-allowlist\n");
        for (const secret of secretNames) {
          expect(await readFile(join(liveSecretRoot, secret), "utf8")).toBe(
            "active-" + secret + "\n",
          );
        }
        const upCommands = (await readFile(dockerLog, "utf8"))
          .trim()
          .split("\n")
          .filter((command) => command.includes(" up -d "));
        expect(upCommands).toHaveLength(2);
        expect(upCommands[0]).toContain("--env-file " + runtimeEnv);
        expect(upCommands[0]).toContain("-f " + join(fakeInfra, "compose.cell.yaml"));
        expect(upCommands[1]).toContain(
          "--env-file " + join(snapshotRoot, "runtime.env"),
        );
        expect(upCommands[1]).toContain(
          "-f " + join(snapshotRoot, "compose.cell.yaml"),
        );
        expect(upCommands[1]).toContain("--force-recreate");
      } finally {
        await chmod(work, 0o700).catch(() => undefined);
        await rm(work, { recursive: true, force: true });
      }
    },
  );

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
    const validate = source.indexOf("validate-session-key.mjs");
    const stop = source.indexOf("compose stop --timeout 30 cell");
    const clear = source.indexOf("rm -f /var/lib/openclaw-session/zalouser/credentials.json");
    const replace = source.indexOf('mv -f "$tmp" "$secret_dir/$name"');
    const recreateCommand = "compose up -d --no-build --force-recreate --no-deps --wait cell";
    const restart = source.lastIndexOf(recreateCommand);
    expect(validate).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(validate);
    expect(clear).toBeGreaterThan(stop);
    expect(replace).toBeGreaterThan(clear);
    expect(restart).toBeGreaterThan(replace);
    expect(source.match(new RegExp(recreateCommand, "g"))).toHaveLength(2);
    expect(source).not.toContain("compose up -d --no-build --wait cell");
    expect(source).toContain("resume_after_rotation_failure");
    expect(source).toContain("update_active_secret_snapshot");
    expect(source).toContain("active_secret_snapshot");
    expect(source).toContain("QR login required");
    expect(source).not.toMatch(/cat\s+.*(?:secret|source_file)|set\s+-x/i);
  });

  it.skipIf(process.platform === "win32" || !existsSync(pinnedNodePath))(
    "recreates only the cell after replacing the session-key inode",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-rotate-"));
      try {
        const bin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "runtime.env");
        const sourceKey = join(work, "new-session-key");
        const dockerLog = join(work, "docker.log");
        const fakeDocker = join(bin, "docker");
        await mkdir(bin, { recursive: true });
        await writeFile(runtimeEnv, "OPENCLAW_CELL_ID=dddd2000-0000-4000-8000-000000000001\n");
        await chmod(runtimeEnv, 0o600);
        await writeFile(
          sourceKey,
          JSON.stringify({
            activeGeneration: "g1",
            keys: { g1: Buffer.alloc(32, 0x11).toString("base64") },
            version: 1,
          }) + "\n",
        );
        await writeFile(
          fakeDocker,
          `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_DOCKER_LOG"\ncase " $* " in\n  *" ps -q cell "*) printf '%s\\n' fake-cell ;;\nesac\n`,
        );
        await chmod(fakeDocker, 0o755);

        const result = spawnSync(
          "sh",
          [
            resolve(root, "infra/openclaw-zalo/scripts/rotate-secrets.sh"),
            "--runtime-env",
            runtimeEnv,
            "--name",
            "openclaw_session_key",
            "--source-file",
            sourceKey,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_DOCKER_LOG: dockerLog,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);

        const commands = (await readFile(dockerLog, "utf8")).trim().split("\n");
        const stop = commands.findIndex((command) => command.includes(" stop --timeout 30 cell"));
        const clear = commands.findIndex((command) => command.includes(" run --rm --no-deps -T --entrypoint sh cell"));
        const recreate = commands.findIndex((command) => command.includes(" up -d --no-build --force-recreate --no-deps --wait cell"));
        expect(stop).toBeGreaterThan(-1);
        expect(clear).toBeGreaterThan(stop);
        expect(recreate).toBeGreaterThan(clear);
        expect(commands.filter((command) => command.includes(" up "))).toHaveLength(1);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "validates candidate session keys with the exact committed daemon parser",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-key-validator-"));
      try {
        const valid = join(work, "valid.json");
        const invalid = join(work, "invalid.json");
        await writeFile(
          valid,
          JSON.stringify({
            activeGeneration: "g1",
            keys: { g1: Buffer.alloc(32, 0x22).toString("base64") },
            version: 1,
          }) + "\n",
        );
        await writeFile(invalid, "not-json\n");
        await chmod(valid, 0o400);
        await chmod(invalid, 0o400);
        const validator = resolve(root, "infra/openclaw-zalo/scripts/validate-session-key.mjs");
        expect(spawnSync(process.execPath, [validator, "--candidate", valid]).status).toBe(0);
        expect(spawnSync(process.execPath, [validator, "--candidate", invalid]).status).not.toBe(0);
      } finally {
        await chmod(work, 0o700).catch(() => undefined);
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32" || !existsSync(pinnedNodePath))(
    "rejects a malformed session key before Docker or active-key mutation",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-rotate-invalid-"));
      try {
        const bin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "runtime.env");
        const sourceKey = join(work, "invalid-session-key");
        const dockerLog = join(work, "docker.log");
        const secretDir = join(
          runtimeRoot,
          "secrets",
          "dddd2000-0000-4000-8000-000000000001",
        );
        const activeKey = join(secretDir, "openclaw_session_key");
        const oldKey = "previous-valid-key-bytes\n";
        await mkdir(bin, { recursive: true });
        await mkdir(secretDir, { recursive: true });
        await writeFile(runtimeEnv, "OPENCLAW_CELL_ID=dddd2000-0000-4000-8000-000000000001\n");
        await chmod(runtimeEnv, 0o600);
        await writeFile(sourceKey, "not-json\n");
        await writeFile(activeKey, oldKey);
        await chmod(activeKey, 0o400);
        const fakeDocker = join(bin, "docker");
        await writeFile(
          fakeDocker,
          "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$OPENCLAW_DOCKER_LOG\"\nexit 99\n",
        );
        await chmod(fakeDocker, 0o755);

        const result = spawnSync(
          "sh",
          [
            resolve(root, "infra/openclaw-zalo/scripts/rotate-secrets.sh"),
            "--runtime-env",
            runtimeEnv,
            "--name",
            "openclaw_session_key",
            "--source-file",
            sourceKey,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_DOCKER_LOG: dockerLog,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              PATH: [bin, process.env.PATH ?? ""].join(":"),
            },
          },
        );
        expect(result.status).not.toBe(0);
        expect(await readFile(activeKey, "utf8")).toBe(oldKey);
        expect(await readFile(dockerLog, "utf8").catch(() => "")).toBe("");
      } finally {
        await chmod(work, 0o700).catch(() => undefined);
        await rm(work, { recursive: true, force: true });
      }
    },
  );

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
