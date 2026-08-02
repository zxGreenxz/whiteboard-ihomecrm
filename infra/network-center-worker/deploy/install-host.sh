#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly MANAGED_MARKER="# ihomecrm-network-center-managed:v1"
readonly NETWORK_CENTER_ROOT="${NETWORK_CENTER_ROOT:-/opt/ihome-network-center}"
readonly HOST_ROOT="${NETWORK_CENTER_HOST_ROOT:-}"
readonly WORKER_UID=10001
readonly WORKER_GID=10001
readonly ACTIVATE_DESTINATION="$NETWORK_CENTER_ROOT/bin/activate-release.sh"
readonly ROLLBACK_DESTINATION="$NETWORK_CENTER_ROOT/bin/rollback-release.sh"
readonly WORKER_UNIT_DESTINATION="$HOST_ROOT/etc/systemd/system/network-center-worker.service"
readonly FIREWALL_UNIT_DESTINATION="$HOST_ROOT/etc/systemd/system/ihome-network-center-firewall.service"
readonly WG_FIREWALL_DROPIN_DIR="$HOST_ROOT/etc/systemd/system/wg-quick@wg0.service.d"
readonly WG_FIREWALL_DROPIN_DESTINATION="$HOST_ROOT/etc/systemd/system/wg-quick@wg0.service.d/10-ihome-network-center-firewall.conf"
readonly SYSCTL_DIR="$HOST_ROOT/etc/sysctl.d"
readonly SYSCTL_DESTINATION="$SYSCTL_DIR/90-ihome-network-center.conf"
readonly WG0_DIR="$HOST_ROOT/etc/wireguard"
readonly WG0_DESTINATION="$WG0_DIR/wg0.conf"
readonly FIREWALL_DIR="$HOST_ROOT/etc/nftables.d"
readonly FIREWALL_DESTINATION="$FIREWALL_DIR/ihome-network-center.nft"
readonly RUNTIME_ROOT="$HOST_ROOT/run/ihome-network-center"
readonly RUNTIME_SECRET_GENERATIONS_DIR="$HOST_ROOT/run/ihome-network-center/secret-generations"

asset_dir=""
wg0_source=""
firewall_source=""
prior_ip_forward=""
prior_firewall_active=unknown
prior_firewall_enabled=unknown
prior_wg_active=unknown
prior_wg_enabled=unknown
install_transaction_dir=""

die() {
  printf 'network-center install: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" == "0" ]] || die "must run as root"
}

require_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "regular file required: $1"
}

require_directory() {
  [[ -d "$1" && ! -L "$1" ]] || die "directory required: $1"
}

require_safe_file_destination() {
  if [[ -L "$1" || ( -e "$1" && ! -f "$1" ) ]]; then
    die "unsafe file destination: $1"
  fi
}

require_existing_managed_destination() {
  require_safe_file_destination "$1"
  [[ ! -e "$1" ]] && return 0
  grep -Fqx "$MANAGED_MARKER" "$1" ||
    die "managed marker missing from existing destination: $1"
}

require_safe_directory_destination() {
  if [[ -L "$1" || ( -e "$1" && ! -d "$1" ) ]]; then
    die "unsafe directory destination: $1"
  fi
}

backup_managed_file() {
  local destination="$1"
  local backup_dir="$NETWORK_CENTER_ROOT/backups/host-config"
  local timestamp backup expected actual
  if [[ -L "$destination" || ( -e "$destination" && ! -f "$destination" ) ]]; then
    die "unsafe managed file path: $destination"
  fi
  install -d -o root -g root -m 0700 "$backup_dir"
  if [[ ! -e "$destination" ]]; then
    printf 'ABSENT\n' > "$backup_dir/$(basename "$destination").absent"
    chmod 0600 "$backup_dir/$(basename "$destination").absent"
    return
  fi
  require_file "$destination"
  grep -Fqx "$MANAGED_MARKER" "$destination" ||
    die "refusing to overwrite unmanaged file: $destination"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$backup_dir/$(basename "$destination").$timestamp.bak"
  install -o root -g root -m 0600 "$destination" "$backup"
  expected="$(sha256sum "$destination" | awk '{print $1}')"
  actual="$(sha256sum "$backup" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || die "backup verification failed: $destination"
}

preflight_install() {
  local asset directory
  [[ -n "$asset_dir" ]] || die "--asset-dir is required"
  [[ -n "$wg0_source" ]] || die "--wg0-source is required"
  [[ -n "$firewall_source" ]] || die "--firewall-source is required"
  require_directory "$asset_dir"
  require_file "$wg0_source"
  require_file "$firewall_source"
  for asset in network-center-worker.service ihome-network-center-firewall.service \
    90-ihome-network-center.conf activate-release.sh rollback-release.sh; do
    require_file "$asset_dir/$asset"
  done
  cmp -s "$asset_dir/90-ihome-network-center.conf" \
    <(printf '%s\nnet.ipv4.ip_forward=1\n' "$MANAGED_MARKER") ||
    die "90-ihome-network-center.conf must have exact managed forwarding content"
  grep -Fqx "$MANAGED_MARKER" "$wg0_source" || die "managed marker missing: $wg0_source"
  grep -Fqx "$MANAGED_MARKER" "$firewall_source" || die "managed marker missing: $firewall_source"
  if grep -Eiq '^[[:space:]]*flush[[:space:]]+ruleset\b' "$firewall_source"; then
    die "managed firewall must not flush the host ruleset"
  fi
  for directory in "$NETWORK_CENTER_ROOT" \
    "$NETWORK_CENTER_ROOT/releases" "$NETWORK_CENTER_ROOT/incoming" \
    "$NETWORK_CENTER_ROOT/state" "$NETWORK_CENTER_ROOT/config" \
    "$NETWORK_CENTER_ROOT/secrets" "$NETWORK_CENTER_ROOT/secret-generations" \
    "$NETWORK_CENTER_ROOT/backups" "$NETWORK_CENTER_ROOT/backups/router" \
    "$NETWORK_CENTER_ROOT/backups/host-config" "$NETWORK_CENTER_ROOT/bin" \
    "$HOST_ROOT/etc/systemd/system" "$WG_FIREWALL_DROPIN_DIR" \
    "$SYSCTL_DIR" "$WG0_DIR" "$FIREWALL_DIR" \
    "$RUNTIME_ROOT" "$RUNTIME_SECRET_GENERATIONS_DIR"; do
    require_safe_directory_destination "$directory"
  done
  require_safe_file_destination "$ACTIVATE_DESTINATION"
  require_existing_managed_destination "$ACTIVATE_DESTINATION"
  require_safe_file_destination "$ROLLBACK_DESTINATION"
  require_existing_managed_destination "$ROLLBACK_DESTINATION"
  require_safe_file_destination "$WORKER_UNIT_DESTINATION"
  require_existing_managed_destination "$WORKER_UNIT_DESTINATION"
  require_safe_file_destination "$FIREWALL_UNIT_DESTINATION"
  require_existing_managed_destination "$FIREWALL_UNIT_DESTINATION"
  require_safe_file_destination "$WG_FIREWALL_DROPIN_DESTINATION"
  require_existing_managed_destination "$WG_FIREWALL_DROPIN_DESTINATION"
  require_safe_file_destination "$SYSCTL_DESTINATION"
  require_existing_managed_destination "$SYSCTL_DESTINATION"
  require_safe_file_destination "$WG0_DESTINATION"
  require_existing_managed_destination "$WG0_DESTINATION"
  require_safe_file_destination "$FIREWALL_DESTINATION"
  require_existing_managed_destination "$FIREWALL_DESTINATION"
  asset_dir="$(readlink -f "$asset_dir")"
  wg0_source="$(readlink -f "$wg0_source")"
  firewall_source="$(readlink -f "$firewall_source")"
}

install_managed_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local temporary
  require_file "$source"
  grep -Fqx "$MANAGED_MARKER" "$source" || die "managed marker missing: $source"
  backup_managed_file "$destination"
  temporary="$(mktemp "$(dirname "$destination")/.network-center.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$destination"
}

persistent_host_files() {
  printf '%s\n' \
    "$ACTIVATE_DESTINATION" \
    "$ROLLBACK_DESTINATION" \
    "$WORKER_UNIT_DESTINATION" \
    "$SYSCTL_DESTINATION" \
    "$WG0_DESTINATION" \
    "$FIREWALL_DESTINATION" \
    "$FIREWALL_UNIT_DESTINATION" \
    "$WG_FIREWALL_DROPIN_DESTINATION"
}

capture_persistent_host_files() {
  local destination index=0
  install_transaction_dir="$(mktemp -d "$NETWORK_CENTER_ROOT/state/.host-install-rollback.XXXXXX")" || return 1
  chmod 0700 "$install_transaction_dir" || return 1
  while IFS= read -r destination; do
    index=$((index + 1))
    require_safe_file_destination "$destination"
    if [[ -e "$destination" ]]; then
      printf 'present\n' > "$install_transaction_dir/$index.state" || return 1
      cp --archive --no-dereference -- "$destination" "$install_transaction_dir/$index.file" ||
        return 1
    else
      printf 'absent\n' > "$install_transaction_dir/$index.state" || return 1
    fi
  done < <(persistent_host_files)
}

restore_persistent_host_files() {
  local destination index=0 state temporary failed=0
  [[ -n "$install_transaction_dir" && -d "$install_transaction_dir" ]] || return 1
  while IFS= read -r destination; do
    index=$((index + 1))
    state="$(cat "$install_transaction_dir/$index.state" 2>/dev/null || true)"
    case "$state" in
      present)
        mkdir -p "$(dirname "$destination")" || { failed=1; continue; }
        temporary="$(mktemp "$(dirname "$destination")/.network-center-restore.XXXXXX")" || {
          failed=1
          continue
        }
        if cp --preserve=all -- "$install_transaction_dir/$index.file" "$temporary"; then
          if ! mv -fT -- "$temporary" "$destination"; then
            rm -f -- "$temporary"
            failed=1
          fi
        else
          rm -f -- "$temporary"
          failed=1
        fi
        ;;
      absent)
        if [[ -d "$destination" && ! -L "$destination" ]]; then
          failed=1
        else
          rm -f -- "$destination" || failed=1
        fi
        ;;
      *) failed=1 ;;
    esac
  done < <(persistent_host_files)
  return "$failed"
}

cleanup_persistent_host_snapshot() {
  [[ -z "$install_transaction_dir" ]] && return 0
  [[ "$install_transaction_dir" == "$NETWORK_CENTER_ROOT/state/.host-install-rollback."* ]] || return 1
  rm -rf -- "$install_transaction_dir" || return 1
  install_transaction_dir=""
}

ensure_identity() {
  local existing
  existing="$(getent group "$WORKER_GID" | cut -d: -f1 || true)"
  if [[ -n "$existing" && "$existing" != "network-center" ]]; then
    die "GID $WORKER_GID is already owned by $existing"
  fi
  existing="$(getent passwd "$WORKER_UID" | cut -d: -f1 || true)"
  if [[ -n "$existing" && "$existing" != "network-center" ]]; then
    die "UID $WORKER_UID is already owned by $existing"
  fi
  getent group network-center >/dev/null || groupadd --gid "$WORKER_GID" network-center
  id network-center >/dev/null 2>&1 ||
    useradd --uid "$WORKER_UID" --gid "$WORKER_GID" --no-create-home \
      --shell /usr/sbin/nologin network-center
  [[ "$(id -u network-center)" == "$WORKER_UID" ]] || die "worker UID mismatch"
  [[ "$(id -g network-center)" == "$WORKER_GID" ]] || die "worker GID mismatch"
}

ensure_runtime_packages() {
  if ! command -v docker >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends docker.io
    systemctl enable --now docker.service
  fi
  if ! docker compose version >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends docker-compose-v2 ||
      apt-get install -y --no-install-recommends docker-compose-plugin
  fi
  systemctl enable --now docker.service
  systemctl is-active --quiet docker.service || die "Docker service is not active"
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable"
  if ! command -v wg >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends wireguard-tools
  fi
  if ! command -v nft >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends nftables
  fi
  if ! command -v jq >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends jq
  fi
}

capture_network_prerequisite_state() {
  local ip_forward actual_firewall_active actual_firewall_enabled actual_wg_active actual_wg_enabled
  ip_forward="$(sysctl -n net.ipv4.ip_forward)" || return 1
  [[ "$ip_forward" == 0 || "$ip_forward" == 1 ]] || return 1
  actual_firewall_active="$(service_active_state ihome-network-center-firewall.service)" || return 1
  actual_firewall_enabled="$(service_enabled_state ihome-network-center-firewall.service)" || return 1
  actual_wg_active="$(service_active_state wg-quick@wg0.service)" || return 1
  actual_wg_enabled="$(service_enabled_state wg-quick@wg0.service)" || return 1
  prior_ip_forward="$ip_forward"
  prior_firewall_active="$actual_firewall_active"
  prior_firewall_enabled="$actual_firewall_enabled"
  prior_wg_active="$actual_wg_active"
  prior_wg_enabled="$actual_wg_enabled"
}

service_active_state() {
  local status=0
  systemctl is-active --quiet "$1" || status=$?
  case "$status" in
    0) printf 'true\n' ;;
    3) printf 'false\n' ;;
    *) return 1 ;;
  esac
}

service_enabled_state() {
  local status=0
  systemctl is-enabled --quiet "$1" || status=$?
  case "$status" in
    0) printf 'true\n' ;;
    1) printf 'false\n' ;;
    *) return 1 ;;
  esac
}

persist_forwarding_disabled() {
  local temporary
  if [[ -L "$SYSCTL_DESTINATION" || ( -e "$SYSCTL_DESTINATION" && ! -f "$SYSCTL_DESTINATION" ) ]]; then
    return 1
  fi
  if [[ -L "$SYSCTL_DIR" || ( -e "$SYSCTL_DIR" && ! -d "$SYSCTL_DIR" ) ]]; then
    return 1
  fi
  mkdir -p "$SYSCTL_DIR" || return 1
  temporary="$(mktemp "$SYSCTL_DIR/.network-center-fail-closed.XXXXXX")" || return 1
  if ! printf '%s\nnet.ipv4.ip_forward=0\n' "$MANAGED_MARKER" > "$temporary" ||
     ! chmod 0644 "$temporary" ||
     ! mv -fT -- "$temporary" "$SYSCTL_DESTINATION"; then
    rm -f -- "$temporary"
    return 1
  fi
  cmp -s "$SYSCTL_DESTINATION" \
    <(printf '%s\nnet.ipv4.ip_forward=0\n' "$MANAGED_MARKER")
}

force_network_fail_closed() {
  local failed=0 actual_firewall_active actual_firewall_enabled actual_wg_active actual_wg_enabled
  persist_forwarding_disabled || failed=1
  sysctl -w net.ipv4.ip_forward=0 >/dev/null || failed=1
  systemctl stop wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  systemctl stop ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1
  systemctl disable wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  systemctl disable ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1
  actual_firewall_active="$(service_active_state ihome-network-center-firewall.service)" || failed=1
  actual_wg_active="$(service_active_state wg-quick@wg0.service)" || failed=1
  actual_firewall_enabled="$(service_enabled_state ihome-network-center-firewall.service)" || failed=1
  actual_wg_enabled="$(service_enabled_state wg-quick@wg0.service)" || failed=1
  [[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null || true)" == 0 ]] || failed=1
  [[ "$actual_firewall_active" == false && "$actual_wg_active" == false ]] || failed=1
  [[ "$actual_firewall_enabled" == false && "$actual_wg_enabled" == false ]] || failed=1
  cmp -s "$SYSCTL_DESTINATION" \
    <(printf '%s\nnet.ipv4.ip_forward=0\n' "$MANAGED_MARKER") || failed=1
  return "$failed"
}

restore_network_prerequisite_state() {
  local failed=0 actual_firewall_active actual_firewall_enabled actual_wg_active actual_wg_enabled
  sysctl -w net.ipv4.ip_forward=0 >/dev/null || failed=1
  systemctl stop wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  systemctl stop ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1

  if [[ "$prior_firewall_enabled" == true ]]; then
    systemctl enable ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1
  else
    systemctl disable ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1
  fi
  if [[ "$prior_wg_enabled" == true ]]; then
    systemctl enable wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  else
    systemctl disable wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  fi
  if [[ "$prior_firewall_active" == true ]]; then
    systemctl start ihome-network-center-firewall.service >/dev/null 2>&1 || failed=1
  fi
  if [[ "$prior_ip_forward" == 1 ]]; then
    sysctl -w net.ipv4.ip_forward=1 >/dev/null || failed=1
  fi
  if [[ "$prior_wg_active" == true ]]; then
    systemctl start wg-quick@wg0.service >/dev/null 2>&1 || failed=1
  fi
  actual_firewall_active="$(service_active_state ihome-network-center-firewall.service)" || failed=1
  actual_wg_active="$(service_active_state wg-quick@wg0.service)" || failed=1
  actual_firewall_enabled="$(service_enabled_state ihome-network-center-firewall.service)" || failed=1
  actual_wg_enabled="$(service_enabled_state wg-quick@wg0.service)" || failed=1
  [[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null || true)" == "$prior_ip_forward" ]] || failed=1
  [[ "$actual_firewall_active" == "$prior_firewall_active" ]] || failed=1
  [[ "$actual_wg_active" == "$prior_wg_active" ]] || failed=1
  [[ "$actual_firewall_enabled" == "$prior_firewall_enabled" ]] || failed=1
  [[ "$actual_wg_enabled" == "$prior_wg_enabled" ]] || failed=1
  if [[ "$failed" != 0 ]]; then
    if force_network_fail_closed >/dev/null 2>&1; then
      return 1
    fi
    return 2
  fi
  return 0
}

apply_network_prerequisites() {
  sysctl -w net.ipv4.ip_forward=0 >/dev/null || return 1
  systemctl stop wg-quick@wg0.service || return 1
  systemctl enable ihome-network-center-firewall.service >/dev/null || return 1
  systemctl restart ihome-network-center-firewall.service || return 1
  systemctl is-active --quiet ihome-network-center-firewall.service || return 1
  sysctl --system >/dev/null || return 1
  [[ "$(sysctl -n net.ipv4.ip_forward)" == 1 ]] || return 1
  systemctl enable --now wg-quick@wg0.service || return 1
  systemctl is-active --quiet wg-quick@wg0.service || return 1
  wg show wg0 >/dev/null 2>&1 || return 1
}

activate_network_prerequisites() {
  capture_network_prerequisite_state || return 1
  if apply_network_prerequisites; then
    return 0
  fi
  restore_network_prerequisite_state || return 2
  return 1
}

rollback_failed_network_activation() {
  local restore_status
  if restore_persistent_host_files && systemctl daemon-reload >/dev/null 2>&1; then
    restore_status=0
    restore_network_prerequisite_state || restore_status=$?
    if [[ "$restore_status" == 0 ]]; then
      cleanup_persistent_host_snapshot || return 2
      return 0
    fi
    return "$restore_status"
  fi
  if force_network_fail_closed >/dev/null 2>&1; then
    return 1
  fi
  return 2
}

prepare_directories() {
  local directory
  for directory in releases incoming state config secrets secret-generations backups bin; do
    if [[ -e "$NETWORK_CENTER_ROOT/$directory" ]] &&
       [[ ! -d "$NETWORK_CENTER_ROOT/$directory" || -L "$NETWORK_CENTER_ROOT/$directory" ]]; then
      die "managed host directory path is unsafe: $directory"
    fi
    install -d -o root -g root -m 0700 "$NETWORK_CENTER_ROOT/$directory"
  done
  install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 \
    "$NETWORK_CENTER_ROOT/backups/router"
  install -d -o root -g "$WORKER_GID" -m 0750 \
    "$RUNTIME_SECRET_GENERATIONS_DIR"
  find "$NETWORK_CENTER_ROOT/secrets" -mindepth 1 -maxdepth 1 -type f -print0 |
    while IFS= read -r -d '' secret; do
      chown 0:0 "$secret"
      chmod 0600 "$secret"
    done
}

install_assets() {
  local dropin_source
  require_file "$asset_dir/network-center-worker.service"
  require_file "$asset_dir/ihome-network-center-firewall.service"
  require_file "$asset_dir/90-ihome-network-center.conf"
  require_file "$asset_dir/activate-release.sh"
  require_file "$asset_dir/rollback-release.sh"
  install_managed_asset "$asset_dir/activate-release.sh" "$ACTIVATE_DESTINATION" 0755 shebang
  install_managed_asset "$asset_dir/rollback-release.sh" "$ROLLBACK_DESTINATION" 0755 shebang
  install_managed_asset "$asset_dir/network-center-worker.service" \
    "$WORKER_UNIT_DESTINATION" 0644 prepend
  install_managed_asset "$asset_dir/ihome-network-center-firewall.service" \
    "$FIREWALL_UNIT_DESTINATION" 0644 prepend
  install -d -o root -g root -m 0755 "$WG_FIREWALL_DROPIN_DIR"
  dropin_source="$(mktemp "$NETWORK_CENTER_ROOT/.wg-firewall-dropin.XXXXXX")"
  cat > "$dropin_source" <<EOF
$MANAGED_MARKER
[Unit]
Requires=ihome-network-center-firewall.service
After=ihome-network-center-firewall.service
EOF
  install_managed_file "$dropin_source" \
    "$WG_FIREWALL_DROPIN_DESTINATION" 0644
  rm -f -- "$dropin_source"
  install_managed_file "$asset_dir/90-ihome-network-center.conf" \
    "$SYSCTL_DESTINATION" 0644
  systemctl daemon-reload
}

install_managed_asset() {
  local source="$1" destination="$2" mode="$3" marker_position="$4"
  local temporary first_line
  temporary="$(mktemp "$install_transaction_dir/.managed-asset.XXXXXX")" || return 1
  if [[ "$marker_position" == shebang ]]; then
    IFS= read -r first_line < "$source" || return 1
    [[ "$first_line" == '#!'* ]] || die "shell asset must start with a shebang: $source"
    {
      printf '%s\n%s\n' "$first_line" "$MANAGED_MARKER"
      tail -n +2 "$source"
    } > "$temporary"
  else
    {
      printf '%s\n' "$MANAGED_MARKER"
      cat "$source"
    } > "$temporary"
  fi
  install_managed_file "$temporary" "$destination" "$mode"
}

perform_install_mutations() {
  local asset_installer="$1" wg0_mode
  "$asset_installer"

  install -d -o root -g root -m 0700 "$WG0_DIR"
  install_managed_file "$wg0_source" "$WG0_DESTINATION" 0600
  install -d -o root -g root -m 0755 "$FIREWALL_DIR"
  install_managed_file "$firewall_source" "$FIREWALL_DESTINATION" 0600

  require_file "$WG0_DESTINATION"
  require_file "$FIREWALL_DESTINATION"
  grep -Fqx "$MANAGED_MARKER" "$FIREWALL_DESTINATION" ||
    die "managed firewall marker is required"
  if grep -Eiq '^[[:space:]]*flush[[:space:]]+ruleset\b' "$FIREWALL_DESTINATION"; then
    die "managed firewall must not flush the host ruleset"
  fi
  nft --check --file "$FIREWALL_DESTINATION"
  wg0_mode="$(stat -c '%a' "$WG0_DESTINATION")"
  [[ "$(stat -c '%u:%g' "$WG0_DESTINATION")" == "0:0" ]] ||
    die "wg0.conf must be root-owned"
  [[ "$wg0_mode" == "600" || "$wg0_mode" == "400" ]] ||
    die "wg0.conf must be root-readable and inaccessible to group/other"
  [[ "$(stat -c '%u:%g' "$FIREWALL_DESTINATION")" == "0:0" ]] ||
    die "managed firewall must be root-owned"
  [[ "$(stat -c '%A' "$FIREWALL_DESTINATION" | cut -c 6,9)" == "--" ]] ||
    die "managed firewall must not be group/other writable"
  apply_network_prerequisites
}

run_install_transaction() {
  local asset_installer="${1:-install_assets}"
  local mutation_status rollback_status had_errexit=false
  capture_network_prerequisite_state || die "could not capture prior network service state"
  capture_persistent_host_files || die "could not capture prior host configuration"
  [[ $- == *e* ]] && had_errexit=true
  set +e
  (
    set -Eeuo pipefail
    trap 'status=$?; trap - ERR; exit "$status"' ERR
    trap 'exit 130' INT
    trap 'exit 143' TERM
    perform_install_mutations "$asset_installer"
  )
  mutation_status=$?
  [[ "$had_errexit" == true ]] && set -e
  [[ "$mutation_status" == 0 ]] && {
    cleanup_persistent_host_snapshot || die "host install snapshot cleanup failed"
    return 0
  }

  set +e
  rollback_failed_network_activation
  rollback_status=$?
  [[ "$had_errexit" == true ]] && set -e
  case "$rollback_status" in
    0) die "network host mutation failed; prior persistent and live state restored" ;;
    1) die "network host mutation failed; rollback incomplete; verified fail-closed state established" ;;
    *) die "network host mutation failed; rollback incomplete; unable to establish fail-closed state" ;;
  esac
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --asset-dir) asset_dir="${2:-}"; shift 2 ;;
      --wg0-source) wg0_source="${2:-}"; shift 2 ;;
      --firewall-source) firewall_source="${2:-}"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  require_root
  preflight_install
  ensure_identity
  ensure_runtime_packages
  prepare_directories
  run_install_transaction install_assets
  systemctl enable network-center-worker.service
  printf 'Network Center host prerequisites installed; no release was activated.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
