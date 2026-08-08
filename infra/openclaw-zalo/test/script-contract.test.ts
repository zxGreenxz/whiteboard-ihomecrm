import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  "pair-bridge-device.sh",
  "rollback-cell.sh",
  "snapshot-host-baseline.sh",
  "rotate-secrets.sh",
];

async function text(path: string) {
  return readFile(resolve(root, path), "utf8");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
      if (source.includes("docker compose")) {
        expect(source).toContain("/usr/bin/env -i");
        expect(source).toContain('DOCKER_HOST="$docker_host"');
      }
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
    expect(source).toContain("cleanup_superseded_snapshots");
    expect(source).toContain("cleanup_live_secret_temporaries");
    expect(source).toContain('"$live_secret_dir/$secret.backup."*');
    expect(source).toContain('"$live_secret_dir/$secret.rollback."*');
    expect(source).toContain('"$live_secret_dir/$secret.restore."*');
    expect(source).toContain('"$live_secret_dir/$secret.tmp."*');
    expect(source).toContain('"$snapshots_root"/snapshot-*');
    expect(source).toContain('"$secret_snapshots_root"/snapshot-*');
    expect(source).toContain("active_secret_snapshot");
    expect(source).toContain("--force-recreate");
    expect(source).toContain("/usr/bin/env -i");
    expect(source).toContain('DOCKER_HOST="$docker_host"');
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
          "OPENCLAW_FENCING_TOKEN=fence-" + digests.cell.slice(0, 8),
          "",
        ].join("\n");

      try {
        const fakeInfra = join(work, "infra");
        const fakeScripts = join(fakeInfra, "scripts");
        const fakeBin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "candidate.env");
        const dockerLog = join(work, "docker.log");
        const upEnvLog = join(work, "up-env.log");
        const upCount = join(work, "up-count");
        const runnerUid = typeof process.getuid === "function" ? process.getuid() : 1001;
        const snapshotName = "snapshot-old";
        const deploymentRoot = join(runtimeRoot, "operations", cellId, "deployments");
        const snapshotRoot = join(deploymentRoot, "snapshots", snapshotName);
        const liveSecretRoot = join(runtimeRoot, "secrets", cellId);
        const oldSecretRoot = join(liveSecretRoot, ".deployments", snapshotName);
        const orphanSnapshotRoot = join(
          deploymentRoot,
          "snapshots",
          "snapshot-orphan",
        );
        const orphanSecretRoot = join(
          liveSecretRoot,
          ".deployments",
          "snapshot-orphan",
        );
        const liveConfig = join(runtimeRoot, "config", cellId, "egress-allowlist.yaml");

        await mkdir(fakeScripts, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(snapshotRoot, { recursive: true });
        await mkdir(oldSecretRoot, { recursive: true });
        await mkdir(orphanSnapshotRoot, { recursive: true });
        await mkdir(orphanSecretRoot, { recursive: true });
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
        await writeFile(join(orphanSnapshotRoot, "runtime.env"), envText(oldDigests));
        await chmod(join(orphanSnapshotRoot, "runtime.env"), 0o600);
        await writeFile(join(orphanSnapshotRoot, "compose.cell.yaml"), "name: orphan\n");
        await writeFile(
          join(orphanSnapshotRoot, "egress-allowlist.yaml"),
          "orphan-allowlist\n",
        );
        await writeFile(join(deploymentRoot, "current"), snapshotName + "\n");
        await chmod(join(deploymentRoot, "current"), 0o600);
        await writeFile(liveConfig, "candidate-allowlist\n");
        for (const secret of secretNames) {
          await writeFile(join(liveSecretRoot, secret), "candidate-" + secret + "\n");
          await chmod(join(liveSecretRoot, secret), 0o400);
          await writeFile(join(oldSecretRoot, secret), "active-" + secret + "\n");
          await chmod(join(oldSecretRoot, secret), 0o400);
          await writeFile(join(orphanSecretRoot, secret), "orphan-" + secret + "\n");
          await chmod(join(orphanSecretRoot, secret), 0o400);
        }
        for (const suffix of ["backup.101", "update.102", "restore.103"]) {
          await writeFile(
            join(oldSecretRoot, `openclaw_session_key.${suffix}`),
            "active-crash-leftover\n",
          );
          await chmod(join(oldSecretRoot, `openclaw_session_key.${suffix}`), 0o400);
          await writeFile(
            join(orphanSecretRoot, `openclaw_session_key.${suffix}`),
            "orphan-crash-leftover\n",
          );
          await chmod(join(orphanSecretRoot, `openclaw_session_key.${suffix}`), 0o400);
        }
        const liveCrashLeftovers = [
          join(liveSecretRoot, "openclaw_session_key.backup.200"),
          join(liveSecretRoot, "openclaw_session_key.rollback.201"),
          join(liveSecretRoot, "openclaw_session_key.restore.202"),
          join(liveSecretRoot, "openclaw_session_key.tmp.203"),
        ];
        for (const leftover of liveCrashLeftovers) {
          await writeFile(leftover, "live-crash-leftover\n");
          await chmod(leftover, 0o400);
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
          "printf '%s\\n' \"$*\" >> " + shellQuote(dockerLog),
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
          "    printf '%s\\n' \"${OPENCLAW_FENCING_TOKEN-unset}\" >> " + shellQuote(upEnvLog),
          "    count=0",
          "    [ ! -f " + shellQuote(upCount) + " ] || count=$(cat " + shellQuote(upCount) + ")",
          "    count=$((count + 1))",
          "    printf '%s\\n' \"$count\" > " + shellQuote(upCount),
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
              OPENCLAW_UP_ENV_LOG: upEnvLog,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              OPENCLAW_TRANSFER_QUOTA_RECORD: join(
                runtimeRoot,
                "operations",
                "transfer-quota.json",
              ),
              OPENCLAW_UP_COUNT: upCount,
              OPENCLAW_FENCING_TOKEN: "candidate-ambient",
              DOCKER_HOST: "unix:///run/user/" + runnerUid + "/docker.sock",
              PATH: [fakeBin, process.env.PATH ?? ""].join(":"),
            },
          },
        );
        expect(result.status, result.stderr).toBe(42);
        for (const leftover of liveCrashLeftovers) {
          expect(existsSync(leftover)).toBe(false);
        }
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
        expect((await readFile(upEnvLog, "utf8")).trim().split("\n")).toEqual([
          "unset",
          "unset",
        ]);

        await chmod(liveConfig, 0o600);
        await writeFile(liveConfig, "candidate-allowlist\n");
        for (const secret of secretNames) {
          await chmod(join(liveSecretRoot, secret), 0o600);
          await writeFile(join(liveSecretRoot, secret), "candidate-" + secret + "\n");
          await chmod(join(liveSecretRoot, secret), 0o400);
        }
        const successResult = spawnSync(
          "sh",
          [join(fakeScripts, "deploy-cell.sh"), "--runtime-env", runtimeEnv],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_DOCKER_LOG: dockerLog,
              OPENCLAW_UP_ENV_LOG: upEnvLog,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              OPENCLAW_TRANSFER_QUOTA_RECORD: join(
                runtimeRoot,
                "operations",
                "transfer-quota.json",
              ),
              OPENCLAW_UP_COUNT: upCount,
              OPENCLAW_FENCING_TOKEN: "candidate-ambient",
              DOCKER_HOST: "unix:///run/user/" + runnerUid + "/docker.sock",
              PATH: [fakeBin, process.env.PATH ?? ""].join(":"),
            },
          },
        );
        expect(successResult.status, successResult.stderr).toBe(0);
        const currentSnapshot = (await readFile(join(deploymentRoot, "current"), "utf8")).trim();
        expect(currentSnapshot).not.toBe(snapshotName);
        expect(currentSnapshot).not.toBe("snapshot-orphan");
        expect(existsSync(snapshotRoot)).toBe(false);
        expect(existsSync(oldSecretRoot)).toBe(false);
        expect(existsSync(orphanSnapshotRoot)).toBe(false);
        expect(existsSync(orphanSecretRoot)).toBe(false);
        expect(existsSync(join(deploymentRoot, "snapshots", currentSnapshot))).toBe(true);
        expect(existsSync(join(liveSecretRoot, ".deployments", currentSnapshot))).toBe(true);
        expect((await readFile(upEnvLog, "utf8")).trim().split("\n")).toEqual([
          "unset",
          "unset",
          "unset",
        ]);
      } finally {
        await chmod(work, 0o700).catch(() => undefined);
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects host-readable and linked candidate secrets before deployment mutation",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-deploy-secret-mode-"));
      const cellId = "dddd2000-0000-4000-8000-000000000001";
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
      try {
        const fakeInfra = join(work, "infra");
        const fakeScripts = join(fakeInfra, "scripts");
        const fakeBin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "runtime.env");
        const secretRoot = join(runtimeRoot, "secrets", cellId);
        const dockerLog = join(work, "docker.log");
        await mkdir(fakeScripts, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(secretRoot, { recursive: true });
        await mkdir(join(runtimeRoot, "operations"), { recursive: true });
        await writeFile(join(runtimeRoot, "operations", "transfer-quota.json"), "{}\n");
        await writeFile(runtimeEnv, `OPENCLAW_CELL_ID=${cellId}\n`);
        await chmod(runtimeEnv, 0o600);
        await writeFile(join(fakeInfra, "compose.cell.yaml"), "name: candidate\n");
        await copyFile(
          resolve(root, "infra/openclaw-zalo/scripts/deploy-cell.sh"),
          join(fakeScripts, "deploy-cell.sh"),
        );
        await chmod(join(fakeScripts, "deploy-cell.sh"), 0o755);
        for (const helper of [
          "preflight-host.sh",
          "render-cell.sh",
          "snapshot-host-baseline.sh",
          "verify-isolation.sh",
          "smoke-cell.sh",
          "rollback-cell.sh",
        ]) {
          await writeFile(join(fakeScripts, helper), "#!/bin/sh\nexit 0\n");
          await chmod(join(fakeScripts, helper), 0o755);
        }
        for (const secret of secretNames) {
          await writeFile(join(secretRoot, secret), `${secret}-value\n`);
          await chmod(join(secretRoot, secret), 0o400);
        }
        const fakeDocker = join(fakeBin, "docker");
        await writeFile(
          fakeDocker,
          [
            "#!/bin/sh",
            "printf '%s\\n' \"$*\" >> " + shellQuote(dockerLog),
            'case "$*" in',
            '  *" config --images") printf \'%s\\n\' "ihome/test@sha256:' + "a".repeat(64) + '" ;;',
            "esac",
            "exit 0",
            "",
          ].join("\n"),
        );
        await chmod(fakeDocker, 0o755);
        const runDeploy = () =>
          spawnSync("sh", [join(fakeScripts, "deploy-cell.sh"), "--runtime-env", runtimeEnv], {
            encoding: "utf8",
            env: {
              ...process.env,
              DOCKER_HOST: `unix:///run/user/${process.getuid?.() ?? 1001}/docker.sock`,
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              OPENCLAW_TRANSFER_QUOTA_RECORD: join(
                runtimeRoot,
                "operations",
                "transfer-quota.json",
              ),
              PATH: [fakeBin, process.env.PATH ?? ""].join(":"),
            },
          });

        const auditKey = join(secretRoot, "openclaw_audit_private_key");
        await chmod(auditKey, 0o644);
        const readableResult = runDeploy();
        expect(readableResult.status).not.toBe(0);
        expect(readableResult.stderr).toContain("mode must be 0400");

        await rm(auditKey);
        const linkedTarget = join(work, "linked-audit-key");
        await writeFile(linkedTarget, "linked-secret\n");
        await chmod(linkedTarget, 0o400);
        await symlink(linkedTarget, auditKey);
        const linkedResult = runDeploy();
        expect(linkedResult.status).not.toBe(0);
        expect(linkedResult.stderr).toContain("non-empty regular file");
        const commands = (await readFile(dockerLog, "utf8")).trim().split("\n");
        expect(commands.some((command) => command.includes(" up -d "))).toBe(false);
      } finally {
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
    expect(validate).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(validate);
    expect(clear).toBeGreaterThan(stop);
    expect(replace).toBeGreaterThan(clear);
    expect(source).toContain("recreate_affected_services");
    expect(source).toContain('openclaw_zalo_bridge_hmac) affected_services="cell bridge"');
    expect(source).toContain('stat -c %a "$secret_dir/$name"');
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
        const dockerEnvLog = join(work, "docker-env.log");
        const fakeDocker = join(bin, "docker");
        await mkdir(bin, { recursive: true });
        const activeSecretDir = join(
          runtimeRoot,
          "secrets",
          "dddd2000-0000-4000-8000-000000000001",
        );
        await mkdir(activeSecretDir, { recursive: true });
        await writeFile(runtimeEnv, "OPENCLAW_CELL_ID=dddd2000-0000-4000-8000-000000000001\n");
        await chmod(runtimeEnv, 0o600);
        await writeFile(
          join(activeSecretDir, "openclaw_session_key"),
          JSON.stringify({
            activeGeneration: "g0",
            keys: { g0: Buffer.alloc(32, 0x10).toString("base64") },
            version: 1,
          }) + "\n",
        );
        await chmod(join(activeSecretDir, "openclaw_session_key"), 0o400);
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
          [
            "#!/bin/sh",
            "printf '%s\\n' \"$*\" >> " + shellQuote(dockerLog),
            "printf '%s\\n' \"${OPENCLAW_FENCING_TOKEN-unset}\" >> " + shellQuote(dockerEnvLog),
            'case " $* " in',
            '  *" ps -q cell "*) printf \'%s\\n\' fake-cell ;;',
            "esac",
            "",
          ].join("\n"),
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
              OPENCLAW_RUNTIME_ROOT: runtimeRoot,
              OPENCLAW_FENCING_TOKEN: "ambient-must-not-win",
              DOCKER_HOST: `unix:///run/user/${process.getuid?.() ?? 1001}/docker.sock`,
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
        expect((await readFile(dockerEnvLog, "utf8")).trim().split("\n")).toEqual(
          commands.map(() => "unset"),
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "force-recreates non-session consumers and restores both copies after activation failure",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "openclaw-rotate-runtime-"));
      const cellId = "dddd2000-0000-4000-8000-000000000001";
      const name = "openclaw_runtime_credential";
      try {
        const bin = join(work, "bin");
        const runtimeRoot = join(work, "runtime");
        const runtimeEnv = join(work, "runtime.env");
        const sourceSecret = join(work, "new-runtime-secret");
        const dockerLog = join(work, "docker.log");
        const dockerEnvLog = join(work, "docker-env.log");
        const upCount = join(work, "up-count");
        const secretDir = join(runtimeRoot, "secrets", cellId);
        const snapshotName = "snapshot-active";
        const snapshotDir = join(secretDir, ".deployments", snapshotName);
        const deploymentRoot = join(runtimeRoot, "operations", cellId, "deployments");
        const oldSecret = "old-runtime-secret\n";
        const newSecret = "new-runtime-secret\n";
        await mkdir(bin, { recursive: true });
        await mkdir(snapshotDir, { recursive: true });
        await mkdir(deploymentRoot, { recursive: true });
        await writeFile(runtimeEnv, `OPENCLAW_CELL_ID=${cellId}\n`);
        await chmod(runtimeEnv, 0o600);
        await writeFile(sourceSecret, newSecret);
        await chmod(sourceSecret, 0o400);
        await writeFile(join(secretDir, name), oldSecret);
        await chmod(join(secretDir, name), 0o400);
        await writeFile(join(snapshotDir, name), oldSecret);
        await chmod(join(snapshotDir, name), 0o400);
        await writeFile(join(deploymentRoot, "current"), `${snapshotName}\n`);
        await chmod(join(deploymentRoot, "current"), 0o600);

        const fakeDocker = join(bin, "docker");
        await writeFile(
          fakeDocker,
          [
            "#!/bin/sh",
            "printf '%s\\n' \"$*\" >> " + shellQuote(dockerLog),
            "printf '%s\\n' \"${OPENCLAW_FENCING_TOKEN-unset}\" >> " + shellQuote(dockerEnvLog),
            'case " $* " in',
            '  *" ps -q bridge "*) printf \'%s\\n\' fake-bridge ;;',
            '  *" up -d "*)',
            "    count=0",
            "    [ ! -f " + shellQuote(upCount) + " ] || count=$(cat " + shellQuote(upCount) + ")",
            "    count=$((count + 1))",
            "    printf '%s\\n' \"$count\" > " + shellQuote(upCount),
            '    [ "$count" -ne 1 ] || exit 42 ;;',
            "esac",
            "exit 0",
            "",
          ].join("\n"),
        );
        await chmod(fakeDocker, 0o755);
        const runRotation = () =>
          spawnSync(
            "sh",
            [
              resolve(root, "infra/openclaw-zalo/scripts/rotate-secrets.sh"),
              "--runtime-env",
              runtimeEnv,
              "--name",
              name,
              "--source-file",
              sourceSecret,
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                DOCKER_HOST: `unix:///run/user/${process.getuid?.() ?? 1001}/docker.sock`,
                OPENCLAW_FENCING_TOKEN: "ambient-must-not-win",
                OPENCLAW_RUNTIME_ROOT: runtimeRoot,
                PATH: [bin, process.env.PATH ?? ""].join(":"),
              },
            },
          );

        const failed = runRotation();
        expect(failed.status).toBe(42);
        expect(await readFile(join(secretDir, name), "utf8")).toBe(oldSecret);
        expect(await readFile(join(snapshotDir, name), "utf8")).toBe(oldSecret);

        const succeeded = runRotation();
        expect(succeeded.status, succeeded.stderr).toBe(0);
        expect(await readFile(join(secretDir, name), "utf8")).toBe(newSecret);
        expect(await readFile(join(snapshotDir, name), "utf8")).toBe(newSecret);
        const commands = (await readFile(dockerLog, "utf8")).trim().split("\n");
        const upCommands = commands.filter((command) => command.includes(" up -d "));
        expect(upCommands).toHaveLength(3);
        expect(upCommands.every((command) => command.endsWith(" bridge"))).toBe(true);
        expect((await readFile(dockerEnvLog, "utf8")).trim().split("\n")).toEqual(
          commands.map(() => "unset"),
        );
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
              DOCKER_HOST: `unix:///run/user/${process.getuid?.() ?? 1001}/docker.sock`,
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

  // A cell with a fresh state volume knows no devices, so the bridge is refused
  // with NOT_PAIRED and the socket closes 1008 while both containers still look
  // healthy. Every runtime command is then accepted and never executed. The
  // pairing decision is exercised for real below: the shipped heredoc is lifted
  // out of the script and run against a stub `openclaw.mjs`.
  function pairingProgram(source: string) {
    const start = source.indexOf("<<'PAIR'\n");
    const end = source.indexOf("\nPAIR\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start + "<<'PAIR'\n".length, end + 1);
  }

  async function runPairing(options: {
    inventories: unknown[];
    expected: string;
  }) {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-pairing-"));
    try {
      const program = pairingProgram(await text("infra/openclaw-zalo/scripts/pair-bridge-device.sh"));
      await writeFile(join(directory, "pairing.cjs"), program, "utf8");
      // Answers `devices list` from a queue and records every `devices approve`.
      await writeFile(
        join(directory, "openclaw.mjs"),
        [
          `import fs from "node:fs";`,
          `import path from "node:path";`,
          `const statePath = path.join(import.meta.dirname, "state.json");`,
          `const state = JSON.parse(fs.readFileSync(statePath, "utf8"));`,
          `const argv = process.argv.slice(2);`,
          `if (argv[1] === "list") {`,
          `  const next = state.inventories.length > 1 ? state.inventories.shift() : state.inventories[0];`,
          `  fs.writeFileSync(statePath, JSON.stringify(state));`,
          `  process.stdout.write(JSON.stringify(next));`,
          `} else if (argv[1] === "approve") {`,
          `  state.approved.push(argv[2]);`,
          `  fs.writeFileSync(statePath, JSON.stringify(state));`,
          `} else { process.exit(64); }`,
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(directory, "state.json"),
        JSON.stringify({ inventories: options.inventories, approved: [] }),
        "utf8",
      );
      const result = spawnSync(process.execPath, [join(directory, "pairing.cjs")], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_EXPECTED_BRIDGE_DEVICE_ID: options.expected,
          OPENCLAW_PAIRING_TIMEOUT_MS: "1500",
        },
      });
      const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      return { ...result, approved: state.approved as string[] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const bridgeDevice = "b".repeat(64);
  const foreignDevice = "f".repeat(64);

  it("approves the bridge pairing request the deploy is waiting on", async () => {
    const result = await runPairing({
      expected: bridgeDevice,
      inventories: [
        { pending: [{ requestId: "request-1", deviceId: bridgeDevice }], paired: [] },
        { pending: [], paired: [{ deviceId: bridgeDevice }] },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.approved).toEqual(["request-1"]);
  });

  it("is idempotent once the bridge device is already paired", async () => {
    const result = await runPairing({
      expected: bridgeDevice,
      inventories: [{ pending: [], paired: [{ deviceId: bridgeDevice }] }],
    });
    expect(result.status).toBe(0);
    expect(result.approved).toEqual([]);
  });

  it("refuses to approve a device it cannot attribute to this stack's bridge", async () => {
    const result = await runPairing({
      expected: bridgeDevice,
      inventories: [{ pending: [{ requestId: "request-2", deviceId: foreignDevice }], paired: [] }],
    });
    expect(result.status).toBe(1);
    expect(result.approved).toEqual([]);
    expect(result.stderr).toContain("refusing to pair");
  });

  it("fails loudly when the bridge never asks to pair, instead of deploying a dead channel", async () => {
    const result = await runPairing({
      expected: bridgeDevice,
      inventories: [{ pending: [], paired: [] }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never requested Gateway pairing");
  });

  // The fork refuses a readiness request from any account but the bound one, so a
  // stray channel account silently costs every inbound message.
  async function runChannelBindingCheck(options: {
    accounts: unknown[];
    expected: string;
  }) {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-binding-"));
    try {
      const smoke = await text("infra/openclaw-zalo/scripts/smoke-cell.sh");
      const start = smoke.indexOf("<<'CHANNEL_BINDING'\n");
      const end = smoke.indexOf("\nCHANNEL_BINDING\n", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      await writeFile(
        join(directory, "check.cjs"),
        smoke.slice(start + "<<'CHANNEL_BINDING'\n".length, end + 1),
        "utf8",
      );
      await writeFile(
        join(directory, "openclaw.mjs"),
        [
          `import fs from "node:fs";`,
          `import path from "node:path";`,
          `const status = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "status.json"), "utf8"));`,
          `process.stdout.write(JSON.stringify(status));`,
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(directory, "status.json"),
        JSON.stringify({ channelAccounts: { zalouser: options.accounts } }),
        "utf8",
      );
      return spawnSync(process.execPath, [join(directory, "check.cjs")], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_EXPECTED_ACCOUNT_ID: options.expected },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const boundAccount = "aaaa1000-0000-4000-8000-000000000001";

  it("passes when the only Zalo account is the one the cell is bound to", async () => {
    const result = await runChannelBindingCheck({
      expected: boundAccount,
      accounts: [{ accountId: boundAccount, running: true, lastError: null }],
    });
    expect(result.status).toBe(0);
  });

  it("accepts an account that has not logged in yet - this is about identity, not readiness", async () => {
    const result = await runChannelBindingCheck({
      expected: boundAccount,
      accounts: [{ accountId: boundAccount, running: false, lastError: "not configured" }],
    });
    expect(result.status).toBe(0);
  });

  it("fails on a stray channel account, whose every inbound commit the fork refuses", async () => {
    const result = await runChannelBindingCheck({
      expected: boundAccount,
      accounts: [{ accountId: "default", running: true, lastError: null }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not bound to");
  });

  it("fails when the bound account is running with an error instead of receiving", async () => {
    const result = await runChannelBindingCheck({
      expected: boundAccount,
      accounts: [{
        accountId: boundAccount,
        running: true,
        lastError: "readiness request does not match the cell binding",
      }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("running with an error");
  });

  it("pairs before the smoke test and proves the channel there", async () => {
    const deploy = await text("infra/openclaw-zalo/scripts/deploy-cell.sh");
    const pairIndex = deploy.indexOf("pair-bridge-device.sh");
    const smokeIndex = deploy.indexOf(`smoke-cell.sh" --runtime-env`);
    expect(pairIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(pairIndex);

    const smoke = await text("infra/openclaw-zalo/scripts/smoke-cell.sh");
    expect(smoke).toContain("lastSeenAtMs");
    expect(smoke).toContain("unapproved pairing request");
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
