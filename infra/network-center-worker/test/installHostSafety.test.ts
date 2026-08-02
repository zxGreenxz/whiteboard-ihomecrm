import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const workerRoot = resolve(new URL("../", import.meta.url).pathname.slice(1));
const installHost = join(workerRoot, "deploy", "install-host.sh");
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const roots: string[] = [];

function posix(path: string): string {
  return path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function fixture(): { root: string; rootPosix: string; harness: string } {
  const root = mkdtempSync(join(tmpdir(), "network-center-install-safety-"));
  roots.push(root);
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "host"), { recursive: true });
  return { root, rootPosix: posix(root), harness: join(root, "harness.sh") };
}

function runHarness(body: string) {
  const item = fixture();
  writeFileSync(item.harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${body}\n`, "utf8");
  const result = spawnSync(bash, ["--noprofile", "--norc", posix(item.harness)], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      INSTALL_HOST: posix(installHost),
      NETWORK_CENTER_ROOT: item.rootPosix,
      NETWORK_CENTER_HOST_ROOT: `${item.rootPosix}/host`,
    },
  });
  return { ...item, result };
}

function bootstrapSources(extraSysctl = ""): string {
  return `
source "$INSTALL_HOST"
mkdir -p "$NETWORK_CENTER_ROOT/assets"
for asset in network-center-worker.service ihome-network-center-firewall.service activate-release.sh rollback-release.sh; do
  printf 'asset\\n' > "$NETWORK_CENTER_ROOT/assets/$asset"
done
printf '%s\\nnet.ipv4.ip_forward=1\\n%s' "$MANAGED_MARKER" '${extraSysctl}' > "$NETWORK_CENTER_ROOT/assets/90-ihome-network-center.conf"
printf '%s\\nwg config\\n' "$MANAGED_MARKER" > "$NETWORK_CENTER_ROOT/wg0.source"
printf '%s\\ntable inet filter {}\\n' "$MANAGED_MARKER" > "$NETWORK_CENTER_ROOT/firewall.source"
asset_dir="$NETWORK_CENTER_ROOT/assets"
wg0_source="$NETWORK_CENTER_ROOT/wg0.source"
firewall_source="$NETWORK_CENTER_ROOT/firewall.source"
`;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    expect(dirname(root)).toBe(tmpdir());
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!existsSync(bash))("install-host transactional safety", () => {
  it("rejects any non-exact managed sysctl asset during mutation-free preflight", () => {
    const { result } = runHarness(`${bootstrapSources("unexpected=1\\n")}
preflight_install
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/90-ihome-network-center\.conf.*exact|sysctl.*exact/i);
  });

  it("preflights every persistent destination type before host mutation", () => {
    const source = readFileSync(installHost, "utf8");
    expect(source).toMatch(/require_safe_file_destination\(\)[\s\S]*-L\s+"\$1"[\s\S]*!\s+-f\s+"\$1"/);
    for (const name of [
      "ACTIVATE_DESTINATION",
      "ROLLBACK_DESTINATION",
      "WORKER_UNIT_DESTINATION",
      "FIREWALL_UNIT_DESTINATION",
      "WG_FIREWALL_DROPIN_DESTINATION",
      "SYSCTL_DESTINATION",
      "WG0_DESTINATION",
      "FIREWALL_DESTINATION",
    ]) {
      expect(source).toMatch(new RegExp(`require_safe_file_destination \\\"?\\$${name}`));
      expect(source).toMatch(new RegExp(`require_existing_managed_destination \\\"?\\$${name}`));
    }
    expect(source.indexOf("preflight_install")).toBeLessThan(source.lastIndexOf("ensure_identity"));

    const { root, result } = runHarness(`${bootstrapSources()}
mkdir -p "$(dirname "$SYSCTL_DESTINATION")" "$SYSCTL_DESTINATION"
preflight_install
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe.*destination|regular file/i);
    expect(existsSync(join(root, "mutated"))).toBe(false);
  });

  it("rejects an existing regular destination without the exact managed marker", () => {
    const { result } = runHarness(`${bootstrapSources()}
mkdir -p "$(dirname "$SYSCTL_DESTINATION")"
printf 'net.ipv4.ip_forward=0\\n' > "$SYSCTL_DESTINATION"
preflight_install
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unmanaged.*destination|managed marker.*destination/i);
  });

  it("restores exact prior sysctl, WireGuard and firewall files after mutation", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
for destination in "$SYSCTL_DESTINATION" "$WG0_DESTINATION" "$FIREWALL_DESTINATION"; do mkdir -p "$(dirname "$destination")"; done
printf 'prior-sysctl\\n' > "$SYSCTL_DESTINATION"; chmod 0640 "$SYSCTL_DESTINATION"
printf 'prior-wg\\n' > "$WG0_DESTINATION"; chmod 0600 "$WG0_DESTINATION"
printf 'prior-firewall\\n' > "$FIREWALL_DESTINATION"; chmod 0644 "$FIREWALL_DESTINATION"
sysctl_hash="$(sha256sum "$SYSCTL_DESTINATION" | awk '{print $1}')"
wg_hash="$(sha256sum "$WG0_DESTINATION" | awk '{print $1}')"
firewall_hash="$(sha256sum "$FIREWALL_DESTINATION" | awk '{print $1}')"
sysctl_mode="$(stat -c %a "$SYSCTL_DESTINATION")"
wg_mode="$(stat -c %a "$WG0_DESTINATION")"
firewall_mode="$(stat -c %a "$FIREWALL_DESTINATION")"
capture_persistent_host_files
printf changed > "$SYSCTL_DESTINATION"
rm -f "$WG0_DESTINATION"
printf changed > "$FIREWALL_DESTINATION"
mkdir -p "$(dirname "$WG_FIREWALL_DROPIN_DESTINATION")"
printf created > "$WG_FIREWALL_DROPIN_DESTINATION"
restore_persistent_host_files
[[ "$(sha256sum "$SYSCTL_DESTINATION" | awk '{print $1}')" == "$sysctl_hash" ]]
[[ "$(sha256sum "$WG0_DESTINATION" | awk '{print $1}')" == "$wg_hash" ]]
[[ "$(sha256sum "$FIREWALL_DESTINATION" | awk '{print $1}')" == "$firewall_hash" ]]
[[ "$(stat -c %a "$SYSCTL_DESTINATION")" == "$sysctl_mode" ]]
[[ "$(stat -c %a "$WG0_DESTINATION")" == "$wg_mode" ]]
[[ "$(stat -c %a "$FIREWALL_DESTINATION")" == "$firewall_mode" ]]
[[ ! -e "$WG_FIREWALL_DROPIN_DESTINATION" && ! -L "$WG_FIREWALL_DROPIN_DESTINATION" ]]
printf 'restored|absent\\n'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("restored|absent");
  });

  it("rejects an incomplete persistent snapshot", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
mkdir -p "$(dirname "$SYSCTL_DESTINATION")"
printf prior > "$SYSCTL_DESTINATION"
cp() { return 1; }
set +e
capture_persistent_host_files
status=$?
set -e
printf '%s\\n' "$status"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("0");
  });

  it("rolls back persistent files when install_assets fails inside the transaction", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
mkdir -p "$(dirname "$SYSCTL_DESTINATION")"
printf '%s\\nnet.ipv4.ip_forward=0\\n' "$MANAGED_MARKER" > "$SYSCTL_DESTINATION"
systemctl() {
  case "$1" in
    is-active) return 3;;
    is-enabled) return 1;;
    daemon-reload|stop|disable) return 0;;
    *) return 0;;
  esac
}
sysctl() {
  case "$1" in
    -n) printf '0\\n';;
    -w) return 0;;
  esac
}
install_assets() {
  printf changed > "$SYSCTL_DESTINATION"
  return 1
}
run_install_transaction
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/prior persistent and live state restored/i);
    expect(readFileSync(join(root, "host", "etc", "sysctl.d", "90-ihome-network-center.conf"), "utf8"))
      .toBe("# ihomecrm-network-center-managed:v1\nnet.ipv4.ip_forward=0\n");
  });

  it("fails closed when restoring prior WG-active firewall-inactive state is not exact", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
prior_ip_forward=1
prior_firewall_active=false
prior_firewall_enabled=false
prior_wg_active=true
prior_wg_enabled=true
forwarding=0
firewall_active=false
firewall_enabled=true
wg_active=false
wg_enabled=true
systemctl() {
  local action="$1" unit="\${3:-\${2:-}}"
  case "$action" in
    is-active)
      printf '%s;' "$unit" >> "$NETWORK_CENTER_ROOT/readbacks"
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_active" == true ]] ||
        [[ "$unit" == wg-quick@wg0.service && "$wg_active" == true ]] || return 3
      ;;
    is-enabled)
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_enabled" == true ]] ||
        [[ "$unit" == wg-quick@wg0.service && "$wg_enabled" == true ]]
      ;;
    enable) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=true || wg_enabled=true;;
    disable) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=false || wg_enabled=false;;
    stop) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_active=false || wg_active=false;;
    start)
      if [[ "$unit" == wg-quick@wg0.service ]]; then
        wg_active=true
        firewall_active=true
      else
        firewall_active=true
      fi
      ;;
  esac
}
sysctl() {
  case "$1" in
    -n) printf '%s\\n' "$forwarding";;
    -w) forwarding="\${2##*=}";;
  esac
}
set +e
restore_network_prerequisite_state
status=$?
set -e
printf '%s|%s|%s|%s|%s|%s|%s\\n' "$status" "$forwarding" "$firewall_active" "$wg_active" \
  "$firewall_enabled" "$wg_enabled" "$(cat "$NETWORK_CENTER_ROOT/readbacks")"
`);
    expect(result.status, result.stderr).toBe(0);
    const [status, forwarding, firewall, wg, firewallEnabled, wgEnabled, readbacks] = result.stdout.trim().split("|");
    // Must be exactly "1" (force_network_fail_closed ran and confirmed a clean
    // fail-closed state), not merely non-zero: status "2" means the fail-closed
    // fallback itself could not verify success ("rollback incomplete; unable to
    // establish fail-closed state" per run_install_transaction's die() mapping)
    // — a strictly worse outcome that `not.toBe("0")` would have silently accepted.
    expect(status).toBe("1");
    expect([forwarding, firewall, wg]).toEqual(["0", "false", "false"]);
    expect([firewallEnabled, wgEnabled]).toEqual(["false", "false"]);
    expect(readbacks).toContain("ihome-network-center-firewall.service");
    expect(readbacks).toContain("wg-quick@wg0.service");
  });

  it("propagates fail-closed command errors while persisting forwarding off for reboot", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
mkdir -p "$(dirname "$SYSCTL_DESTINATION")"
printf broken > "$SYSCTL_DESTINATION"
forwarding=1
firewall_active=true
firewall_enabled=true
wg_active=true
wg_enabled=true
systemctl() {
  local action="$1" unit="\${3:-\${2:-}}"
  case "$action" in
    stop)
      [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_active=false || wg_active=false
      [[ "$unit" != wg-quick@wg0.service ]]
      ;;
    disable) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=false || wg_enabled=false;;
    is-active)
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_active" == true ]] ||
        [[ "$unit" == wg-quick@wg0.service && "$wg_active" == true ]]
      [[ $? == 0 ]] && return 0 || return 3
      ;;
    is-enabled)
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_enabled" == true ]] ||
        [[ "$unit" == wg-quick@wg0.service && "$wg_enabled" == true ]]
      ;;
  esac
}
sysctl() {
  case "$1" in
    -n) printf '%s\\n' "$forwarding";;
    -w) forwarding="\${2##*=}";;
  esac
}
set +e
force_network_fail_closed
status=$?
set -e
printf '%s|%s|%s|%s|%s|%s\\n' "$status" "$forwarding" "$firewall_active" "$wg_active" "$firewall_enabled" "$wg_enabled"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1|0|false|false|false|false");
    expect(readFileSync(join(root, "host", "etc", "sysctl.d", "90-ihome-network-center.conf"), "utf8"))
      .toBe("# ihomecrm-network-center-managed:v1\nnet.ipv4.ip_forward=0\n");
  });

  it("rejects systemctl query errors instead of snapshotting them as inactive", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
prior_firewall_active=unknown
prior_firewall_enabled=unknown
prior_wg_active=unknown
prior_wg_enabled=unknown
sysctl() { printf '0\\n'; }
systemctl() { return 2; }
set +e
capture_network_prerequisite_state
status=$?
set -e
printf '%s|%s|%s|%s|%s\\n' "$status" "$prior_firewall_active" "$prior_firewall_enabled" "$prior_wg_active" "$prior_wg_enabled"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1|unknown|unknown|unknown|unknown");
  });

  it("routes activation failure through persistent and live rollback", () => {
    const source = readFileSync(installHost, "utf8");
    expect(source).toMatch(/capture_network_prerequisite_state[\s\S]*capture_persistent_host_files/);
    expect(source).toMatch(/apply_network_prerequisites[\s\S]*rollback_failed_network_activation/);
    expect(source).toMatch(/rollback incomplete[\s\S]*fail-closed|fail-closed[\s\S]*rollback incomplete/i);
  });
});
