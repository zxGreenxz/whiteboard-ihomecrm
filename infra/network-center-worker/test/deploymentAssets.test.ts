import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workerRoot = new URL("../", import.meta.url);

const requiredFiles = [
  "deploy/network-center-worker.service",
  "deploy/ihome-network-center-firewall.service",
  "deploy/90-ihome-network-center.conf",
  "deploy/install-host.sh",
  "deploy/activate-release.sh",
  "deploy/rollback-release.sh",
  "scripts/deploy-vultr.ps1",
  "scripts/rollback-vultr.ps1",
  "scripts/release-state-contract.ps1",
];

function text(path: string): string {
  return readFileSync(new URL(path, workerRoot), "utf8").replaceAll("\r\n", "\n");
}

function runPowerShell(path: string, args: string[]) {
  return spawnSync(
    "powershell.exe",
    // fileURLToPath, KHÔNG phải `.pathname.slice(1)`: cách cũ giữ percent-encoding
    // nên "Nguyen Tam" thành "Nguyen%20Tam" và PowerShell không mở được file.
    // Trớ trêu là chính các test dưới đây tồn tại để canh script deploy xử lý được
    // đường dẫn known_hosts CÓ DẤU CÁCH — chúng bị giết bởi đúng thứ chúng đi canh.
    // -ExecutionPolicy Bypass: script .ps1 trong repo không được ký, nên máy dùng
    // policy mặc định sẽ từ chối nạp và test đỏ vì lý do chẳng liên quan tới code.
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL(path, workerRoot)),
      ...args,
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

describe("immutable Network Center host deployment", () => {
  it("ships every systemd, host, activation and rollback asset", () => {
    for (const path of requiredFiles) {
      expect(existsSync(new URL(path, workerRoot)), `missing ${path}`).toBe(true);
    }
  });

  it("pins Linux deployment assets to LF even when Git autocrlf is enabled", () => {
    const attributesUrl = new URL("../../../.gitattributes", import.meta.url);
    expect(existsSync(attributesUrl), "missing root .gitattributes").toBe(true);
    const attributes = readFileSync(attributesUrl, "utf8");
    expect(attributes).toMatch(/^\*\.sh\s+text\s+eol=lf$/m);
    expect(attributes).toMatch(/^\*\.service\s+text\s+eol=lf$/m);
    for (const path of requiredFiles.filter((item) => item.endsWith(".sh"))) {
      expect(readFileSync(new URL(path, workerRoot), "utf8")).not.toContain("\r");
    }
  });

  it("orders WireGuard and Docker before a bounded systemd worker service", () => {
    const unit = text("deploy/network-center-worker.service");
    const firewallUnit = text("deploy/ihome-network-center-firewall.service");
    expect(unit).toMatch(/^Wants=network-online\.target$/m);
    expect(unit).toMatch(/Requires=.*wg-quick@wg0\.service.*docker\.service.*ihome-network-center-firewall\.service/);
    expect(unit).toMatch(/After=.*network-online\.target.*wg-quick@wg0\.service.*ihome-network-center-firewall\.service/);
    expect(unit).toMatch(/^After=docker\.service$/m);
    expect(unit).toMatch(/^ConditionPathExists=\/opt\/ihome-network-center\/state\/current\.release$/m);
    expect(unit).toMatch(/^UMask=0077$/m);
    expect(unit).toMatch(/activate-release\.sh start-current/);
    expect(unit).not.toMatch(/9router|zalo/i);
    expect(firewallUnit).toMatch(/nft\s+(?:--check|-c)\s+(?:--file|-f)/i);
    expect(firewallUnit).toMatch(/ihome-network-center\.nft/);
    expect(firewallUnit).not.toMatch(/flush\s+ruleset/i);
  });

  it("fails host bootstrap closed unless forwarding, WireGuard and managed firewall are active", () => {
    const install = text("deploy/install-host.sh");
    const sysctl = text("deploy/90-ihome-network-center.conf");
    expect(install).toMatch(/nftables/);
    expect(install).toMatch(/sysctl\s+--system/);
    expect(install).toMatch(/net\.ipv4\.ip_forward/);
    expect(install).toMatch(/nft\s+(?:--check|-c)\s+(?:--file|-f)/i);
    expect(install).toMatch(/systemctl\s+enable\s+--now\s+wg-quick@wg0\.service/);
    expect(install).toMatch(/systemctl\s+enable\s+ihome-network-center-firewall\.service/);
    expect(install).toMatch(/systemctl\s+restart\s+ihome-network-center-firewall\.service/);
    expect(install).toMatch(/systemctl\s+is-active\s+--quiet\s+wg-quick@wg0\.service/);
    expect(install).toMatch(/systemctl\s+is-active\s+--quiet\s+ihome-network-center-firewall\.service/);
    expect(install).toMatch(/firewall.*required|require_file.*ihome-network-center\.nft/is);
    expect(sysctl).toMatch(/^# ihomecrm-network-center-managed:v1$/m);
    expect(sysctl).toMatch(/^net\.ipv4\.ip_forward=1$/m);
  });

  it("orders the firewall before forwarding and WireGuard with an explicit dependency drop-in", () => {
    const install = text("deploy/install-host.sh");
    expect(install).toMatch(/wg-quick@wg0\.service\.d\/10-ihome-network-center-firewall\.conf/);
    expect(install).toMatch(/Requires=ihome-network-center-firewall\.service/);
    expect(install).toMatch(/After=ihome-network-center-firewall\.service/);
    const activation = install.slice(
      install.indexOf("apply_network_prerequisites()"),
      install.indexOf("rollback_failed_network_activation()"),
    );
    expect(activation.length).toBeGreaterThan(0);
    const forwardingOff = activation.indexOf("sysctl -w net.ipv4.ip_forward=0");
    const wireGuardStop = activation.indexOf("systemctl stop wg-quick@wg0.service");
    const firewallStart = activation.indexOf("systemctl restart ihome-network-center-firewall.service");
    const firewallReadback = activation.indexOf("systemctl is-active --quiet ihome-network-center-firewall.service");
    const forwarding = activation.indexOf("sysctl --system");
    const wireGuard = activation.indexOf("systemctl enable --now wg-quick@wg0.service");
    expect(forwardingOff).toBeGreaterThanOrEqual(0);
    expect(wireGuardStop).toBeGreaterThan(forwardingOff);
    expect(firewallStart).toBeGreaterThan(wireGuardStop);
    expect(firewallReadback).toBeGreaterThan(firewallStart);
    expect(forwarding).toBeGreaterThan(firewallReadback);
    expect(wireGuard).toBeGreaterThan(forwarding);
  });

  it("fails the firewall unit closed when its policy file is missing", () => {
    const unit = text("deploy/ihome-network-center-firewall.service");
    // systemd.unit(5): an unmet Condition* SKIPS the unit and the job still counts
    // as SUCCESSFUL, which satisfies the Requires= that wg-quick@wg0 gets from the
    // install-host drop-in — wg0 would come up forwarding with no policy loaded.
    // Assert* is the documented variant that makes the unit, and its dependents, fail.
    expect(unit).not.toMatch(/^ConditionPathExists=/m);
    expect(unit).toMatch(/^AssertPathExists=\/etc\/nftables\.d\/ihome-network-center\.nft$/m);
  });

  it("scopes the managed nftables lifecycle to its own table on start and stop", () => {
    const unit = text("deploy/ihome-network-center-firewall.service");
    const install = text("deploy/install-host.sh");
    expect(unit).toMatch(/^ExecStop=-?\/usr\/sbin\/nft delete table inet ihome_network_center$/m);
    expect(unit).not.toMatch(/flush\s+ruleset/i);
    expect(unit).not.toMatch(/delete\s+table\s+(?!inet ihome_network_center)/);
    // install-host.sh must never reach past its own table either.
    expect(install).toMatch(/nft delete table "\$MANAGED_FIREWALL_TABLE_FAMILY" "\$MANAGED_FIREWALL_TABLE_NAME"/);
    expect(install).not.toMatch(/nft\s+flush\s+ruleset/);
    expect(install).toMatch(/^readonly MANAGED_FIREWALL_TABLE_NAME="ihome_network_center"$/m);
  });

  it("installs a top-level signal and exit guard around the host mutation", () => {
    const install = text("deploy/install-host.sh");
    expect(install).toMatch(/trap 'handle_install_signal HUP' HUP/);
    expect(install).toMatch(/trap 'handle_install_signal INT' INT/);
    expect(install).toMatch(/trap 'handle_install_signal TERM' TERM/);
    expect(install).toMatch(/trap 'handle_install_exit' EXIT/);
    expect(install).toMatch(/trap 'exit 129' HUP/);
    const main = install.slice(install.indexOf("\nmain() {"));
    expect(main.indexOf("install_signal_handlers")).toBeGreaterThanOrEqual(0);
    expect(main.indexOf("install_signal_handlers")).toBeLessThan(main.indexOf("run_install_transaction"));
  });

  it("leaves no unreachable network activation helper for tests to aim at", () => {
    const install = text("deploy/install-host.sh");
    for (const name of install.match(/^[a-z_]+\(\) \{$/gm) ?? []) {
      const fn = name.slice(0, name.indexOf("("));
      if (fn === "main") continue;
      const callers = install.split("\n").filter((line) => {
        const trimmed = line.trim();
        return trimmed.includes(fn) && !trimmed.startsWith(`${fn}()`);
      });
      expect(callers.length, `${fn} has no caller`).toBeGreaterThan(0);
    }
  });

  it("keeps host bootstrap preflight mutation-free", () => {
    const install = text("deploy/install-host.sh");
    const preflight = install.slice(
      install.indexOf("preflight_install()"),
      install.indexOf("install_managed_file()"),
    );
    expect(preflight).not.toMatch(/\b(?:install|mv|cp|chmod|chown|mkdir|systemctl|sysctl)\b/);
  });

  it("rejects unsafe managed destinations before treating a path as absent", () => {
    const install = text("deploy/install-host.sh");
    const backup = install.slice(
      install.indexOf("backup_managed_file()"),
      install.indexOf("install_managed_file()"),
    );
    const unsafePathCheck = backup.search(/-L\s+"\$destination"[\s\S]*!\s+-f\s+"\$destination"/);
    const absentCheck = backup.indexOf('! -e "$destination"');
    expect(unsafePathCheck).toBeGreaterThanOrEqual(0);
    expect(absentCheck).toBeGreaterThan(unsafePathCheck);
    expect(backup).toMatch(/grep\s+-Fqx\s+"\$MANAGED_MARKER"\s+"\$destination"/);
  });

  it("preflights every required bootstrap source before any host mutation", () => {
    const install = text("deploy/install-host.sh");
    expect(install).toMatch(/--wg0-source is required/);
    expect(install).toMatch(/--firewall-source is required/);
    expect(install).toMatch(/preflight_install/);
    const preflightCall = install.lastIndexOf("preflight_install");
    for (const mutation of ["ensure_identity", "ensure_runtime_packages", "prepare_directories", "install_assets"]) {
      expect(install.indexOf(mutation, preflightCall)).toBeGreaterThan(preflightCall);
    }
  });

  it("uses an exact prebuilt image with the required container resource envelope", () => {
    const compose = text("docker-compose.yml");
    const dockerfile = text("Dockerfile");
    const environment = text(".env.example");
    expect(compose).not.toMatch(/^\s*build:/m);
    expect(compose).toMatch(/image:\s*\$\{NETWORK_CENTER_IMAGE_REF:\?/);
    expect(compose).toMatch(/container_name:\s*\$\{NETWORK_CENTER_CONTAINER_NAME/);
    expect(compose).toMatch(/user:\s*["']10001:10001["']/);
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/cpus:\s*0\.50/);
    expect(compose).toMatch(/mem_limit:\s*512m/);
    expect(compose).toMatch(/pids_limit:\s*128/);
    expect(compose).toMatch(/stop_grace_period:\s*5m/);
    expect(compose).toMatch(/NODE_OPTIONS:\s*["']?--max-old-space-size=320["']?/);
    expect(compose).not.toMatch(/docker\.sock|9router|zalo/i);
    expect(dockerfile).toMatch(/NODE_OPTIONS=--max-old-space-size=320/);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.revision/);
    expect(environment).toMatch(/^NETWORK_CENTER_RELEASE_SHA=[A-Fa-f0-9<]/m);
    expect(environment).toMatch(/^NETWORK_CENTER_POLL_CONCURRENCY=3$/m);
    expect(environment).toMatch(/^NETWORK_CENTER_COMMAND_CONCURRENCY=3$/m);
    expect(environment).toMatch(/^NETWORK_CENTER_COMMAND_CLAIM_LIMIT=3$/m);
    expect(environment).toMatch(/^NETWORK_CENTER_SFTP_CONCURRENCY=1$/m);
  });

  it("makes the runtime consume emergency-stop, release and every concurrency bound", () => {
    const config = text("src/config.ts");
    const main = text("src/main.ts");
    const commands = text("src/commands.ts");
    const ssh = text("src/routeros/sshConnector.ts");
    for (const name of [
      "NETWORK_CENTER_RELEASE_SHA",
      "NETWORK_CENTER_POLL_CONCURRENCY",
      "NETWORK_CENTER_COMMAND_CONCURRENCY",
      "NETWORK_CENTER_COMMAND_CLAIM_LIMIT",
    ]) expect(config).toContain(name);
    expect(main).toMatch(/workerVersion:\s*config\.releaseSha/g);
    expect(commands.indexOf("#paused()"))
      .toBeLessThan(commands.indexOf("claimCommands(this.#claimLimit"));
    expect(commands).toMatch(/mapWithConcurrency\([\s\S]*#maxConcurrency/);

    // NETWORK_CENTER_SFTP_CONCURRENCY is gone, and so is every SFTP call site.
    // The worker's only SFTP user was the binary `/system/backup/save` download,
    // which RouterOS gates on the `sensitive` policy — perfect correlation
    // across seven measured identities — so keeping the transport alive would
    // have kept the credential wide. The redacted export now arrives on the
    // command channel. This asserts the REMOVAL, because a concurrency bound on
    // a transport nobody opens is the kind of dead guard that reads as safety.
    // Comments are stripped first: this file DOCUMENTS at length what was
    // removed and why, and a naive substring match would fire on the
    // explanation rather than on any surviving call. What must be gone is the
    // CODE.
    const withoutComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const sshCode = withoutComments(ssh);
    expect(config).not.toContain("NETWORK_CENTER_SFTP_CONCURRENCY");
    expect(withoutComments(main)).not.toMatch(/sftpSemaphore/);
    expect(sshCode).not.toMatch(/sftpSemaphore|\.sftp\(|SFTPWrapper/);
    expect(sshCode).not.toMatch(/system\/backup\/save/);
    // And the export must be sent in its redacted form. `show-sensitive=no` is a
    // syntax error on v7; the flag that parses, `show-sensitive`, prints the
    // WireGuard private key in full.
    expect(sshCode).toContain('"/export terse hide-sensitive"');
    // No `/export …` command LITERAL may carry `show-sensitive` in any form.
    // Scoped to command literals on purpose: `routerOsExportCommandIsRedacted`
    // legitimately names the flag in order to reject it, and a blanket ban would
    // have forced the guard itself out of the file.
    expect(sshCode).not.toMatch(/"\/export[^"]*show-sensitive/);
    expect(sshCode).toContain("routerOsExportCommandIsRedacted");
  });

  // OpenSSH splits the VALUE of `-o Keyword=value` on whitespace, and
  // UserKnownHostsFile is a file LIST, so the Windows default
  // C:\Users\<name with a space>\.ssh\known_hosts was read as two paths and the
  // host-key pin was silently never loaded. Quoting is not an option from
  // Windows PowerShell 5.1 (embedded quotes are stripped; backslash-escaped
  // quotes split the argument), so the deploy script must remove the space.
  it.runIf(process.platform === "win32")(
    "strips whitespace out of the pinned known-hosts path it hands to ssh",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nc known hosts "));
      try {
        const knownHosts = join(root, "known_hosts");
        writeFileSync(knownHosts, "example.invalid ssh-ed25519 AAAA\n");
        expect(knownHosts).toMatch(/\s/);

        const result = runPowerShell("scripts/deploy-vultr.ps1", [
          "-ReleaseSha", "a".repeat(40),
          "-HostName", "network.example.invalid",
          "-KnownHostsFile", knownHosts,
          "-PlanOnly",
        ]);
        expect(result.status, result.stderr).toBe(0);
        const plan = JSON.parse(result.stdout) as { knownHostsOption: string | null };
        expect(plan.knownHostsOption).not.toBeNull();
        expect(plan.knownHostsOption).not.toMatch(/\s/);
        // Still the same file, not some other path that merely lacks a space.
        expect(readFileSync(plan.knownHostsOption as string, "utf8"))
          .toBe("example.invalid ssh-ed25519 AAAA\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "leaves a space-free known-hosts path exactly as given",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nc-known-hosts-"));
      try {
        const knownHosts = join(root, "known_hosts");
        writeFileSync(knownHosts, "example.invalid ssh-ed25519 AAAA\n");
        expect(knownHosts).not.toMatch(/\s/);

        const result = runPowerShell("scripts/deploy-vultr.ps1", [
          "-ReleaseSha", "a".repeat(40),
          "-HostName", "network.example.invalid",
          "-KnownHostsFile", knownHosts,
          "-PlanOnly",
        ]);
        expect(result.status, result.stderr).toBe(0);
        const plan = JSON.parse(result.stdout) as { knownHostsOption: string | null };
        expect(plan.knownHostsOption).toBe(knownHosts);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("plans archive, canary, drain, switch and readback without contacting a host", () => {
    const sha = "a".repeat(40);
    const result = runPowerShell("scripts/deploy-vultr.ps1", [
      "-ReleaseSha", sha,
      "-HostName", "network.example.invalid",
      "-KnownHostsFile", "C:\\secure\\known_hosts",
      "-PlanOnly",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as { stages: string[] };
    expect(plan.stages).toEqual([
      "preflight-systemd-wireguard-firewall",
      "git-archive-reviewed-sha",
      "exclusive-remote-upload",
      "hash-upload-remote-hash",
      "build-tag-label-inspect",
      "emergency-stop-canary",
      "health-heartbeat-readonly-readback",
      "drain-exact-active",
      "switch-current",
      "post-switch-readback",
      "compensating-abort-or-rollback",
      "commit-pointers",
    ]);
    const source = text("scripts/deploy-vultr.ps1");
    expect(source).toMatch(/& git[^\n]*archive[^\n]*--output/i);
    expect(source).toMatch(/status["']?,\s*["']--porcelain/);
    expect(source).toMatch(/StrictHostKeyChecking=yes/);
    expect(source).toMatch(/mktemp[^\n]*ihome-network-center-upload/i);
    expect(source).toMatch(/abort-pending/i);
    expect(source).toMatch(/compensate-last-transition/i);
    expect(source).toMatch(/finalize-last-transition/i);
    expect(source).toMatch(/systemctl\s+(?:restart|is-active)[^\n]*network-center-worker/i);
    expect(source).toMatch(/worker-release-status[\s\S]*--worker-key/i);
    expect(source).not.toMatch(/"status",\s*"--limit"/i);
    expect(source).toMatch(/assignedBuildingCount/i);
    expect(source).toMatch(/Confirm-CompensatedReleaseReadback/);
    expect(source).toMatch(/Get-PostSwitchHeartbeatFloor/);
    expect(source).toMatch(/pollObservedAt/i);
    expect(source).toMatch(/successfulPollCount/i);
    expect(source).toMatch(/failedPollCount/i);
    expect(source).not.toMatch(/RemoteArchive\s*=\s*"\/tmp\/ihome-network-center-\$ReleaseSha/);
    expect(source).not.toMatch(/ssh-keyscan|Invoke-Expression|docker image prune/i);
  });

  it("rejects invalid deployment identities before a native command", () => {
    const result = runPowerShell("scripts/deploy-vultr.ps1", [
      "-ReleaseSha", "main;whoami",
      "-HostName", "network.example.invalid",
      "-KnownHostsFile", "C:\\secure\\known_hosts",
      "-PlanOnly",
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/release sha/i);
  });

  it("keeps exact current, previous and pending image pointers with fail-closed rollback", () => {
    const activate = text("deploy/activate-release.sh");
    const rollback = text("deploy/rollback-release.sh");
    expect(activate).toMatch(/flock/);
    expect(activate).toMatch(/current\.release/);
    expect(activate).toMatch(/previous\.release/);
    expect(activate).toMatch(/pending\.release/);
    expect(activate).toMatch(/make_release_env "\$env_file" "\$release_sha" true/);
    expect(activate).toMatch(/org\.opencontainers\.image\.revision/);
    expect(activate).toMatch(/\.Image/);
    expect(activate).toMatch(/schemaVersion:\s*2/);
    expect(activate).toMatch(/secretGeneration/);
    expect(activate).toMatch(/NETWORK_CENTER_IMAGE_REF="\$image_id"/);
    expect(activate).toMatch(/ReadonlyRootfs/);
    expect(activate).toMatch(/NanoCpus/);
    expect(activate).toMatch(/PidsLimit/);
    expect(activate).toMatch(/RestartPolicy/);
    expect(activate).toMatch(/\.Config\.Env/);
    expect(activate).toMatch(/exactNodeOptions/);
    expect(activate).toMatch(/restore_previous|restore-previous/i);
    expect(activate).toMatch(/abort-pending/);
    expect(activate).toMatch(/cleanup_unreferenced_releases/);
    expect(activate).toMatch(/cleanup_unreferenced_secret_generations/);
    expect(activate).toMatch(/transition\.json/);
    expect(activate).toMatch(/commit-intent/);
    expect(activate).toMatch(/reconcile-state/);
    expect(activate).toMatch(/minimum.*free|MINIMUM_FREE_BYTES/i);
    expect(activate).toMatch(/ihome-network-center-worker/);
    expect(activate).not.toMatch(/docker\s+(?:system|builder|image)\s+prune/i);
    expect(activate).toMatch(/root:root|chown 0:0/);
    expect(activate).toMatch(/chmod 0600/);
    expect(rollback).toMatch(/PREVIOUS_POINTER/);
    expect(rollback).toMatch(/pointer_exact_healthy/);
    expect(rollback).toMatch(/force_pointer_emergency_stop|make_release_env[\s\S]*true/i);
    expect(rollback).toMatch(/health|healthy/i);
    expect(rollback).toMatch(/begin_transition/);
    expect(rollback).toMatch(/mark_transition_commit_intent/);
    expect(rollback).toMatch(/secretGeneration/);
    expect(rollback).not.toMatch(/docker (?:pull|build)|image prune|assign|unassign|provision/i);
  });

  it("guards runtime activation mutations with signal, exit and durability wiring", () => {
    const activate = text("deploy/activate-release.sh");
    // Same shape as install-host.sh: the script is driven over `ssh sudo --`, so a
    // dropped session SIGHUPs it mid-mutation.
    expect(activate).toMatch(/trap 'handle_activation_signal HUP' HUP/);
    expect(activate).toMatch(/trap 'handle_activation_signal INT' INT/);
    expect(activate).toMatch(/trap 'handle_activation_signal TERM' TERM/);
    expect(activate).toMatch(/trap 'handle_activation_exit' EXIT/);
    const main = activate.slice(activate.indexOf("\nmain() {"));
    expect(main.indexOf("install_activation_signal_handlers")).toBeGreaterThanOrEqual(0);
    expect(main.indexOf("install_activation_signal_handlers")).toBeLessThan(main.indexOf('case "${1:-}"'));
    // Every journal/pointer write must go through the fsync+rename+fsync helper.
    for (const destination of ["$TRANSITION_FILE", "$LAST_TRANSITION_FILE", "$RUNTIME_INTENT_FILE"]) {
      expect(activate, `${destination} is renamed without an fsync`)
        .not.toContain(`mv -fT "$temporary" "${destination}"`);
      expect(activate).toContain(`durable_replace "$temporary" "${destination}"`);
    }
    const pointerWriters = activate.slice(activate.indexOf("write_pointer() {"), activate.indexOf("pointer_json_or_null()"));
    expect(pointerWriters.length).toBeGreaterThan(0);
    expect(pointerWriters, "a pointer is renamed into place without an fsync").not.toContain("mv -fT");
    expect(pointerWriters.match(/durable_replace "\$temporary" "\$destination"/g)).toHaveLength(2);
  });

  it("installs immutable persistent and runtime secret generation roots", () => {
    const install = text("deploy/install-host.sh");
    expect(install).toMatch(/secret-generations/);
    expect(install).toMatch(/\/run\/ihome-network-center\/secret-generations/);
    expect(install).not.toMatch(/\/run\/ihome-network-center\/secrets\s*$/m);
  });

  it("documents a complete fresh-host bootstrap with managed source prerequisites", () => {
    const readme = text("README.md");
    expect(readme).toMatch(/install-host\.sh[\s\S]*--asset-dir[\s\S]*--wg0-source[\s\S]*--firewall-source/);
    expect(readme).toMatch(/wg0\.conf[\s\S]*ihome-network-center\.nft[\s\S]*ihomecrm-network-center-managed:v1/i);
    expect(readme).toMatch(/regular file|file th(?:\u01b0\u1eddng)/i);
    expect(readme).toMatch(/root:root[\s\S]*0600/);
  });

  it("documents the scoped firewall table, the additive peer merge and the one-way kill switch", () => {
    // Each of these was wrong in a way an operator acts on: flushing the ruleset
    // takes out the co-tenant's firewall, a whole-file wg0 replace silently drops
    // every previously onboarded building, and an operator who expects a revert
    // reads `health:"unverified"` as a failed stop and retries it.
    const readme = text("README.md");
    const install = text("deploy/install-host.sh");
    expect(readme).toMatch(/table inet ihome_network_center/);
    expect(readme).toMatch(/delete table inet ihome_network_center/);
    expect(readme).toMatch(/flush ruleset/);
    expect(readme, "the fragment requirement must stay a single managed table")
      .toMatch(/(duy\s*\n?\s*nh\u1ea5t|only)[\s\S]{0,120}table inet ihome_network_center/i);
    for (const flag of ["--remove-peer", "--allow-interface-change", "--allow-peer-overlap"]) {
      expect(install, `${flag} is documented but not implemented`).toContain(flag);
      expect(readme, `${flag} is implemented but not documented`).toContain(flag);
    }
    expect(readme).toMatch(/PublicKey/);
    expect(readme).toMatch(/set-emergency-stop true/);
    expect(readme).toMatch(/health:"unverified"/);
  });

  it("returns exact versioned inspection and recovery receipts", () => {
    const activate = text("deploy/activate-release.sh");
    expect(activate).toMatch(/inspect_pointer_state/);
    expect(activate).toMatch(/container.*exactMatch/is);
    expect(activate).toMatch(/persistentAvailable/);
    expect(activate).toMatch(/runtimeAvailable/);
    expect(activate).toMatch(/transition/);
    expect(activate).toMatch(/reconcile_state/);
    expect(activate).not.toMatch(/install[^\n]*release_dir\/deploy\/activate-release\.sh/is);
  });

  it("exposes a bounded rollback plan with health, revision and assignment readback", () => {
    const result = runPowerShell("scripts/rollback-vultr.ps1", [
      "-HostName", "network.example.invalid",
      "-KnownHostsFile", "C:\\secure\\known_hosts",
      "-PlanOnly",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as { stages: string[] };
    expect(plan.stages).toEqual([
      "capture-redacted-status-and-assignment-hash",
      "validate-previous-exact-image",
      "stop-current",
      "start-previous",
      "health-revision-readback",
      "verify-assignment-hash-unchanged",
      "commit-pointer-swap",
    ]);
    expect(text("scripts/rollback-vultr.ps1")).toMatch(/New-RollbackReadbackBaseline/);
  });

  // The rollback path carried the SAME `-o UserKnownHostsFile=$KnownHostsFile`
  // as the deploy path: OpenSSH argv_split's the option VALUE and
  // UserKnownHostsFile is a file LIST, so the Windows default
  // C:\Users\<name with a space>\.ssh\known_hosts is read as two paths and the
  // pin is silently never loaded. Fixing only the deploy script would have left
  // the failure for the one run where failing is worst, so it is covered here
  // with the same evidence the deploy fix carries.
  it("never interpolates the known-hosts path straight into the ssh option value", () => {
    const source = text("scripts/rollback-vultr.ps1");
    // The helper itself now lives in the contract file both clients dot-source,
    // so the assertion follows it there - but only after proving the rollback
    // script really loads that file. Otherwise this could be satisfied by a
    // helper nothing calls.
    expect(source).toMatch(/^\. \(Join-Path \$PSScriptRoot "release-state-contract\.ps1"\)$/m);
    const contract = text("scripts/release-state-contract.ps1");
    // Comments are stripped before asserting: the defect can only live in code,
    // and the contract quotes the broken form verbatim in the comment that
    // explains it. Matching the comment would make this test unfixable.
    const code = `${source}\n${contract}`
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // Platform-independent so Linux CI keeps the regression covered even where
    // powershell.exe cannot run.
    expect(code).not.toMatch(/UserKnownHostsFile=\$\w/);
    expect(contract).toMatch(/function Resolve-SshOptionPath/);
    expect(code).toMatch(/\$knownHostsOption = "UserKnownHostsFile=" \+ \(Resolve-SshOptionPath \$KnownHostsFile\)/);
    expect(code).toMatch(/"-o", \$knownHostsOption/);
    // The helper must refuse rather than hand ssh a pin it will not read.
    expect(contract).toMatch(/8\.3 short names are unavailable/);
  });

  it.runIf(process.platform === "win32")(
    "rollback strips whitespace out of the pinned known-hosts path it hands to ssh",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nc rollback known hosts "));
      try {
        const knownHosts = join(root, "known_hosts");
        writeFileSync(knownHosts, "example.invalid ssh-ed25519 AAAA\n");
        expect(knownHosts).toMatch(/\s/);

        const result = runPowerShell("scripts/rollback-vultr.ps1", [
          "-HostName", "network.example.invalid",
          "-KnownHostsFile", knownHosts,
          "-PlanOnly",
        ]);
        expect(result.status, result.stderr).toBe(0);
        const plan = JSON.parse(result.stdout) as { knownHostsOption: string | null };
        expect(plan.knownHostsOption).not.toBeNull();
        expect(plan.knownHostsOption).not.toMatch(/\s/);
        // Still the same file, not some other path that merely lacks a space.
        expect(readFileSync(plan.knownHostsOption as string, "utf8"))
          .toBe("example.invalid ssh-ed25519 AAAA\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rollback leaves a space-free known-hosts path exactly as given",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nc-rollback-known-hosts-"));
      try {
        const knownHosts = join(root, "known_hosts");
        writeFileSync(knownHosts, "example.invalid ssh-ed25519 AAAA\n");
        expect(knownHosts).not.toMatch(/\s/);

        const result = runPowerShell("scripts/rollback-vultr.ps1", [
          "-HostName", "network.example.invalid",
          "-KnownHostsFile", knownHosts,
          "-PlanOnly",
        ]);
        expect(result.status, result.stderr).toBe(0);
        const plan = JSON.parse(result.stdout) as { knownHostsOption: string | null };
        expect(plan.knownHostsOption).toBe(knownHosts);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
