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

const MARKER = "# ihomecrm-network-center-managed:v1";
const VPS_KEY = `${"V".repeat(43)}=`;
const PEER_ONE = `${"A".repeat(43)}=`;
const PEER_TWO = `${"B".repeat(43)}=`;
const PEER_THREE = `${"C".repeat(43)}=`;

function wgConfig(peers: Array<{ identity: string; key: string; allowed: string }>): string {
  return [
    MARKER,
    "[Interface]",
    "Address = 10.77.0.1/24",
    "ListenPort = 51820",
    `PrivateKey = ${VPS_KEY}`,
    ...peers.flatMap((peer) => [
      "",
      "[Peer]",
      `# ${peer.identity}`,
      `PublicKey = ${peer.key}`,
      `AllowedIPs = ${peer.allowed}`,
    ]),
  ].join("\n");
}

/** Sources install-host.sh and lays down an incoming wg0 source plus the peers wg0 already carries. */
function wgFixtures(incoming: string, destination: string): string {
  return `
source "$INSTALL_HOST"
mkdir -p "$(dirname "$WG0_DESTINATION")"
cat > "$NETWORK_CENTER_ROOT/incoming.conf" <<'WG_EOF'
${incoming}
WG_EOF
cat > "$WG0_DESTINATION" <<'WG_EOF'
${destination}
WG_EOF
`;
}

/**
 * Minimal `nft --file` simulator. It reproduces the one property this suite has
 * to observe: a bare `table F N { ... }` block ADDS its rules to whatever the
 * kernel already holds, and only an explicit `delete table F N` removes them.
 * Rules are stored as `<family> <name>|<rule>` lines in $RULESET so a co-tenant
 * table is visible and its survival assertable.
 */
function nftSimulator(): string {
  return `
RULESET="$NETWORK_CENTER_ROOT/ruleset"
: > "$RULESET"
nft_apply() {
  awk -v state="$RULESET" '
    BEGIN {
      count = 0
      while ((getline entry < state) > 0) { count++; ruleset[count] = entry }
      close(state)
      depth = 0
    }
    {
      line = $0
      sub(/#.*$/, "", line)
      gsub(/\\t/, " ", line)
      while (sub(/  /, " ", line)) { }
      sub(/^ +/, "", line)
      sub(/ +$/, "", line)
      if (line == "") next
      if (depth == 0) {
        if (line ~ /^delete table /) {
          target = substr(line, 14)
          kept = 0
          for (i = 1; i <= count; i++) {
            if (index(ruleset[i], target "|") != 1) { kept++; ruleset[kept] = ruleset[i] }
          }
          count = kept
          next
        }
        if (line ~ /^table /) {
          current = substr(line, 7)
          if (current ~ / *\\{$/) { sub(/ *\\{$/, "", current); depth = 1 }
          next
        }
        next
      }
      if (line == "}") { depth--; next }
      if (line ~ /\\{$/) { depth++; next }
      count++
      ruleset[count] = current "|" line
    }
    END { for (i = 1; i <= count; i++) print ruleset[i] }
  ' "$1" > "$RULESET.next"
  mv -f "$RULESET.next" "$RULESET"
}
`;
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

  // ---------------------------------------------------------------------------
  // wg0 peer merge: onboarding building N must never drop buildings 1..N-1.
  // The generator emits exactly ONE [Peer] per building, so a wholesale replace
  // of /etc/wireguard/wg0.conf silently disconnects every building already
  // onboarded behind the single VPS wg0 interface.
  // ---------------------------------------------------------------------------

  it("merges a newly onboarded building into the peers wg0 already carries", () => {
    const { root, result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" }]),
      wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]),
    )}
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/merged.conf"
wg_peer_index "$NETWORK_CENTER_ROOT/merged.conf"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${PEER_ONE}\t10.77.0.2/32`);
    expect(result.stdout).toContain(`${PEER_TWO}\t10.77.0.3/32`);
    const merged = readFileSync(join(root, "merged.conf"), "utf8");
    expect(merged.split("\n")[0]).toBe(MARKER);
    expect(merged).toContain("# building-01");
    expect(merged).toContain("# building-02");
    expect(merged.match(/^\[Interface\]$/gm)).toHaveLength(1);
    expect(merged.match(/^\[Peer\]$/gm)).toHaveLength(2);
  });

  it("keeps a repeated onboarding byte-identical instead of accumulating peers", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" }]),
      wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]),
    )}
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/first.conf"
cp "$NETWORK_CENTER_ROOT/first.conf" "$WG0_DESTINATION"
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/second.conf"
cmp -s "$NETWORK_CENTER_ROOT/first.conf" "$NETWORK_CENTER_ROOT/second.conf" && printf 'identical\\n'
wg_peer_index "$NETWORK_CENTER_ROOT/second.conf" | wc -l
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("identical");
    expect(result.stdout.trim().split("\n").pop()?.trim()).toBe("2");
  });

  it("updates an existing building in place when its peer block changes", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-01-rekeyed", key: PEER_ONE, allowed: "10.77.0.9/32" }]),
      wgConfig([
        { identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" },
        { identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" },
      ]),
    )}
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/merged.conf"
wg_peer_index "$NETWORK_CENTER_ROOT/merged.conf"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `${PEER_ONE}\t10.77.0.9/32`,
      `${PEER_TWO}\t10.77.0.3/32`,
    ]);
  });

  it("drops only the peer an operator names explicitly", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-03", key: PEER_THREE, allowed: "10.77.0.4/32" }]),
      wgConfig([
        { identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" },
        { identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" },
      ]),
    )}
add_wg0_peer_removal '${PEER_ONE}'
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/merged.conf"
wg_peer_index "$NETWORK_CENTER_ROOT/merged.conf"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `${PEER_TWO}\t10.77.0.3/32`,
      `${PEER_THREE}\t10.77.0.4/32`,
    ]);
  });

  it("refuses an explicit removal for a peer wg0 does not currently carry", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" }]),
      wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]),
    )}
add_wg0_peer_removal '${PEER_THREE}'
assert_wg0_merge_is_safe "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION"
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/remove-peer/i);
  });

  it("refuses a merge in which two buildings claim the same AllowedIPs", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.2/32" }]),
      wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]),
    )}
assert_wg0_merge_is_safe "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION"
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/AllowedIPs|claimed by two peers/i);
  });

  it("reports every peer it retains so an omitted building is never a silent keep", () => {
    const { result } = runHarness(`${wgFixtures(
      wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" }]),
      wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]),
    )}
assert_wg0_merge_is_safe "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`retaining[^\\n]*${PEER_ONE.replace(/\+/g, "\\+")}`));
  });

  it("refuses a wg0 source that would swap the interface every router pins", () => {
    // The bootstrap generator takes vpsWireGuardPrivateKey from the operator's
    // per-building input file, so onboarding building two with a freshly minted
    // VPS keypair is an easy mistake — and it breaks building one instantly even
    // though its [Peer] block survives the merge.
    const rekeyed = wgConfig([{ identity: "building-02", key: PEER_TWO, allowed: "10.77.0.3/32" }])
      .replace(VPS_KEY, `${"W".repeat(43)}=`);
    const body = `${wgFixtures(rekeyed, wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]))}
merge_wg0_configuration "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION" "$NETWORK_CENTER_ROOT/merged.conf"
`;
    const refused = runHarness(`${body}`);
    expect(refused.result.status).not.toBe(0);

    const preflight = runHarness(`${wgFixtures(rekeyed, wgConfig([{ identity: "building-01", key: PEER_ONE, allowed: "10.77.0.2/32" }]))}
assert_wg0_merge_is_safe "$NETWORK_CENTER_ROOT/incoming.conf" "$WG0_DESTINATION"
`);
    expect(preflight.result.status).not.toBe(0);
    expect(preflight.result.stderr).toMatch(/allow-interface-change/);

    const allowed = runHarness(`${body.replace(
      "merge_wg0_configuration",
      "wg0_allow_interface_change=true\nmerge_wg0_configuration",
    )}
wg_peer_index "$NETWORK_CENTER_ROOT/merged.conf"
`);
    expect(allowed.result.status, allowed.result.stderr).toBe(0);
    expect(allowed.result.stdout).toContain(PEER_ONE);
    expect(allowed.result.stdout).toContain(PEER_TWO);
  });

  it("refuses a wg0 source whose peer is unparsable rather than installing it", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
mkdir -p "$(dirname "$WG0_DESTINATION")"
cat > "$NETWORK_CENTER_ROOT/incoming.conf" <<'WG_EOF'
${MARKER}
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = ${VPS_KEY}

[Peer]
# building-01
AllowedIPs = 10.77.0.2/32
WG_EOF
wg_peer_index "$NETWORK_CENTER_ROOT/incoming.conf"
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PublicKey/i);
  });

  // ---------------------------------------------------------------------------
  // nftables: `nft --file` on a bare `table ... { ... }` fragment is an ADD, so
  // every re-run stacks another copy of every rule. The replace has to be scoped
  // to the managed table because the VPS also runs an unrelated production
  // service whose rules a global `flush ruleset` would destroy.
  // ---------------------------------------------------------------------------

  it("renders a scoped table replace so repeated applies converge instead of stacking", () => {
    const { result } = runHarness(`${nftSimulator()}
source "$INSTALL_HOST"
mkdir -p "$(dirname "$FIREWALL_DESTINATION")"
cat > "$NETWORK_CENTER_ROOT/firewall.source" <<'NFT_EOF'
${MARKER}
table inet ihome_network_center {
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "wg0" oifname "wg0" accept
    ct state established,related accept
  }
}
NFT_EOF
assert_scoped_firewall_fragment "$NETWORK_CENTER_ROOT/firewall.source"
render_managed_firewall_fragment "$NETWORK_CENTER_ROOT/firewall.source" "$FIREWALL_DESTINATION"
printf 'inet openclaw_zalo|tcp dport 443 accept\\n' > "$RULESET"
nft_apply "$FIREWALL_DESTINATION"
first="$(grep -c '^inet ihome_network_center|' "$RULESET")"
nft_apply "$FIREWALL_DESTINATION"
second="$(grep -c '^inet ihome_network_center|' "$RULESET")"
cotenant="$(grep -c '^inet openclaw_zalo|' "$RULESET")"
printf '%s|%s|%s\\n' "$first" "$second" "$cotenant"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("3|3|1");
  });

  it("keeps the managed marker and refuses a fragment that reaches outside its table", () => {
    for (const [label, body] of [
      ["flush", "flush ruleset\ntable inet ihome_network_center {\n  chain c { }\n}"],
      ["cotenant-table", "table inet ihome_network_center {\n  chain c { }\n}\ntable inet openclaw_zalo {\n  chain c { }\n}"],
      ["cotenant-rule", "table inet ihome_network_center {\n  chain c { }\n}\nadd rule inet openclaw_zalo input drop"],
      ["include", 'include "/etc/nftables.d/other.nft"\ntable inet ihome_network_center {\n  chain c { }\n}'],
      ["wrong-name", "table inet something_else {\n  chain c { }\n}"],
    ] as const) {
      const { result } = runHarness(`
source "$INSTALL_HOST"
cat > "$NETWORK_CENTER_ROOT/firewall.source" <<'NFT_EOF'
${MARKER}
${body}
NFT_EOF
assert_scoped_firewall_fragment "$NETWORK_CENTER_ROOT/firewall.source"
`);
      expect(result.status, `${label} was accepted`).not.toBe(0);
      expect(result.stderr, label).toMatch(/managed table|firewall fragment/i);
    }
  });

  it("prefixes the rendered fragment with the managed marker and a scoped delete", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
mkdir -p "$(dirname "$FIREWALL_DESTINATION")"
cat > "$NETWORK_CENTER_ROOT/firewall.source" <<'NFT_EOF'
${MARKER}
table inet ihome_network_center {
  chain c { }
}
NFT_EOF
render_managed_firewall_fragment "$NETWORK_CENTER_ROOT/firewall.source" "$FIREWALL_DESTINATION"
`);
    expect(result.status, result.stderr).toBe(0);
    const rendered = readFileSync(join(root, "host", "etc", "nftables.d", "ihome-network-center.nft"), "utf8");
    const lines = rendered.split("\n");
    expect(lines[0]).toBe(MARKER);
    expect(rendered).toMatch(/^table inet ihome_network_center$/m);
    expect(rendered).toMatch(/^delete table inet ihome_network_center$/m);
    expect(rendered.indexOf("delete table inet ihome_network_center"))
      .toBeLessThan(rendered.indexOf("table inet ihome_network_center {"));
    expect(rendered).not.toMatch(/flush\s+ruleset/i);
    expect(rendered.match(new RegExp(`^${MARKER}$`, "gm"))).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // SIGHUP: the README documents running this over SSH. Non-interactive bash
  // with no HUP trap dies instantly, so a dropped session between the sysctl or
  // firewall mutation and the readback would leave the host half-configured.
  // ---------------------------------------------------------------------------

  it("rolls back instead of dying silently when SIGHUP lands mid-mutation", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
rollback_failed_network_activation() {
  printf 'rollback\\n' >> "$NETWORK_CENTER_ROOT/events.log"
  return 0
}
install_signal_handlers
mutation_in_flight=true
kill -HUP $$
printf 'reached-next-command\\n'
`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("reached-next-command");
    expect(result.stderr).toMatch(/SIGHUP/);
    expect(result.stderr).toMatch(/prior persistent and live state restored/i);
    expect(readFileSync(join(root, "events.log"), "utf8")).toBe("rollback\n");
  });

  it("reports a fail-closed state when a signalled rollback cannot restore the host", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
rollback_failed_network_activation() { return 1; }
install_signal_handlers
mutation_in_flight=true
kill -TERM $$
printf 'reached-next-command\\n'
`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("reached-next-command");
    expect(result.stderr).toMatch(/SIGTERM/);
    expect(result.stderr).toMatch(/rollback incomplete; verified fail-closed state established/i);
  });

  it("rolls back when the mutation subshell is interrupted by a dropped session", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
prior_ip_forward=0
systemctl() {
  case "$1" in
    is-active) return 3;;
    is-enabled) return 1;;
    *) return 0;;
  esac
}
sysctl() {
  case "$1" in
    -n) printf '0\\n';;
    *) return 0;;
  esac
}
rollback_failed_network_activation() {
  printf 'rollback\\n' >> "$NETWORK_CENTER_ROOT/events.log"
  return 0
}
hung_up_installer() {
  kill -HUP $$
  exit 143
}
install_signal_handlers
run_install_transaction hung_up_installer
printf 'reached-next-command\\n'
`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("reached-next-command");
    expect(result.stderr).toMatch(/SIGHUP/);
    expect(readFileSync(join(root, "events.log"), "utf8")).toBe("rollback\n");
  });

  it("never leaves a mutation unresolved on an unexpected exit", () => {
    const { root, result } = runHarness(`
source "$INSTALL_HOST"
rollback_failed_network_activation() {
  printf 'rollback\\n' >> "$NETWORK_CENTER_ROOT/events.log"
  return 0
}
install_signal_handlers
mutation_in_flight=true
exit 7
`);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(root, "events.log"), "utf8")).toBe("rollback\n");
    expect(result.stderr).toMatch(/host network mutation/i);
  });
});
