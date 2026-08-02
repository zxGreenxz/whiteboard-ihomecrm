#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly MANAGED_MARKER="# ihomecrm-network-center-managed:v1"
# The VPS is shared with an unrelated production workload. Every firewall action
# this script performs is scoped to exactly this one table; the host ruleset is
# never flushed and no other table is ever read, replaced or deleted.
readonly MANAGED_FIREWALL_TABLE_FAMILY="inet"
readonly MANAGED_FIREWALL_TABLE_NAME="ihome_network_center"
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
wg0_removed_peers=""
wg0_allow_interface_change=false
mutation_in_flight=false

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

# Prints "<PublicKey><TAB><AllowedIPs>" for every peer, in file order. Anything
# ambiguous (missing key, duplicate key, unparsable line) fails closed instead of
# being silently normalised away, because the result decides which buildings keep
# their tunnel.
wg_peer_index() {
  awk '
    BEGIN { section = ""; peers = 0; interfaces = 0; failure = "" }
    function bail(message) { if (failure == "") failure = message; exit 1 }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      lowered = tolower(line)
      if (lowered == "[interface]") { interfaces++; section = "interface"; next }
      if (lowered == "[peer]") { peers++; section = "peer"; keys[peers] = ""; nets[peers] = ""; next }
      if (section == "") bail("configuration data before the first section")
      if (line !~ /^[A-Za-z][A-Za-z0-9_]*[ \t]*=/) bail("unparsable configuration line")
      if (section != "peer") next
      name = line
      sub(/[ \t]*=.*$/, "", name)
      item = line
      sub(/^[^=]*=[ \t]*/, "", item)
      if (tolower(name) == "publickey") {
        if (keys[peers] != "") bail("peer declares PublicKey twice")
        if (length(item) != 44 || item !~ /^[A-Za-z0-9+\/]+=$/) bail("peer PublicKey is not a WireGuard key")
        keys[peers] = item
      } else if (tolower(name) == "allowedips") {
        if (nets[peers] != "") bail("peer declares AllowedIPs twice")
        if (item == "") bail("peer declares an empty AllowedIPs")
        nets[peers] = item
      }
    }
    END {
      if (failure != "") { print "wg0 configuration rejected: " failure > "/dev/stderr"; exit 1 }
      if (interfaces != 1) { print "wg0 configuration rejected: exactly one [Interface] section is required" > "/dev/stderr"; exit 1 }
      if (peers < 1) { print "wg0 configuration rejected: at least one [Peer] section is required" > "/dev/stderr"; exit 1 }
      for (i = 1; i <= peers; i++) {
        if (keys[i] == "") { print "wg0 configuration rejected: peer without a PublicKey" > "/dev/stderr"; exit 1 }
        if (nets[i] == "") { print "wg0 configuration rejected: peer without AllowedIPs" > "/dev/stderr"; exit 1 }
        if (keys[i] in seen) { print "wg0 configuration rejected: duplicate peer PublicKey" > "/dev/stderr"; exit 1 }
        seen[keys[i]] = "1"
        printf "%s\t%s\n", keys[i], nets[i]
      }
    }
  ' "$1"
}

# Reads a peer index on stdin and refuses any address claimed by two peers.
assert_unique_peer_addresses() {
  awk -F'\t' '
    {
      total = split($2, list, /[ ,]+/)
      for (i = 1; i <= total; i++) {
        if (list[i] == "") continue
        if (list[i] in owner && owner[list[i]] != $1) {
          print "wg0 configuration rejected: AllowedIPs " list[i] " is claimed by two peers" > "/dev/stderr"
          exit 1
        }
        owner[list[i]] = $1
      }
    }
  '
}

wg_split_configuration() {
  awk -v dir="$2" -v marker="$MANAGED_MARKER" '
    BEGIN { peers = 0; section = "" }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == marker || line == "") next
      lowered = tolower(line)
      if (lowered == "[interface]") { section = "interface"; print "[Interface]" > (dir "/interface"); next }
      if (lowered == "[peer]") { peers++; section = "peer"; print "[Peer]" > (dir "/peer." peers); next }
      if (section == "interface") { print line > (dir "/interface"); next }
      if (section != "peer") next
      print line > (dir "/peer." peers)
      if (substr(line, 1, 1) == "#") next
      name = line
      sub(/[ \t]*=.*$/, "", name)
      if (tolower(name) != "publickey") next
      item = line
      sub(/^[^=]*=[ \t]*/, "", item)
      print item > (dir "/key." peers)
    }
    END { print peers > (dir "/peers") }
  ' "$1"
}

# Every onboarded router pins this interface's key and port. Replacing the
# [Interface] block therefore breaks every building at once, exactly like dropping
# their peers would, so it needs the same explicit opt-in.
wg_interface_fingerprint() {
  awk '
    BEGIN { section = "" }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      lowered = tolower(line)
      if (lowered == "[interface]") { section = "interface"; next }
      if (lowered == "[peer]") { section = "peer"; next }
      if (section != "interface") next
      name = line
      sub(/[ \t]*=.*$/, "", name)
      item = line
      sub(/^[^=]*=[ \t]*/, "", item)
      printf "%s=%s\n", tolower(name), item
    }
  ' "$1" | LC_ALL=C sort
}

wg0_interface_change_allowed() {
  local incoming="$1" destination="$2"
  if [[ "$wg0_allow_interface_change" == true ]]; then return 0; fi
  if [[ ! -f "$destination" || -L "$destination" ]]; then return 0; fi
  [[ "$(wg_interface_fingerprint "$incoming")" == "$(wg_interface_fingerprint "$destination")" ]]
}

wg0_peer_removal_requested() {
  [[ -n "$wg0_removed_peers" ]] || return 1
  printf '%s\n' "$wg0_removed_peers" | grep -Fqx -- "$1"
}

add_wg0_peer_removal() {
  local key="${1:-}"
  [[ "$key" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
    die "--remove-peer requires a WireGuard public key"
  if wg0_peer_removal_requested "$key"; then
    die "--remove-peer repeated for the same peer"
  fi
  wg0_removed_peers="${wg0_removed_peers:+$wg0_removed_peers
}$key"
}

# Mutation-free preflight for the peer merge. Onboarding is additive: a peer the
# incoming file omits is kept and reported, never dropped. The only way a peer
# leaves wg0 is an operator naming its exact public key with --remove-peer.
assert_wg0_merge_is_safe() {
  local incoming="$1" destination="$2"
  local incoming_index destination_index="" removal key entry
  incoming_index="$(wg_peer_index "$incoming")" ||
    die "wg0 source is not a usable WireGuard configuration: $incoming"
  wg0_interface_change_allowed "$incoming" "$destination" ||
    die "wg0 source would replace the live [Interface] every onboarded router pins; pass --allow-interface-change to accept that"
  if [[ -f "$destination" && ! -L "$destination" ]]; then
    destination_index="$(wg_peer_index "$destination")" ||
      die "existing wg0 destination is not a usable WireGuard configuration: $destination"
  fi
  while IFS= read -r removal; do
    if [[ -z "$removal" ]]; then continue; fi
    if ! printf '%s\n' "$destination_index" | awk -F'\t' '{ print $1 }' | grep -Fqx -- "$removal"; then
      die "--remove-peer names a peer that $destination does not carry"
    fi
    if printf '%s\n' "$incoming_index" | awk -F'\t' '{ print $1 }' | grep -Fqx -- "$removal"; then
      die "--remove-peer names a peer the incoming wg0 source still defines"
    fi
  done <<< "$wg0_removed_peers"
  while IFS= read -r key; do
    if [[ -z "$key" ]]; then continue; fi
    if wg0_peer_removal_requested "$key"; then continue; fi
    if printf '%s\n' "$incoming_index" | awk -F'\t' '{ print $1 }' | grep -Fqx -- "$key"; then continue; fi
    printf 'network-center install: retaining existing wg0 peer %s\n' "$key"
  done < <(printf '%s\n' "$destination_index" | awk -F'\t' '{ print $1 }')
  {
    while IFS=$'\t' read -r key entry; do
      if [[ -z "$key" ]]; then continue; fi
      if wg0_peer_removal_requested "$key"; then continue; fi
      printf '%s\t%s\n' "$key" "$entry"
    done < <(printf '%s\n' "$destination_index")
    printf '%s\n' "$incoming_index"
  } | assert_unique_peer_addresses ||
    die "refusing a wg0 merge in which two peers claim the same address"
}

merge_wg0_configuration() {
  local output="$3" work status=0
  work="$(mktemp -d "$(dirname "$output")/.wg0-merge.XXXXXX")" || return 1
  merge_wg0_configuration_into "$1" "$2" "$output" "$work" || status=1
  rm -rf -- "$work"
  return "$status"
}

merge_wg0_configuration_into() {
  local incoming="$1" destination="$2" output="$3" work="$4"
  local count_new count_old=0 index candidate key match
  mkdir -p "$work/new" "$work/old" || return 1
  wg_peer_index "$incoming" >/dev/null || return 1
  wg0_interface_change_allowed "$incoming" "$destination" || return 1
  wg_split_configuration "$incoming" "$work/new" || return 1
  count_new="$(cat "$work/new/peers")" || return 1
  if [[ -f "$destination" && ! -L "$destination" ]]; then
    wg_peer_index "$destination" >/dev/null || return 1
    wg_split_configuration "$destination" "$work/old" || return 1
    count_old="$(cat "$work/old/peers")" || return 1
  fi
  : > "$work/used" || return 1
  {
    printf '%s\n' "$MANAGED_MARKER"
    cat "$work/new/interface"
    for ((index = 1; index <= count_old; index++)); do
      key="$(cat "$work/old/key.$index")"
      if wg0_peer_removal_requested "$key"; then continue; fi
      match=""
      for ((candidate = 1; candidate <= count_new; candidate++)); do
        if [[ "$(cat "$work/new/key.$candidate")" == "$key" ]]; then
          match="$candidate"
          break
        fi
      done
      printf '\n'
      if [[ -n "$match" ]]; then
        printf '%s\n' "$match" >> "$work/used"
        cat "$work/new/peer.$match"
      else
        cat "$work/old/peer.$index"
      fi
    done
    for ((candidate = 1; candidate <= count_new; candidate++)); do
      if grep -Fqx -- "$candidate" "$work/used"; then continue; fi
      printf '\n'
      cat "$work/new/peer.$candidate"
    done
  } > "$output" || return 1
  wg_peer_index "$output" >/dev/null || return 1
  wg_peer_index "$output" | assert_unique_peer_addresses || return 1
}

# The fragment must define the managed table and nothing else: no `flush ruleset`,
# no include, no statement that touches a table belonging to the co-tenant.
assert_scoped_firewall_fragment() {
  awk -v family="$MANAGED_FIREWALL_TABLE_FAMILY" -v name="$MANAGED_FIREWALL_TABLE_NAME" '
    BEGIN { depth = 0; tables = 0; failure = "" }
    function bail(message) { if (failure == "") failure = message; exit 1 }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/#.*$/, "", line)
      gsub(/\t/, " ", line)
      while (sub(/  /, " ", line)) { }
      sub(/^ +/, "", line)
      sub(/ +$/, "", line)
      if (depth == 0 && line != "") {
        header = line
        sub(/\{$/, "", header)
        sub(/ +$/, "", header)
        split(header, parts, " ")
        if (parts[1] != "table" || parts[2] != family || parts[3] != name || parts[4] != "") {
          bail("statement outside the managed table: " line)
        }
        tables++
      }
      total = length(line)
      for (i = 1; i <= total; i++) {
        character = substr(line, i, 1)
        if (character == "{") depth++
        else if (character == "}") { depth--; if (depth < 0) bail("unbalanced braces") }
      }
    }
    END {
      if (failure != "") { print "managed firewall fragment rejected: " failure > "/dev/stderr"; exit 1 }
      if (depth != 0) { print "managed firewall fragment rejected: unbalanced braces" > "/dev/stderr"; exit 1 }
      if (tables < 1) { print "managed firewall fragment rejected: it must define table " family " " name > "/dev/stderr"; exit 1 }
    }
  ' "$1" || die "managed firewall fragment must define only table $MANAGED_FIREWALL_TABLE_FAMILY $MANAGED_FIREWALL_TABLE_NAME"
}

# `nft --file` on a bare table block ADDS, so a second install would stack another
# copy of every rule. Prefixing an add+delete of the managed table makes the apply
# an atomic, idempotent replace of that one table and of nothing else.
render_managed_firewall_fragment() {
  local source="$1" output="$2"
  {
    printf '%s\n' "$MANAGED_MARKER"
    printf '# scoped atomic replace: only the managed table is removed, never the host ruleset\n'
    printf 'table %s %s\n' "$MANAGED_FIREWALL_TABLE_FAMILY" "$MANAGED_FIREWALL_TABLE_NAME"
    printf 'delete table %s %s\n' "$MANAGED_FIREWALL_TABLE_FAMILY" "$MANAGED_FIREWALL_TABLE_NAME"
    awk -v marker="$MANAGED_MARKER" '
      { line = $0; sub(/\r$/, "", line); if (line != marker) print line }
    ' "$source"
  } > "$output"
}

managed_firewall_table_present() {
  nft list table "$MANAGED_FIREWALL_TABLE_FAMILY" "$MANAGED_FIREWALL_TABLE_NAME" >/dev/null 2>&1
}

remove_managed_firewall_table() {
  managed_firewall_table_present || return 0
  nft delete table "$MANAGED_FIREWALL_TABLE_FAMILY" "$MANAGED_FIREWALL_TABLE_NAME" >/dev/null 2>&1 || return 1
  ! managed_firewall_table_present
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
  assert_scoped_firewall_fragment "$firewall_source"
  assert_wg0_merge_is_safe "$wg0_source" "$WG0_DESTINATION"
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
  if [[ "$prior_firewall_active" != true ]]; then
    remove_managed_firewall_table || failed=1
    if managed_firewall_table_present; then failed=1; fi
  fi
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
  # Stopping the unit does not necessarily unload the table: by this point the
  # unit fragment may already have been restored away, so systemd has no ExecStop
  # left to run. If this run is what injected the table, unload it here — scoped
  # to the managed table only, so the co-tenant's rules are never touched.
  if [[ "$prior_firewall_active" != true ]]; then
    remove_managed_firewall_table || failed=1
  fi

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
  if [[ "$prior_firewall_active" != true ]] && managed_firewall_table_present; then
    failed=1
  fi
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
  managed_firewall_table_present || return 1
  sysctl --system >/dev/null || return 1
  [[ "$(sysctl -n net.ipv4.ip_forward)" == 1 ]] || return 1
  systemctl enable --now wg-quick@wg0.service || return 1
  systemctl is-active --quiet wg-quick@wg0.service || return 1
  wg show wg0 >/dev/null 2>&1 || return 1
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
  local asset_installer="$1" wg0_mode wg0_merged firewall_rendered
  local prior_peers="" installed_peers="" key
  "$asset_installer"

  if [[ -f "$WG0_DESTINATION" && ! -L "$WG0_DESTINATION" ]]; then
    prior_peers="$(wg_peer_index "$WG0_DESTINATION" | awk -F'\t' '{ print $1 }')" ||
      die "existing wg0 destination is not a usable WireGuard configuration"
  fi

  install -d -o root -g root -m 0700 "$WG0_DIR"
  wg0_merged="$(mktemp "$NETWORK_CENTER_ROOT/state/.wg0-merged.XXXXXX")"
  merge_wg0_configuration "$wg0_source" "$WG0_DESTINATION" "$wg0_merged" ||
    die "refusing to install wg0.conf: the peer merge failed"
  install_managed_file "$wg0_merged" "$WG0_DESTINATION" 0600
  rm -f -- "$wg0_merged"

  install -d -o root -g root -m 0755 "$FIREWALL_DIR"
  assert_scoped_firewall_fragment "$firewall_source"
  firewall_rendered="$(mktemp "$NETWORK_CENTER_ROOT/state/.firewall-fragment.XXXXXX")"
  render_managed_firewall_fragment "$firewall_source" "$firewall_rendered" ||
    die "could not render the scoped managed firewall fragment"
  install_managed_file "$firewall_rendered" "$FIREWALL_DESTINATION" 0600
  rm -f -- "$firewall_rendered"

  require_file "$WG0_DESTINATION"
  require_file "$FIREWALL_DESTINATION"
  installed_peers="$(wg_peer_index "$WG0_DESTINATION" | awk -F'\t' '{ print $1 }')" ||
    die "the installed wg0.conf is not a usable WireGuard configuration"
  while IFS= read -r key; do
    if [[ -z "$key" ]]; then continue; fi
    if wg0_peer_removal_requested "$key"; then continue; fi
    printf '%s\n' "$installed_peers" | grep -Fqx -- "$key" ||
      die "refusing an install that would drop wg0 peer $key without --remove-peer"
  done <<< "$prior_peers"
  grep -Fqx "$MANAGED_MARKER" "$FIREWALL_DESTINATION" ||
    die "managed firewall marker is required"
  if grep -Eiq '^[[:space:]]*flush[[:space:]]+ruleset\b' "$FIREWALL_DESTINATION"; then
    die "managed firewall must not flush the host ruleset"
  fi
  grep -Fqx "delete table $MANAGED_FIREWALL_TABLE_FAMILY $MANAGED_FIREWALL_TABLE_NAME" \
    "$FIREWALL_DESTINATION" ||
    die "managed firewall must scope its atomic replace to the managed table"
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

report_rollback_outcome() {
  local rollback_status="$1" reason="$2"
  case "$rollback_status" in
    0) die "$reason; prior persistent and live state restored" ;;
    1) die "$reason; rollback incomplete; verified fail-closed state established" ;;
    *) die "$reason; rollback incomplete; unable to establish fail-closed state" ;;
  esac
}

# The README documents running this over SSH. Non-interactive bash with no HUP
# trap dies the instant the session drops, so without these the window between the
# sysctl/firewall mutation and the readback would leave the host half-configured
# with no rollback at all.
handle_install_signal() {
  local signal="$1" rollback_status=0
  trap - HUP INT TERM EXIT
  if [[ "$mutation_in_flight" != true ]]; then
    die "interrupted by SIG$signal before any host network mutation"
  fi
  mutation_in_flight=false
  set +e
  rollback_failed_network_activation
  rollback_status=$?
  report_rollback_outcome "$rollback_status" "interrupted by SIG$signal during host network mutation"
}

handle_install_exit() {
  local status=$? rollback_status=0
  trap - HUP INT TERM EXIT
  if [[ "$mutation_in_flight" != true ]]; then
    return "$status"
  fi
  mutation_in_flight=false
  set +e
  rollback_failed_network_activation
  rollback_status=$?
  report_rollback_outcome "$rollback_status" "exited during host network mutation"
}

install_signal_handlers() {
  trap 'handle_install_signal HUP' HUP
  trap 'handle_install_signal INT' INT
  trap 'handle_install_signal TERM' TERM
  trap 'handle_install_exit' EXIT
}

run_install_transaction() {
  local asset_installer="${1:-install_assets}"
  local mutation_status rollback_status had_errexit=false
  capture_network_prerequisite_state || die "could not capture prior network service state"
  capture_persistent_host_files || die "could not capture prior host configuration"
  [[ $- == *e* ]] && had_errexit=true
  set +e
  mutation_in_flight=true
  (
    set -Eeuo pipefail
    trap 'status=$?; trap - ERR; exit "$status"' ERR
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    perform_install_mutations "$asset_installer"
  )
  mutation_status=$?
  [[ "$had_errexit" == true ]] && set -e
  if [[ "$mutation_status" == 0 ]]; then
    mutation_in_flight=false
    cleanup_persistent_host_snapshot || die "host install snapshot cleanup failed"
    return 0
  fi

  set +e
  rollback_failed_network_activation
  rollback_status=$?
  mutation_in_flight=false
  [[ "$had_errexit" == true ]] && set -e
  report_rollback_outcome "$rollback_status" "network host mutation failed"
}

main() {
  install_signal_handlers
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --asset-dir) asset_dir="${2:-}"; shift 2 ;;
      --wg0-source) wg0_source="${2:-}"; shift 2 ;;
      --firewall-source) firewall_source="${2:-}"; shift 2 ;;
      --remove-peer) add_wg0_peer_removal "${2:-}"; shift 2 ;;
      --allow-interface-change) wg0_allow_interface_change=true; shift ;;
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
