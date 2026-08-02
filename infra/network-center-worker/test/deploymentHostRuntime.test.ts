import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      NETWORK_CENTER_RUNTIME_ROOT: `${item.rootPosix}/runtime`,
      ...env,
    },
  });
  return { ...item, result };
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
    const { result } = runHarness(`
source "$INSTALL_HOST"
forwarding=0
firewall_active=false
wg_active=false
firewall_enabled=false
wg_enabled=false
systemctl() {
  local action="$1" unit="\${3:-\${2:-}}"
  case "$action" in
    is-active)
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_active" == true ]] ||
      [[ "$unit" == wg-quick@wg0.service && "$wg_active" == true ]] || return 3
      return 0;;
    is-enabled) [[ "$unit" == ihome-network-center-firewall.service && "$firewall_enabled" == true ]] || [[ "$unit" == wg-quick@wg0.service && "$wg_enabled" == true ]]; return;;
    enable)
      [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=true || wg_enabled=true
      [[ "$2" != --now ]] || { [[ "$unit" == wg-quick@wg0.service ]] && wg_active=true; }
      ;;
    restart) firewall_active=true;;
  esac
  printf 'systemctl:%s\n' "$*" >> "$NETWORK_CENTER_ROOT/order.log"
}
sysctl() {
  case "$1" in
    -n) printf '%s\n' "$forwarding";;
    --system) forwarding=1; printf 'sysctl:--system\n' >> "$NETWORK_CENTER_ROOT/order.log";;
    -w) forwarding="\${2##*=}"; printf 'sysctl:%s %s\n' "$1" "$2" >> "$NETWORK_CENTER_ROOT/order.log";;
  esac
}
wg() { printf 'wg:%s\n' "$*" >> "$NETWORK_CENTER_ROOT/order.log"; }
activate_network_prerequisites
cat "$NETWORK_CENTER_ROOT/order.log"
`);
    expect(result.status, result.stderr).toBe(0);
    const output = result.stdout;
    const forwardingOff = output.indexOf("sysctl:-w net.ipv4.ip_forward=0");
    const wireGuardStop = output.indexOf("systemctl:stop wg-quick@wg0.service");
    const firewallStart = output.indexOf("systemctl:restart ihome-network-center-firewall.service");
    const forwarding = output.indexOf("sysctl:--system");
    const wireGuard = output.indexOf("systemctl:enable --now wg-quick@wg0.service");
    expect(forwardingOff).toBeGreaterThanOrEqual(0);
    expect(wireGuardStop).toBeGreaterThan(forwardingOff);
    expect(firewallStart).toBeGreaterThan(wireGuardStop);
    expect(forwarding).toBeGreaterThan(firewallStart);
    expect(wireGuard).toBeGreaterThan(forwarding);
  });

  it("restores disabled forwarding and stopped services when firewall activation fails", () => {
    const { result } = runHarness(`
source "$INSTALL_HOST"
forwarding=0
firewall_active=false
wg_active=false
firewall_enabled=false
wg_enabled=false
systemctl() {
  local action="$1" unit="\${3:-\${2:-}}"
  case "$action" in
    is-active)
      [[ "$unit" == ihome-network-center-firewall.service && "$firewall_active" == true ]] ||
      [[ "$unit" == wg-quick@wg0.service && "$wg_active" == true ]] || return 3
      ;;
    is-enabled) [[ "$unit" == ihome-network-center-firewall.service && "$firewall_enabled" == true ]] || [[ "$unit" == wg-quick@wg0.service && "$wg_enabled" == true ]];;
    enable)
      [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=true || wg_enabled=true
      [[ "$2" != --now ]] || { [[ "$unit" == wg-quick@wg0.service ]] && wg_active=true; }
      ;;
    disable) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_enabled=false || wg_enabled=false;;
    stop) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_active=false || wg_active=false;;
    start) [[ "$unit" == ihome-network-center-firewall.service ]] && firewall_active=true || wg_active=true;;
    restart) firewall_active=false; return 1;;
  esac
}
sysctl() {
  case "$1" in
    -n) printf '%s\n' "$forwarding";;
    --system) forwarding=1;;
    -w) forwarding="\${2##*=}";;
  esac
}
wg() { :; }
set +e
activate_network_prerequisites
status=$?
set -e
printf '%s|%s|%s|%s|%s|%s\n' "$status" "$forwarding" "$firewall_active" "$wg_active" "$firewall_enabled" "$wg_enabled"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1|0|false|false|false|false");
  });

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
jq() {
  case "$*" in
    *"-cn"*) printf '{"schemaVersion":2}\\n';;
    *".operation"*) printf 'promote\\n';;
    *".phase"*"="*) printf '{"phase":"compensated"}\\n';;
    *".phase"*) printf 'committed\\n';;
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
    expect(readFileSync(join(root, "state", "last-transition.json"), "utf8")).toContain("compensated");
    expect(existsSync(join(root, "state", "events.log"))).toBe(false);
  });

  it("runs cleanup only when a committed or compensated transition is explicitly finalized", () => {
    const { root, result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$LAST_TRANSITION_FILE"
jq() {
  case "$*" in
    *"-cn"*) printf '{"schemaVersion":2}\\n';;
    *".operation"*) printf 'promote\\n';;
    *".phase"*"="*) printf '{"phase":"finalized"}\\n';;
    *".phase"*) printf 'committed\\n';;
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
    expect(readFileSync(join(root, "state", "last-transition.json"), "utf8")).toContain("finalized");
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
touch ignored
inspect_pointer_state ignored
`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runtimeAvailable: false, exactMatch: false });
  });

  it("exposes only bounded last-transition metadata in exact host inspection", () => {
    const { result } = runHarness(`
source "$ACTIVATE"
printf '{}' > "$LAST_TRANSITION_FILE"
validate_transition_journal() { :; }
inspect_pointer_state() { printf 'null\\n'; }
jq() {
  if [[ "$*" == *"targetReleaseSha:.target.releaseSha"* ]]; then
    printf '{"schemaVersion":1,"operation":"promote","phase":"committed","targetReleaseSha":"%s"}\\n' "$(printf 'b%.0s' {1..40})"
  elif [[ "$*" == *"--argjson lastTransition"* ]]; then
    printf '{"schemaVersion":2,"transition":null,"lastTransition":{"schemaVersion":1,"operation":"promote","phase":"committed","targetReleaseSha":"%s"},"current":null,"previous":null,"pending":null}\\n' "$(printf 'b%.0s' {1..40})"
  else return 97; fi
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
  });

  it("rejects any container missing an exact read-only secret mount or security boundary", () => {
    const cases = [
      {}, { MOUNT_DEST: "/wrong" }, { MOUNT_RW: "true" }, { CAP_DROP: "" },
      { SECURITY_OPT: "" }, { NETWORK_MODE: "bridge" }, { INIT: "false" }, { TMPFS: "" },
      { ACTUAL_NODE_OPTIONS: "--max-old-space-size=999" }, { ACTUAL_NODE_OPTIONS: "" },
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
    *".Mounts"*) printf '%s|%s|%s\\n' "$RUNTIME_SECRET_GENERATIONS_DIR/$(printf '%064d' 3)" "$MOUNT_DEST" "$MOUNT_RW";;
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
});
