import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const workerRoot = resolve(new URL("../", import.meta.url).pathname.slice(1));
const activate = join(workerRoot, "deploy", "activate-release.sh");
const installHost = join(workerRoot, "deploy", "install-host.sh");
const rollback = join(workerRoot, "deploy", "rollback-release.sh");
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const roots: string[] = [];

function posix(path: string): string {
  return path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function fixture(): { root: string; rootPosix: string; harness: string } {
  const root = mkdtempSync(join(tmpdir(), "network-center-host-runtime-"));
  roots.push(root);
  mkdirSync(join(root, "state"), { recursive: true });
  const harness = join(root, "harness.sh");
  return { root, rootPosix: posix(root), harness };
}

function runHarness(body: string, env: Record<string, string> = {}) {
  const item = fixture();
  writeFileSync(item.harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${body}\n`, "utf8");
  const result = spawnSync(bash, ["--noprofile", "--norc", posix(item.harness)], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ACTIVATE: posix(activate),
      INSTALL_HOST: posix(installHost),
      ROLLBACK: posix(rollback),
      NETWORK_CENTER_ROOT: item.rootPosix,
      NETWORK_CENTER_HOST_ROOT: `${item.rootPosix}/host`,
      NETWORK_CENTER_RUNTIME_ROOT: `${item.rootPosix}/runtime`,
      ...env,
    },
  });
  return { ...item, result };
}

const MARKER = "# ihomecrm-network-center-managed:v1";
const VPS_KEY = `${"V".repeat(43)}=`;
const PEER_ONE = `${"A".repeat(43)}=`;
const PEER_TWO = `${"B".repeat(43)}=`;

/**
 * jq mock whose journal-phase write echoes the phase the script actually passed
 * (`--arg phase <value>`) instead of a literal the assertion then reads back: a
 * hard-coded literal made "wrote the wrong phase" undetectable. The schema
 * filter is answered by its own branch so validation still runs. The `case` is
 * left open for each test to append its branches and close it.
 */
const PHASE_FAITHFUL_JQ = `jq() {
  local index next after phase=""
  for ((index = 1; index <= $#; index++)); do
    next=$((index + 1)); after=$((index + 2))
    [[ "\${!index}" == "--arg" && $next -le $# && "\${!next}" == "phase" && $after -le $# ]] && phase="\${!after}"
  done
  case "$*" in
    *"def pointer_set:"*) return 0;;
    *'.phase = $phase'*) printf '{"schemaVersion":1,"operation":"promote","phase":"%s"}\\n' "$phase";;
    *"-cn"*) printf '{"schemaVersion":2}\\n';;
    *".operation"*) printf 'promote\\n';;
    *".phase"*) printf 'committed\\n';;`;

const FIXTURE_SHA = "d".repeat(40);

/** Real worker.env -> real release .env.active behind a stubbed current pointer. */
const CURRENT_RELEASE_FIXTURE = `
sync() { :; }
chown() { :; }
mkdir -p "$CONFIG_DIR" "$RELEASES_DIR/${FIXTURE_SHA}"
printf 'NETWORK_CENTER_API_URL=https://example.invalid\\n' > "$CONFIG_DIR/worker.env"
fixture_env="$RELEASES_DIR/${FIXTURE_SHA}/.env.active"
printf '{}' > "$CURRENT_POINTER"
validate_pointer() { :; }
pointer_value() {
  case "$2" in
    .releaseSha) printf '%s\\n' '${FIXTURE_SHA}';;
    .envFile) printf '%s\\n' "$fixture_env";;
    .containerName) printf 'worker\\n';;
    .secretGeneration) printf '%064d\\n' 5;;
    .imageId) printf 'sha256:%064d\\n' 6;;
  esac
}`;

/**
 * jq mock for the runtime-intent journal. It builds the document from the very
 * arguments the script passes and answers reads by parsing the file back off
 * disk, so the recovered value is the one that was really recorded rather than a
 * literal baked into the mock.
 */
const RUNTIME_INTENT_JQ = `jq() {
  local index next after release="" stop=""
  for ((index = 1; index <= $#; index++)); do
    next=$((index + 1)); after=$((index + 2))
    [[ $after -le $# && "\${!index}" == "--arg" && "\${!next}" == "releaseSha" ]] && release="\${!after}"
    [[ $after -le $# && "\${!index}" == "--argjson" && "\${!next}" == "emergencyStop" ]] && stop="\${!after}"
  done
  case "$*" in
    "-e "*) [[ -s "\${!#}" ]];;
    *"-n"*) printf '{"schemaVersion":1,"operation":"emergency-stop","releaseSha":"%s","emergencyStop":%s}\\n' "$release" "$stop";;
    *".releaseSha"*) sed -n 's/.*"releaseSha":"\\([^"]*\\)".*/\\1/p' "\${!#}";;
    *".emergencyStop"*) sed -n 's/.*"emergencyStop":\\([a-z]*\\).*/\\1/p' "\${!#}";;
    *) return 97;;
  esac
}`;

function wgSource(identity: string, key: string, allowed: string): string {
  return [
    MARKER,
    "[Interface]",
    "Address = 10.77.0.1/24",
    "ListenPort = 51820",
    `PrivateKey = ${VPS_KEY}`,
    "",
    "[Peer]",
    `# ${identity}`,
    `PublicKey = ${key}`,
    `AllowedIPs = ${allowed}`,
  ].join("\n");
}

/**
 * Drives the REAL install path: run_install_transaction -> perform_install_mutations
 * -> apply_network_prerequisites. Every simulated host fact lives in a FILE, not a
 * shell variable, because perform_install_mutations runs inside a subshell: variable
 * writes there are invisible to the rollback that runs in the parent, which would
 * make any rollback assertion pass vacuously against a state that never changed.
 */
function hostHarness(scenario: string, wg0: string = wgSource("building-01", PEER_ONE, "10.77.0.2/32")): string {
  return `
source "$INSTALL_HOST"
mkdir -p "$NETWORK_CENTER_ROOT/state" "$NETWORK_CENTER_ROOT/host-state"
mkdir -p "$(dirname "$WG0_DESTINATION")" "$(dirname "$FIREWALL_DESTINATION")"
log="$NETWORK_CENTER_ROOT/order.log"
: > "$log"
host_state() { cat "$NETWORK_CENTER_ROOT/host-state/$1"; }
set_host_state() { printf '%s\\n' "$2" > "$NETWORK_CENTER_ROOT/host-state/$1"; }
set_host_state forwarding 0
set_host_state firewall_active false
set_host_state wg_active false
set_host_state firewall_enabled false
set_host_state wg_enabled false
set_host_state managed_table absent
set_host_state firewall_restart_status 0
set_host_state wg_show_status 0
cat > "$NETWORK_CENTER_ROOT/wg0.source" <<'WG_EOF'
${wg0}
WG_EOF
cat > "$NETWORK_CENTER_ROOT/firewall.source" <<'NFT_EOF'
${MARKER}
table inet ihome_network_center {
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "wg0" oifname "wg0" accept
  }
}
NFT_EOF
wg0_source="$NETWORK_CENTER_ROOT/wg0.source"
firewall_source="$NETWORK_CENTER_ROOT/firewall.source"
install() {
  local last="" argument
  for argument in "$@"; do last="$argument"; done
  if [[ " $* " == *" -d "* ]]; then mkdir -p "$last"; return 0; fi
  local mode="" source="" destination=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|-g) shift 2;;
      -m) mode="$2"; shift 2;;
      *) if [[ -z "$source" ]]; then source="$1"; else destination="$1"; fi; shift;;
    esac
  done
  cp -- "$source" "$destination" || return 1
  [[ -z "$mode" ]] || chmod "$mode" "$destination"
  return 0
}
stat() {
  case "$*" in
    *"%u:%g"*) printf '0:0\\n';;
    *"%A"*) printf -- '-rw-------\\n';;
    *"%a"*) printf '600\\n';;
    *) command stat "$@";;
  esac
  return 0
}
nft() {
  printf 'nft:%s\\n' "$*" >> "$log"
  case "$1" in
    --check) return 0;;
    --file) set_host_state managed_table present; return 0;;
    list) [[ "$(host_state managed_table)" == present ]] || return 1; return 0;;
    delete) set_host_state managed_table absent; return 0;;
  esac
  return 0
}
wg() {
  printf 'wg:%s\\n' "$*" >> "$log"
  return "$(host_state wg_show_status)"
}
sysctl() {
  case "$1" in
    -n) host_state forwarding;;
    --system)
      [[ "$(cat "$SYSCTL_DESTINATION" 2>/dev/null || printf '')" == *ip_forward=1* ]] &&
        set_host_state forwarding 1 || set_host_state forwarding 0
      printf 'sysctl:--system\\n' >> "$log";;
    -w) set_host_state forwarding "\${2##*=}"; printf 'sysctl:%s %s\\n' "$1" "$2" >> "$log";;
  esac
  return 0
}
systemctl() {
  local action="$1" unit="\${3:-\${2:-}}"
  printf 'systemctl:%s\\n' "$*" >> "$log"
  case "$action" in
    is-active)
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        [[ "$(host_state firewall_active)" == true ]] || return 3
      elif [[ "$unit" == wg-quick@wg0.service ]]; then
        [[ "$(host_state wg_active)" == true ]] || return 3
      else
        return 3
      fi
      return 0;;
    is-enabled)
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        [[ "$(host_state firewall_enabled)" == true ]] || return 1
      elif [[ "$unit" == wg-quick@wg0.service ]]; then
        [[ "$(host_state wg_enabled)" == true ]] || return 1
      else
        return 1
      fi
      return 0;;
    enable)
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        set_host_state firewall_enabled true
      else
        set_host_state wg_enabled true
        [[ "$2" != --now ]] || set_host_state wg_active true
      fi
      return 0;;
    disable)
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        set_host_state firewall_enabled false
      else
        set_host_state wg_enabled false
      fi
      return 0;;
    stop)
      # Deliberately does NOT unload the managed table: by the time rollback stops
      # this unit, restore_persistent_host_files has already removed the unit
      # fragment, so systemd has no ExecStop left to run. Anything that unloads the
      # injected table has to come from install-host.sh itself.
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        set_host_state firewall_active false
      else
        set_host_state wg_active false
      fi
      return 0;;
    start)
      if [[ "$unit" == ihome-network-center-firewall.service ]]; then
        set_host_state firewall_active true
      else
        set_host_state wg_active true
      fi
      return 0;;
    restart)
      if [[ "$(host_state firewall_restart_status)" != 0 ]]; then
        set_host_state firewall_active false
        return "$(host_state firewall_restart_status)"
      fi
      set_host_state firewall_active true
      # models the unit's ExecStart=/usr/sbin/nft --file <fragment>
      set_host_state managed_table present
      printf 'nft:unit-exec-start\\n' >> "$log"
      return 0;;
  esac
  return 0
}
stub_installer() {
  printf 'assets-installed\\n' >> "$log"
  mkdir -p "$(dirname "$SYSCTL_DESTINATION")"
  printf '%s\\nnet.ipv4.ip_forward=1\\n' "$MANAGED_MARKER" > "$SYSCTL_DESTINATION"
}
${scenario}
`;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    expect(dirname(root)).toBe(tmpdir());
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!existsSync(bash))("deployment host runtime state machine", () => {
  it("rejects an unmanaged directory instead of recording it as absent", () => {
    const { root, result } = runHarness(`
source <(sed '/^while /,$d' "$INSTALL_HOST")
install() {
  local last=""; for last in "$@"; do :; done
  [[ " $* " == *" -d "* ]] && { mkdir -p "$last"; return; }
  return 97
}
mkdir -p "$NETWORK_CENTER_ROOT/unmanaged-directory"
backup_managed_file "$NETWORK_CENTER_ROOT/unmanaged-directory"
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|symlink|regular file/i);
    expect(existsSync(join(root, "backups", "host-config", "unmanaged-directory.absent"))).toBe(false);
  });

  it("reports missing required bootstrap sources during preflight", () => {
    const { result } = runHarness(`
source <(sed '/^while /,$d' "$INSTALL_HOST")
asset_dir="$(dirname "$INSTALL_HOST")"
wg0_source=""
firewall_source=""
preflight_install
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--wg0-source is required/);
  });

  it("starts and reads back the firewall before enabling forwarding and WireGuard", () => {
    const { result } = runHarness(hostHarness(`
run_install_transaction stub_installer
cat "$log"
`));
    expect(result.status, result.stderr).toBe(0);
    // Slice from the asset install so the pre-mutation state capture (which also
    // calls systemctl is-active) cannot satisfy an ordering assertion.
    const output = result.stdout.slice(result.stdout.indexOf("assets-installed"));
    expect(output).toContain("assets-installed");
    const forwardingOff = output.indexOf("sysctl:-w net.ipv4.ip_forward=0");
    const wireGuardStop = output.indexOf("systemctl:stop wg-quick@wg0.service");
    const firewallStart = output.indexOf("systemctl:restart ihome-network-center-firewall.service");
    const firewallReadback = output.indexOf("systemctl:is-active --quiet ihome-network-center-firewall.service");
    const tableReadback = output.indexOf("nft:list table inet ihome_network_center");
    const forwarding = output.indexOf("sysctl:--system");
    const wireGuard = output.indexOf("systemctl:enable --now wg-quick@wg0.service");
    const tunnelReadback = output.indexOf("wg:show wg0");
    expect(forwardingOff).toBeGreaterThanOrEqual(0);
    expect(wireGuardStop).toBeGreaterThan(forwardingOff);
    expect(firewallStart).toBeGreaterThan(wireGuardStop);
    expect(firewallReadback).toBeGreaterThan(firewallStart);
    expect(tableReadback).toBeGreaterThan(firewallReadback);
    expect(forwarding).toBeGreaterThan(tableReadback);
    expect(wireGuard).toBeGreaterThan(forwarding);
    expect(tunnelReadback).toBeGreaterThan(wireGuard);
  });

  it("restores disabled forwarding and stopped services when firewall activation fails", () => {
    const { root, result } = runHarness(hostHarness(`
set_host_state firewall_restart_status 1
run_install_transaction stub_installer
`));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/prior persistent and live state restored/i);
    const state = (name: string) =>
      readFileSync(join(root, "host-state", name), "utf8").trim();
    expect([state("forwarding"), state("firewall_active"), state("wg_active")])
      .toEqual(["0", "false", "false"]);
    expect([state("firewall_enabled"), state("wg_enabled")]).toEqual(["false", "false"]);
    expect(existsSync(join(root, "host", "etc", "wireguard", "wg0.conf"))).toBe(false);
    expect(existsSync(join(root, "host", "etc", "nftables.d", "ihome-network-center.nft"))).toBe(false);
  });

  it("unloads the injected nftables table before claiming the host was restored", () => {
    const { root, result } = runHarness(hostHarness(`
set_host_state wg_show_status 1
run_install_transaction stub_installer
`));
    expect(result.status).not.toBe(0);
    // The firewall unit really did load the managed table before wg0 failed.
    expect(result.stdout + readFileSync(join(root, "order.log"), "utf8"))
      .toContain("nft:unit-exec-start");
    expect(readFileSync(join(root, "order.log"), "utf8"))
      .toMatch(/nft:delete table inet ihome_network_center/);
    expect(readFileSync(join(root, "host-state", "managed_table"), "utf8").trim()).toBe("absent");
    expect(result.stderr).toMatch(/prior persistent and live state restored/i);
  });

  it("keeps the first building's peer when the second building is onboarded", () => {
    const { root, result } = runHarness(hostHarness(`
run_install_transaction stub_installer
cat > "$NETWORK_CENTER_ROOT/wg0.source" <<'WG_EOF'
${wgSource("building-02", PEER_TWO, "10.77.0.3/32")}
WG_EOF
set_host_state wg_active false
set_host_state firewall_active false
run_install_transaction stub_installer
wg_peer_index "$WG0_DESTINATION"
`));
    expect(result.status, result.stderr).toBe(0);
    const installed = readFileSync(join(root, "host", "etc", "wireguard", "wg0.conf"), "utf8");
    expect(installed).toContain(PEER_ONE);
    expect(installed).toContain(PEER_TWO);
    expect(installed).toContain("# building-01");
    expect(installed).toContain("# building-02");
    expect(installed.match(/^\[Peer\]$/gm)).toHaveLength(2);
    expect(result.stdout).toContain(`${PEER_ONE}\t10.77.0.2/32`);
    expect(result.stdout).toContain(`${PEER_TWO}\t10.77.0.3/32`);
    // Two full install transactions through the bash harness; the 5s default is
    // not a budget this can meet when the rest of the file runs alongside it.
  }, 20_000);

  it("removes worker.env NODE_OPTIONS overrides and emits the exact runtime value", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
mkdir -p "$CONFIG_DIR" "$NETWORK_CENTER_ROOT/releases/a"
printf 'NODE_OPTIONS=--max-old-space-size=999\nNETWORK_CENTER_API_URL=https://example.invalid\n' > "$CONFIG_DIR/worker.env"
chown() { :; }
make_release_env "$NETWORK_CENTER_ROOT/releases/a/.env" "$(printf '%040d' 1)" true
cat "$NETWORK_CENTER_ROOT/releases/a/.env"
`);
    expect(result.status, result.stderr).toBe(0);
    const generated = readFileSync(join(root, "releases", "a", ".env"), "utf8");
    expect(generated).toContain("NODE_OPTIONS=--max-old-space-size=320\n");
    expect(generated).not.toContain("--max-old-space-size=999");
    expect(generated.match(/^NODE_OPTIONS=/gm)).toHaveLength(1);
  });

  it("keeps an old persistent secret generation immutable after source rotation", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
# MSYS \`sync\` cannot fsync a regular file (EPERM), only a directory, so every
# test here that crosses a durable write stubs it. The audit of what the staged
# generation really flushes lives in its own test below.
sync() { :; }
stat() {
  if [[ "$*" == *"%u:%g:%a"* ]]; then
    [[ -d "$3" ]] && printf '0:0:700\\n' || printf '0:0:600\\n'
  else command stat "$@"; fi
}
install() {
  local mode="" source="" destination="" last="" arg; for arg in "$@"; do last="$arg"; done
  if [[ " $* " == *" -d "* ]]; then mkdir -p "$last"; return; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in -o|-g|-m) [[ "$1" == -m ]] && mode="$2"; shift 2;; *) [[ -z "$source" ]] && source="$1" || destination="$1"; shift;; esac
  done
  cp "$source" "$destination"; [[ -z "$mode" ]] || chmod "$mode" "$destination"
}
mkdir -p "$SECRET_DIR"
printf old-worker > "$SECRET_DIR/worker-secret"
printf '{"old":true}' > "$SECRET_DIR/router-credentials.json"
first="$(snapshot_secret_generation)"
printf new-worker > "$SECRET_DIR/worker-secret"
printf '{"new":true}' > "$SECRET_DIR/router-credentials.json"
second="$(snapshot_secret_generation)"
[[ "$first" != "$second" ]]
[[ "$(cat "$SECRET_GENERATIONS_DIR/$first/worker-secret")" == old-worker ]]
printf '%s\\n%s\\n' "$first" "$second"
`);
    expect(result.status, result.stderr).toBe(0);
    const generations = result.stdout.trim().split("\n");
    expect(generations).toHaveLength(2);
    expect(readFileSync(join(root, "secret-generations", generations[0]!, "worker-secret"), "utf8")).toBe("old-worker");
  }, 15_000);

  it("passes exact image ID and generation mount to compose", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
pointer_value() { case "$2" in .imageId) printf 'sha256:%064d\\n' 1;; .secretGeneration) printf '%064d\\n' 2;; .releaseDirectory) printf '%s/releases/a\\n' "$NETWORK_CENTER_ROOT";; .envFile) printf '%s/releases/a/.env\\n' "$NETWORK_CENTER_ROOT";; .projectName) printf 'project\\n';; .containerName) printf 'container\\n';; esac; }
docker() { printf '%s|%s|%s\\n' "$NETWORK_CENTER_IMAGE_REF" "$NETWORK_CENTER_RUNTIME_SECRET_DIR_HOST" "$*" > "$NETWORK_CENTER_ROOT/compose.log"; }
compose_for_pointer ignored up
`);
    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(join(root, "compose.log"), "utf8");
    expect(log).toMatch(/^sha256:0{63}1\|.*\/runtime\/secret-generations\/0{63}2\|compose /);
  });

  it("recovers prepared to before and commit-intent to exact healthy after", () => {
    const cases: Array<[string, string, string]> = [["prepared", "true", "converge:BEFORE"], ["commit-intent", "true", "apply:AFTER"], ["commit-intent", "false", "converge:BEFORE"]];
    for (const [phase, healthy, expected] of cases) {
      const { result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$TRANSITION_FILE"
sync() { :; }
jq() { case "$*" in *".phase"*) printf '%s\\n' "$PHASE";; *".before"*) printf 'BEFORE\\n';; *".after"*) printf 'AFTER\\n';; *".target"*) printf 'TARGET\\n';; esac; }
converge_pointer_set() { printf 'converge:%s\\n' "$1"; }
apply_pointer_set() { printf 'apply:%s\\n' "$1"; }
temporary_pointer_from_json() { printf '%s/target.pointer\\n' "$STATE_DIR"; }
pointer_exact_healthy() { [[ "$HEALTHY" == true ]]; }
recover_transition
`, { PHASE: phase, HEALTHY: healthy });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    }
  });

  it("re-materializes and starts a commit-intent target after reboot before committing", () => {
    const { result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$TRANSITION_FILE"
sync() { :; }
jq() { case "$*" in *".phase"*) printf 'commit-intent\\n';; *".before"*) printf 'BEFORE\\n';; *".after"*) printf 'AFTER\\n';; *".target"*) printf 'TARGET\\n';; esac; }
temporary_pointer_from_json() { printf '%s/target.pointer\\n' "$STATE_DIR"; }
calls=0
pointer_exact_healthy() { calls=$((calls + 1)); [[ "$calls" -ge 2 ]]; }
start_pointer() { printf 'start:%s\\n' "$1"; }
apply_pointer_set() { printf 'apply:%s\\n' "$1"; }
converge_pointer_set() { printf 'converge:%s\\n' "$1"; }
recover_transition
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/start:.*target\.pointer/);
    expect(result.stdout).toContain("apply:AFTER");
    expect(result.stdout).not.toContain("converge:BEFORE");
  });

  it("restores the exact pre-promotion pointer set and keeps the durable transition until finalize", () => {
    const pointer = (releaseSha: string, imageDigit: string, generationDigit: string, suffix: string) => ({
      schemaVersion: 2,
      releaseSha,
      imageTag: `ihome-network-center-worker:${releaseSha}`,
      imageId: `sha256:${imageDigit.repeat(64)}`,
      archiveSha256: "9".repeat(64),
      secretGeneration: generationDigit.repeat(64),
      releaseDirectory: `/opt/ihome-network-center/releases/${releaseSha}`,
      envFile: `/opt/ihome-network-center/releases/${releaseSha}/.env.${suffix}`,
      projectName: `ihome-${suffix}`,
      containerName: `worker-${suffix}`,
    });
    const before = {
      current: pointer("a".repeat(40), "1", "3", "current"),
      previous: pointer("c".repeat(40), "2", "4", "previous"),
      pending: null,
    };
    const after = {
      current: pointer("b".repeat(40), "5", "6", "candidate"),
      previous: before.current,
      pending: null,
    };
    const { root, result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$LAST_TRANSITION_FILE"
printf '%s' '${JSON.stringify(after)}' > "$STATE_DIR/applied.json"
sync() { :; }
${PHASE_FAITHFUL_JQ}
    *".target.releaseSha"*) printf '%s\\n' "$(printf 'b%.0s' {1..40})";;
    *".before"*) printf '%s\\n' '${JSON.stringify(before)}';;
    *".after"*) printf '%s\\n' '${JSON.stringify(after)}';;
    *".current"*) printf '%s\\n' '${JSON.stringify(before.current)}';;
    *) printf 'unknown jq: %s\\n' "$*" >&2; return 97;;
  esac
}
converge_pointer_set() { printf '%s' "$1" > "$STATE_DIR/applied.json"; }
pointer_set_json() { cat "$STATE_DIR/applied.json"; }
pointer_exact_healthy() { return 0; }
cleanup_unreferenced_releases() { printf 'cleanup\\n' >> "$STATE_DIR/events.log"; }
compensate_last_transition "$(printf 'b%.0s' {1..40})" >/dev/null
cat "$STATE_DIR/applied.json"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(before);
    // Asserts the phase the script actually asked jq to write, not a literal the
    // mock hard-codes: writing any other phase here now fails the test.
    expect(readFileSync(join(root, "state", "last-transition.json"), "utf8")).toContain('"phase":"compensated"');
    expect(existsSync(join(root, "state", "events.log"))).toBe(false);
  });

  it("runs cleanup only when a committed or compensated transition is explicitly finalized", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$LAST_TRANSITION_FILE"
sync() { :; }
${PHASE_FAITHFUL_JQ}
    *".target.releaseSha"*) printf '%s\\n' "$(printf 'b%.0s' {1..40})";;
    *".after"*) printf 'DESIRED\\n';;
    *".current"*) printf 'null\\n';;
    *) return 97;;
  esac
}
pointer_set_json() { printf 'DESIRED\\n'; }
cleanup_unreferenced_releases() { printf 'cleanup\\n' >> "$STATE_DIR/events.log"; }
[[ ! -e "$STATE_DIR/events.log" ]]
finalize_last_transition "$(printf 'b%.0s' {1..40})" >/dev/null
cat "$STATE_DIR/events.log"
grep -q finalized "$LAST_TRANSITION_FILE"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("cleanup");
    expect(readFileSync(join(root, "state", "last-transition.json"), "utf8")).toContain('"phase":"finalized"');
  });

  it("rehashes runtime secret files and rejects content or mode tampering", () => {
    for (const tamper of ["none", "content", "mode"] as const) {
      const { result } = runHarness(`
source "$ACTIVATE"
generation="$(printf '7%.0s' {1..64})"
source_dir="$SECRET_GENERATIONS_DIR/$generation"
runtime_dir="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
mkdir -p "$source_dir" "$runtime_dir"
printf 'worker-value' > "$source_dir/worker-secret"
printf '{"router":true}' > "$source_dir/router-credentials.json"
canonical_secret_manifest "$source_dir" > "$source_dir/manifest.sha256"
cp "$source_dir/worker-secret" "$source_dir/router-credentials.json" "$runtime_dir/"
verify_persistent_secret_generation() { :; }
stat() {
  if [[ "$1 $2" == "-c %u:%g:%a" ]]; then
    if [[ "$3" == "$runtime_dir" ]]; then printf '0:%s:750\\n' "$WORKER_GID"
    elif [[ "$TAMPER" == mode && "$3" == "$runtime_dir/worker-secret" ]]; then printf '%s:%s:440\\n' "$WORKER_UID" "$WORKER_GID"
    else printf '%s:%s:400\\n' "$WORKER_UID" "$WORKER_GID"; fi
  else command stat "$@"; fi
}
[[ "$TAMPER" != content ]] || printf 'changed' > "$runtime_dir/worker-secret"
verify_runtime_secret_generation "$generation"
`, { TAMPER: tamper });
      if (tamper === "none") expect(result.status, result.stderr).toBe(0);
      else expect(result.status, tamper).not.toBe(0);
    }
  });

  it("reports runtime secret tampering as an inexact inspection instead of trusting the directory", () => {
    const { result } = runHarness(`
source "$ACTIVATE"
generation="$(printf '8%.0s' {1..64})"
GENERATION_UNDER_TEST="$generation"
source_dir="$SECRET_GENERATIONS_DIR/$generation"
runtime_dir="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
mkdir -p "$source_dir" "$runtime_dir"
printf 'worker-value' > "$source_dir/worker-secret"
printf '{"router":true}' > "$source_dir/router-credentials.json"
canonical_secret_manifest "$source_dir" > "$source_dir/manifest.sha256"
cp "$source_dir/worker-secret" "$source_dir/router-credentials.json" "$runtime_dir/"
printf 'tampered' > "$runtime_dir/worker-secret"
validate_pointer() { :; }
verify_persistent_secret_generation() { :; }
pointer_value() { case "$2" in .releaseSha) printf '%040d\\n' 1;; .imageId) printf 'sha256:%064d\\n' 2;; .secretGeneration) printf '%s\\n' "$GENERATION_UNDER_TEST";; .containerName) printf 'worker\\n';; esac; }
stat() {
  if [[ "$1 $2" == "-c %u:%g:%a" ]]; then
    [[ "$3" == "$runtime_dir" ]] && printf '0:%s:750\\n' "$WORKER_GID" || printf '%s:%s:400\\n' "$WORKER_UID" "$WORKER_GID"
  else command stat "$@"; fi
}
docker() { return 1; }
jq() {
  [[ "$*" == *"--argjson runtime false"* ]] || return 97
  printf '{"runtimeAvailable":false,"exactMatch":false}\\n'
}
# Inside the fixture root, never the package directory: an untracked file left in
# the worktree makes deploy-vultr.ps1 refuse to deploy (git status --porcelain
# --untracked-files=all).
touch "$STATE_DIR/inspected.pointer"
inspect_pointer_state "$STATE_DIR/inspected.pointer"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runtimeAvailable: false, exactMatch: false });
  });

  it("exposes only bounded last-transition metadata in exact host inspection", () => {
    // The journal on disk really does carry the full pointer sets, and the mock
    // only answers the EXACT bounded projection: widening the filter (or reading
    // the journal with `jq -c .`) falls through to the fail branch instead of
    // being handed back a safe literal. The receipt is then echoed from the value
    // the script itself passed as --argjson lastTransition, so a leak there shows
    // up in the parsed output rather than being masked by a second literal.
    const projection = "{schemaVersion,operation,phase,targetReleaseSha:.target.releaseSha}";
    const bounded = `{"schemaVersion":1,"operation":"promote","phase":"committed","targetReleaseSha":"${"b".repeat(40)}"}`;
    const { root, result } = runHarness(`
source "$ACTIVATE"
printf '%s' '{"schemaVersion":1,"operation":"promote","phase":"committed","before":{"current":"SECRET-POINTER-SET"},"after":{"current":"SECRET-POINTER-SET"},"target":{"releaseSha":"${"b".repeat(40)}"}}' > "$LAST_TRANSITION_FILE"
validate_transition_journal() { :; }
inspect_pointer_state() { printf 'null\\n'; }
jq() {
  printf '%s\\n' "$*" >> "$STATE_DIR/jq.log"
  local index next after value=""
  if [[ "$1 $2" == "-c ${projection}" ]]; then
    printf '%s\\n' '${bounded}'
    return 0
  fi
  for ((index = 1; index <= $#; index++)); do
    next=$((index + 1)); after=$((index + 2))
    [[ "\${!index}" == "--argjson" && $next -le $# && "\${!next}" == "lastTransition" && $after -le $# ]] && value="\${!after}"
  done
  if [[ -n "$value" ]]; then
    printf '{"schemaVersion":2,"transition":null,"lastTransition":%s,"current":null,"previous":null,"pending":null}\\n' "$value"
    return 0
  fi
  printf 'unbounded jq filter: %s\\n' "$*" >&2
  return 97
}
inspect_state
`);
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout) as { lastTransition: Record<string, unknown> };
    expect(state.lastTransition).toEqual({
      schemaVersion: 1, operation: "promote", phase: "committed", targetReleaseSha: "b".repeat(40),
    });
    expect(state.lastTransition).not.toHaveProperty("before");
    expect(state.lastTransition).not.toHaveProperty("after");
    expect(state.lastTransition).not.toHaveProperty("target");
    const filters = readFileSync(join(root, "state", "jq.log"), "utf8");
    expect(filters).toContain(`-c ${projection}`);
    expect(filters).not.toContain("SECRET-POINTER-SET");
    expect(result.stdout).not.toContain("SECRET-POINTER-SET");
  });

  it("rejects any container missing an exact read-only secret mount or security boundary", () => {
    const cases = [
      {}, { MOUNT_DEST: "/wrong" }, { MOUNT_RW: "true" }, { CAP_DROP: "" },
      { SECURITY_OPT: "" }, { NETWORK_MODE: "bridge" }, { INIT: "false" }, { TMPFS: "" },
      { ACTUAL_NODE_OPTIONS: "--max-old-space-size=999" }, { ACTUAL_NODE_OPTIONS: "" },
      // A docker.sock bind mount is root on the shared VPS; the guard against it
      // had no negative case at all, so it could have been deleted unnoticed.
      { EXTRA_MOUNTS: "/var/run/docker.sock|/var/run/docker.sock|false" },
      { EXTRA_MOUNTS: "/var/run/docker.sock|/var/run/docker.sock|true" },
      { EXTRA_MOUNTS: "/host/docker.sock|/var/run/docker.sock|false" },
    ];
    const defaults = {
      MOUNT_DEST: "/run/secrets/network-center",
      MOUNT_RW: "false",
      CAP_DROP: "ALL",
      SECURITY_OPT: "no-new-privileges:true",
      NETWORK_MODE: "host",
      INIT: "true",
      TMPFS: "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
      ACTUAL_NODE_OPTIONS: "--max-old-space-size=320",
      EXTRA_MOUNTS: "",
    };
    for (const overrides of cases) {
      const { result } = runHarness(`
source "$ACTIVATE"
validate_pointer() { :; }
verify_runtime_secret_generation() { :; }
pointer_value() { case "$2" in .containerName) printf 'worker\\n';; .imageId) printf 'sha256:%064d\\n' 1;; .releaseSha) printf '%040d\\n' 2;; .secretGeneration) printf '%064d\\n' 3;; esac; }
docker() {
  local args="$*"
  case "$args" in
    *".State.Health"*) printf 'healthy\\n';;
    *".Image"*) printf 'sha256:%064d\\n' 1;;
    *"org.opencontainers.image.revision"*) printf '%040d\\n' 2;;
    *".Config.User"*) printf '10001:10001\\n';;
    *".Config.Env"*) printf 'NODE_OPTIONS=%s\\n' "$ACTUAL_NODE_OPTIONS";;
    *".HostConfig.ReadonlyRootfs"*) printf 'true\\n';;
    *".HostConfig.Memory"*) printf '536870912\\n';;
    *".HostConfig.NanoCpus"*) printf '500000000\\n';;
    *".HostConfig.PidsLimit"*) printf '128\\n';;
    *".HostConfig.RestartPolicy.Name"*) printf 'unless-stopped\\n';;
    *".HostConfig.CapDrop"*) printf '%s\\n' "$CAP_DROP";;
    *".HostConfig.SecurityOpt"*) printf '%s\\n' "$SECURITY_OPT";;
    *".HostConfig.NetworkMode"*) printf '%s\\n' "$NETWORK_MODE";;
    *".HostConfig.Init"*) printf '%s\\n' "$INIT";;
    *".HostConfig.Tmpfs"*) printf '%s\\n' "$TMPFS";;
    *".Mounts"*)
      printf '%s|%s|%s\\n' "$RUNTIME_SECRET_GENERATIONS_DIR/$(printf '%064d' 3)" "$MOUNT_DEST" "$MOUNT_RW"
      [[ -z "$EXTRA_MOUNTS" ]] || printf '%s\\n' "$EXTRA_MOUNTS";;
    *) return 0;;
  esac
}
pointer_exact_healthy ignored
`, { ...defaults, ...overrides });
      if (Object.keys(overrides).length === 0) expect(result.status, result.stderr).toBe(0);
      else expect(result.status, JSON.stringify(overrides)).not.toBe(0);
    }
  }, 20_000);

  it("writes prepared journal before an injected transition failure", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
write_transition() { printf '%s|%s|%s|%s|%s\\n' "$@" > "$STATE_DIR/write.log"; touch "$TRANSITION_FILE"; }
begin_transition promote BEFORE AFTER TARGET
`, { NETWORK_CENTER_FAILPOINT: "after-transition-prepared" });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(root, "state", "write.log"), "utf8")).toContain("promote|prepared|BEFORE|AFTER|TARGET");
    expect(existsSync(join(root, "state", "transition.json"))).toBe(true);
  });

  it("deletes only unreferenced secret generations", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
mkdir -p "$SECRET_GENERATIONS_DIR/$KEEP" "$SECRET_GENERATIONS_DIR/$DROP" "$RUNTIME_SECRET_GENERATIONS_DIR/$KEEP" "$RUNTIME_SECRET_GENERATIONS_DIR/$DROP"
referenced_values() { [[ "$1" == secretGeneration ]] && printf '%s\\n' "$KEEP"; }
docker() { [[ "$1 $2" == 'ps -aq' ]] && return 0; return 0; }
cleanup_unreferenced_secret_generations
`, { KEEP: "a".repeat(64), DROP: "b".repeat(64) });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "secret-generations", "a".repeat(64)))).toBe(true);
    expect(existsSync(join(root, "secret-generations", "b".repeat(64)))).toBe(false);
    expect(existsSync(join(root, "runtime", "secret-generations", "a".repeat(64)))).toBe(true);
    expect(existsSync(join(root, "runtime", "secret-generations", "b".repeat(64)))).toBe(false);
  });

  it("loads the installed activation library before enforcing rollback root access", () => {
    const { result } = runHarness(`
mkdir -p "$NETWORK_CENTER_ROOT/bin"
cp "$ACTIVATE" "$NETWORK_CENTER_ROOT/bin/activate-release.sh"
id() { printf '1\\n'; }
source "$ROLLBACK"
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must run as root/i);
    expect(result.stderr).not.toMatch(/readonly variable/i);
  });

  it("defers cleanup failure without converting a committed activation into rollback", () => {
    const { result } = runHarness(`
source "$ACTIVATE"
cleanup=complete
cleanup_after_commit >/dev/null 2>&1 || cleanup=deferred
printf '%s\\n' "$cleanup"
`, { NETWORK_CENTER_FAILPOINT: "cleanup" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("deferred");
  });

  it("reclaims unreferenced release residue before refusing to re-stage the same SHA", () => {
    // A dropped session between `mv` and `write_pointer` leaves a release
    // directory nothing points at. Refusing the SHA before the reclaim made that
    // SHA permanently un-deployable; reclaiming first must still refuse a
    // directory a pointer really does reference.
    for (const referenced of [false, true]) {
      const { root, result } = runHarness(`
source "$ACTIVATE"
mkdir -p "$RELEASES_DIR/$SHA" "$INCOMING_DIR" "$STATE_DIR"
printf 'residue\\n' > "$RELEASES_DIR/$SHA/marker"
printf 'archive' > "$NETWORK_CENTER_ROOT/release.tar.gz"
stat() { case "$*" in *"%u:%g"*) printf '0:0\\n';; *"%a"*) printf '600\\n';; *) command stat "$@";; esac; }
sha256sum() { printf '%s  -\\n' "$DIGEST"; }
docker() { return 0; }
jq() {
  case "$*" in
    *".releaseSha"*) printf '%s\\n' "$SHA";;
    *".imageId"*) printf 'sha256:%064d\\n' 1;;
    *".secretGeneration"*) printf '%064d\\n' 2;;
    *) return 1;;
  esac
}
[[ "$REFERENCED" != true ]] || printf '{}' > "$CURRENT_POINTER"
ensure_disk_reserve() { printf 'staging-proceeded\\n'; exit 0; }
stage_candidate "$SHA" "$NETWORK_CENTER_ROOT/release.tar.gz" "$DIGEST"
`, { SHA: "e".repeat(40), DIGEST: "f".repeat(64), REFERENCED: String(referenced) });
      if (referenced) {
        expect(result.status, "a referenced release directory must still be refused").not.toBe(0);
        expect(result.stderr).toMatch(/release directory already exists/);
        expect(existsSync(join(root, "releases", "e".repeat(40), "marker"))).toBe(true);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("staging-proceeded");
        expect(existsSync(join(root, "releases", "e".repeat(40)))).toBe(false);
      }
    }
  }, 15_000);

  it("fsyncs every journal and pointer write and its directory before the rename is reported", () => {
    // mktemp + `mv -fT` is atomic but not durable: transition.json does not exist
    // before begin_transition, so ext4's replace-via-rename heuristic does not
    // cover it and a hard reset can return a zero-length journal.
    const { result } = runHarness(`
source "$ACTIVATE"
audit="$NETWORK_CENTER_ROOT/durability.log"
: > "$audit"
sync() { printf 'sync:%s\\n' "$*" >> "$audit"; }
mv() { printf 'mv:%s\\n' "$*" >> "$audit"; command mv "$@"; }
jq() { printf '{"schemaVersion":1}\\n'; }
validate_pointer() { :; }
validate_transition_journal() { :; }
printf -- '--write_transition--\\n' >> "$audit"
write_transition promote prepared BEFORE AFTER TARGET
printf -- '--write_pointer--\\n' >> "$audit"
write_pointer "$PENDING_POINTER" a b c d e f g h i
printf -- '--write_pointer_json--\\n' >> "$audit"
write_pointer_json "$PREVIOUS_POINTER" '{"schemaVersion":2}'
printf -- '--write_last_transition--\\n' >> "$audit"
write_last_transition promote committed BEFORE AFTER TARGET
cat "$audit"
`);
    expect(result.status, result.stderr).toBe(0);
    const sections = new Map<string, string[]>();
    let section = "";
    for (const line of result.stdout.trim().split("\n")) {
      const marker = /^--(\w+)--$/.exec(line.trim());
      if (marker) { section = marker[1]!; sections.set(section, []); continue; }
      sections.get(section)?.push(line.trim());
    }
    for (const writer of ["write_transition", "write_pointer", "write_pointer_json", "write_last_transition"]) {
      const lines = sections.get(writer);
      expect(lines, `${writer} produced no durability audit`).toBeDefined();
      expect(lines, writer).toHaveLength(3);
      expect(lines![0], `${writer} must fsync the staged file`).toMatch(/^sync:.*\/state\/\.[a-z-]+\./);
      expect(lines![1], `${writer} must rename atomically`).toMatch(/^mv:-fT .*\/state\/\.[a-z-]+\..* .*\/state\//);
      expect(lines![2], `${writer} must fsync the containing directory`).toMatch(/^sync:.* \S*\/state$/);
    }
  });

  it("quarantines a truncated transition journal instead of wedging boot", () => {
    for (const corrupt of ["", '{"schemaVersion":1,"operation":"pro']) {
      const { root, result } = runHarness(`
source "$ACTIVATE"
printf '%s' "$CORRUPT" > "$TRANSITION_FILE"
sync() { :; }
# jq -e over a truncated document prints nothing and exits non-zero.
jq() { return 4; }
converge_pointer_set() { printf 'converge\\n'; }
apply_pointer_set() { printf 'apply\\n'; }
recover_transition
printf 'boot-continued\\n'
`, { CORRUPT: corrupt });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("boot-continued");
      expect(result.stderr).toMatch(/quarantin/i);
      expect(existsSync(join(root, "state", "transition.json"))).toBe(false);
      const quarantined = readdirSync(join(root, "state")).filter((name) => name.includes("corrupt"));
      expect(quarantined, "the corrupt journal must be kept for inspection").toHaveLength(1);
      expect(readFileSync(join(root, "state", quarantined[0]!), "utf8")).toBe(corrupt);
    }
  });

  it("re-applies an interrupted emergency stop from a durable intent after the session drops", () => {
    // `ssh sudo --` sends SIGHUP when the session drops. Without a durable record
    // the worker stays stopped, current.release still points at the release, and
    // the oneshot unit keeps reporting active: all 15 buildings stop being polled.
    const { root, result } = runHarness(`
source "$ACTIVATE"
${CURRENT_RELEASE_FIXTURE}
${RUNTIME_INTENT_JQ}
make_release_env "$fixture_env" '${FIXTURE_SHA}' false
log="$NETWORK_CENTER_ROOT/session.log"
: > "$log"
stop_pointer() {
  [[ -e "$STATE_DIR/runtime-intent.json" ]] && printf 'intent-recorded-before-stop\\n' >> "$log"
  printf 'stopped\\n' >> "$log"
  kill -HUP $BASHPID
}
start_pointer() { printf 'started\\n' >> "$log"; }
( set_emergency_stop true ) || printf 'session-dropped\\n' >> "$log"
printf 'after-drop:%s\\n' "$(grep -c '^NETWORK_CENTER_EMERGENCY_STOP=true$' "$fixture_env" || true)"
stop_pointer() { printf 'stopped-again\\n' >> "$log"; }
recover_transition
printf 'after-recovery:%s\\n' "$(grep -c '^NETWORK_CENTER_EMERGENCY_STOP=true$' "$fixture_env" || true)"
cat "$log"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("session-dropped");
    expect(result.stdout).toContain("intent-recorded-before-stop");
    expect(result.stdout).toContain("after-recovery:1");
    expect(result.stdout).toContain("started");
    expect(existsSync(join(root, "state", "runtime-intent.json"))).toBe(false);
  });

  it("recovers the recorded runtime intent when a signal lands mid-mutation", () => {
    const { result } = runHarness(`
source "$ACTIVATE"
recover_runtime_intent() { printf 'recovered-runtime-intent\\n'; }
install_activation_signal_handlers
activation_mutation_in_flight=true
kill -HUP $$
sleep 1
printf 'not-reached\\n'
`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("recovered-runtime-intent");
    expect(result.stdout).not.toContain("not-reached");
    expect(result.stderr).toMatch(/SIGHUP/);
  });

  it("never lets an emergency stop revert itself when the health gate needs a poll cycle", () => {
    // The container health file is written only after a full polling cycle plus a
    // Supabase round trip, so a pause applied to a misbehaving fleet is expected
    // to miss the gate. Reverting there re-armed the very worker being stopped.
    const scenarios = [
      { REQUESTED: "true", INITIAL: "false", STATUS: "running" },
      { REQUESTED: "true", INITIAL: "false", STATUS: "exited" },
      { REQUESTED: "false", INITIAL: "true", STATUS: "running" },
    ];
    for (const scenario of scenarios) {
      const { root, result } = runHarness(`
source "$ACTIVATE"
${CURRENT_RELEASE_FIXTURE}
make_release_env "$fixture_env" '${FIXTURE_SHA}' "$INITIAL"
stop_pointer() { :; }
start_pointer() { return 1; }
docker() { case "$*" in *".State.Status"*) printf '%s\\n' "$STATUS";; *) return 1;; esac; }
jq() { printf 'receipt:%s\\n' "$*"; }
set_emergency_stop "$REQUESTED"
`, scenario);
      const env = readFileSync(join(root, "releases", FIXTURE_SHA, ".env.active"), "utf8");
      expect(env, JSON.stringify(scenario)).toContain("NETWORK_CENTER_EMERGENCY_STOP=true");
      expect(env, JSON.stringify(scenario)).not.toContain("NETWORK_CENTER_EMERGENCY_STOP=false");
      expect(existsSync(join(root, "state", "runtime-intent.json"))).toBe(false);
      if (scenario.REQUESTED === "true" && scenario.STATUS === "running") {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/receipt:.*--arg health unverified/);
      } else {
        expect(result.status, JSON.stringify(scenario)).not.toBe(0);
      }
    }
  }, 15_000);

  it("fsyncs a staged secret generation's files, itself and its parent around the directory rename", () => {
    // `sync` on a directory flushes that directory's own entries and nothing
    // inside it, so a directory made durable the way a file is can come back
    // with every name present and every file empty. For a secret generation
    // that is worse than losing the rename outright: the manifest stops
    // matching, verify_persistent_secret_generation fails, and validate_pointer
    // then refuses current.release at every boot.
    const { result } = runHarness(`
source "$ACTIVATE"
audit="$NETWORK_CENTER_ROOT/durability.log"
: > "$audit"
sync() { printf 'sync:%s\\n' "$*" >> "$audit"; }
mv() { printf 'mv:%s\\n' "$*" >> "$audit"; command mv "$@"; }
chown() { :; }
stat() {
  if [[ "$1 $2" == "-c %u:%g:%a" ]]; then
    if [[ "$3" == "$RUNTIME_SECRET_GENERATIONS_DIR"* ]]; then
      [[ -d "$3" ]] && printf '0:%s:750\\n' "$WORKER_GID" || printf '%s:%s:400\\n' "$WORKER_UID" "$WORKER_GID"
    else
      [[ -d "$3" ]] && printf '0:0:700\\n' || printf '0:0:600\\n'
    fi
  else command stat "$@"; fi
}
install() {
  local mode="" source="" destination="" last="" arg; for arg in "$@"; do last="$arg"; done
  if [[ " $* " == *" -d "* ]]; then mkdir -p "$last"; return; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in -o|-g|-m) [[ "$1" == -m ]] && mode="$2"; shift 2;; *) [[ -z "$source" ]] && source="$1" || destination="$1"; shift;; esac
  done
  cp "$source" "$destination"; [[ -z "$mode" ]] || chmod "$mode" "$destination"
}
mkdir -p "$SECRET_DIR"
printf 'worker-value' > "$SECRET_DIR/worker-secret"
printf '{"router":true}' > "$SECRET_DIR/router-credentials.json"
printf -- '--persistent--\\n' >> "$audit"
generation="$(snapshot_secret_generation)"
printf -- '--runtime--\\n' >> "$audit"
materialize_runtime_secret_generation "$generation" >/dev/null
cat "$audit"
`);
    expect(result.status, result.stderr).toBe(0);
    const sections = new Map<string, string[]>();
    let section = "";
    for (const line of result.stdout.trim().split("\n")) {
      const marker = /^--(\w+)--$/.exec(line.trim());
      if (marker) { section = marker[1]!; sections.set(section, []); continue; }
      if (/^(sync|mv):/.test(line.trim())) sections.get(section)?.push(line.trim());
    }
    const staged: Array<[string, string[]]> = [
      ["persistent", ["worker-secret", "router-credentials.json", "manifest.sha256"]],
      ["runtime", ["worker-secret", "router-credentials.json"]],
    ];
    for (const [name, files] of staged) {
      const lines = sections.get(name);
      expect(lines, `${name} generation produced no durability audit`).toBeDefined();
      const rename = lines!.findIndex((line) => line.startsWith("mv:-fT"));
      expect(rename, `${name} generation never renamed a staged directory`).toBeGreaterThan(0);
      for (const file of files) {
        expect(
          lines!.slice(0, rename).some((line) => line.endsWith(`/${file}`)),
          `${name} generation renamed ${file} into place without an fsync`,
        ).toBe(true);
      }
      expect(lines![rename - 1], `${name} generation must fsync the staged directory itself`)
        .toMatch(/^sync:-- \S+\/\.generation\.\w{6}$/);
      expect(lines![rename], `${name} generation must rename the staged directory atomically`)
        .toMatch(/^mv:-fT \S+\/\.generation\.\w{6} \S+\/secret-generations\/[a-f0-9]{64}$/);
      expect(lines![rename + 1], `${name} generation must fsync the parent directory entry`)
        .toMatch(/^sync:-- \S+\/secret-generations$/);
    }
  }, 15_000);

  it("removes the staging directory when a dropped session interrupts stage-candidate", () => {
    // `ssh sudo --` SIGHUPs the script when the session drops. The ERR trap does
    // not see a signal, so every interrupted stage used to leave a
    // `.release-<sha>.XXXXXX` tree behind on a disk shared with an unrelated
    // production service.
    const { root, result } = runHarness(`
source "$ACTIVATE"
mkdir -p "$RELEASES_DIR" "$INCOMING_DIR" "$STATE_DIR"
printf 'archive' > "$NETWORK_CENTER_ROOT/release.tar.gz"
stat() { case "$*" in *"%u:%g"*) printf '0:0\\n';; *"%a"*) printf '600\\n';; *) command stat "$@";; esac; }
sha256sum() { printf '%s  -\\n' "$DIGEST"; }
docker() { return 0; }
referenced_values() { return 0; }
ensure_disk_reserve() { :; }
tar() { case "$1" in -xzf) printf 'staging-interrupted\\n'; kill -HUP $$;; *) return 1;; esac; }
install_activation_signal_handlers
stage_candidate "$SHA" "$NETWORK_CENTER_ROOT/release.tar.gz" "$DIGEST"
printf 'not-reached\\n'
`, { SHA: "e".repeat(40), DIGEST: "f".repeat(64) });
    expect(result.status, "an interrupted stage must not report success").not.toBe(0);
    expect(result.stdout).toContain("staging-interrupted");
    expect(result.stdout).not.toContain("not-reached");
    const residue = readdirSync(join(root, "releases"));
    expect(residue, `interrupted staging left ${residue.join(", ")}`).toHaveLength(0);
  }, 15_000);

  it("sweeps interrupted staging residue without touching a referenced release or a co-tenant path", () => {
    // A SIGKILL or a power cut runs no trap at all, so cleanup has to be able to
    // see the residue by itself. It must stay inside this project's release and
    // generation roots and match only the exact mktemp shapes those two stages
    // create - the VPS also hosts an unrelated production service.
    const { root, result } = runHarness(`
source "$ACTIVATE"
mkdir -p "$RELEASES_DIR/$KEEP" "$RELEASES_DIR/.release-$KEEP.AbC123" "$RELEASES_DIR/.release-$DROP.xY9zQw"
mkdir -p "$RELEASES_DIR/9router-backup" "$NETWORK_CENTER_ROOT/co-tenant/.release-$DROP.AAAAAA"
mkdir -p "$SECRET_GENERATIONS_DIR/$GENERATION" "$SECRET_GENERATIONS_DIR/.generation.QqWwEe"
mkdir -p "$RUNTIME_SECRET_GENERATIONS_DIR/.generation.RrTtYy" "$INCOMING_DIR"
referenced_values() { case "$1" in releaseSha) printf '%s\\n' "$KEEP";; secretGeneration) printf '%s\\n' "$GENERATION";; esac; }
docker() { return 0; }
cleanup_unreferenced_releases
`, { KEEP: "e".repeat(40), DROP: "a".repeat(40), GENERATION: "c".repeat(64) });
    expect(result.status, result.stderr).toBe(0);
    const survives = (...parts: string[]) => existsSync(join(root, ...parts));
    expect(survives("releases", "e".repeat(40)), "a referenced release was deleted").toBe(true);
    expect(survives("secret-generations", "c".repeat(64)), "a referenced generation was deleted").toBe(true);
    expect(survives("releases", "9router-backup"), "an unrecognised release-root entry was deleted").toBe(true);
    expect(survives("co-tenant", `.release-${"a".repeat(40)}.AAAAAA`), "cleanup escaped its own roots").toBe(true);
    expect(survives("releases", `.release-${"e".repeat(40)}.AbC123`), "staging residue survived cleanup").toBe(false);
    expect(survives("releases", `.release-${"a".repeat(40)}.xY9zQw`), "staging residue survived cleanup").toBe(false);
    expect(survives("secret-generations", ".generation.QqWwEe"), "generation residue survived cleanup").toBe(false);
    expect(survives("runtime", "secret-generations", ".generation.RrTtYy"), "generation residue survived cleanup").toBe(false);
  }, 15_000);
});
