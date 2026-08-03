#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly NETWORK_CENTER_ROOT="${NETWORK_CENTER_ROOT:-/opt/ihome-network-center}"
readonly RELEASES_DIR="$NETWORK_CENTER_ROOT/releases"
readonly INCOMING_DIR="$NETWORK_CENTER_ROOT/incoming"
readonly STATE_DIR="$NETWORK_CENTER_ROOT/state"
readonly CONFIG_DIR="$NETWORK_CENTER_ROOT/config"
readonly SECRET_DIR="$NETWORK_CENTER_ROOT/secrets"
readonly SECRET_GENERATIONS_DIR="$NETWORK_CENTER_ROOT/secret-generations"
readonly RUNTIME_SECRET_GENERATIONS_DIR="${NETWORK_CENTER_RUNTIME_ROOT:-/run/ihome-network-center}/secret-generations"
readonly BACKUP_DIR="$NETWORK_CENTER_ROOT/backups/router"
readonly CURRENT_POINTER="$STATE_DIR/current.release"
readonly PREVIOUS_POINTER="$STATE_DIR/previous.release"
readonly PENDING_POINTER="$STATE_DIR/pending.release"
readonly TRANSITION_FILE="$STATE_DIR/transition.json"
readonly LAST_TRANSITION_FILE="$STATE_DIR/last-transition.json"
# Runtime (non-pointer) mutations - today only the emergency-stop switch - stop
# and restart the live worker without touching any pointer, so the transition
# journal has nothing to say about them. This records the requested runtime state
# durably before the container is stopped, so a dropped ssh session cannot leave
# the worker stopped with nothing on disk asking for it back.
readonly RUNTIME_INTENT_FILE="$STATE_DIR/runtime-intent.json"
readonly WORKER_UID=10001
readonly WORKER_GID=10001
readonly EXPECTED_NODE_OPTIONS="--max-old-space-size=320"
readonly MINIMUM_FREE_BYTES=$((20 * 1024 * 1024 * 1024))
readonly STAGE_HEADROOM_BYTES=$((4 * 1024 * 1024 * 1024))

activation_mutation_in_flight=false
# The staging directory this invocation owns, so the residue sweep below never
# deletes a tree the caller is still filling. main() holds an exclusive flock for
# the whole command, so no other invocation can own one at the same time.
staging_temporary=""

die() {
  printf 'network-center activation: %s\n' "$1" >&2
  exit 1
}

failpoint() {
  [[ "${NETWORK_CENTER_FAILPOINT:-}" != "$1" ]] || die "injected failure: $1"
}

validate_sha() {
  [[ "${1:-}" =~ ^[a-f0-9]{40}$ ]] || die "release SHA must be 40 lowercase hex characters"
}

# mktemp + `mv -fT` is atomic but not durable. state/transition.json does not
# exist before begin_transition, so ext4's auto_da_alloc replace-via-rename
# heuristic (which only covers renaming onto an existing file) never applies: a
# hard reset can journal the rename while the data blocks are still delayed
# allocated and return a zero-length journal - exactly in the window the journal
# exists to survive. Both the file and its directory entry are flushed here.
sync_path() {
  sync -- "$1" || die "durable write could not be flushed: $1"
}

# A directory needs more care than a file: fsyncing a directory flushes its own
# entries and nothing inside it, so a secret generation renamed the way a pointer
# is can come back with every name present and every file empty. That is worse
# than losing the rename outright - the manifest stops matching, so
# verify_persistent_secret_generation fails and validate_pointer then refuses
# current.release at every boot. Flush the contents, then the directory, then the
# parent entry the rename lands in.
durable_replace() {
  local temporary="$1" destination="$2" path
  if [[ -d "$temporary" && ! -L "$temporary" ]]; then
    while IFS= read -r -d '' path; do
      sync_path "$path"
    done < <(find "$temporary" -mindepth 1 -depth -print0)
  fi
  sync_path "$temporary"
  mv -fT "$temporary" "$destination"
  sync_path "$(dirname "$destination")"
}

durable_remove() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  rm -f -- "$target"
  sync_path "$(dirname "$target")"
}

# A corrupt state file must not become a permanent stop: boot runs start-current,
# which recovers first, so dying here wedges every command including boot. The
# bytes are kept for inspection and the loss is reported loudly instead.
quarantine_state_file() {
  local path="$1" label="$2" destination
  destination="$STATE_DIR/$label.corrupt.$(date -u +%Y%m%dT%H%M%SZ).$$"
  mv -fT "$path" "$destination" || rm -f -- "$path"
  sync_path "$STATE_DIR"
  printf 'network-center activation: %s was unreadable and is quarantined at %s\n' "$label" "$destination" >&2
}

validate_digest() {
  [[ "${1:-}" =~ ^[a-f0-9]{64}$ ]] || die "SHA-256 digest must be 64 lowercase hex characters"
}

ensure_disk_reserve() {
  local required_bytes="$1" available_bytes
  available_bytes="$(df --output=avail -B1 "$NETWORK_CENTER_ROOT" | tail -n 1 | tr -d '[:space:]')"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] || die "could not read host free-space reserve"
  (( available_bytes >= required_bytes )) ||
    die "minimum host free-space reserve is unavailable"
}

pointer_value() {
  jq -er "$2" "$1"
}

canonical_secret_manifest() {
  local directory="$1" path name digest
  [[ -d "$directory" && ! -L "$directory" ]] || die "secret generation directory is unavailable"
  while IFS= read -r -d '' path; do
    name="$(basename "$path")"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "secret file name is invalid"
    digest="$(sha256sum "$path" | awk '{print $1}')"
    validate_digest "$digest"
    printf '%s  %s\n' "$digest" "$name"
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
}

validate_source_secrets() {
  [[ -d "$SECRET_DIR" && ! -L "$SECRET_DIR" ]] || die "root secret directory is unavailable"
  [[ "$(stat -c '%u:%g:%a' "$SECRET_DIR")" == "0:0:700" ]] ||
    die "root secret directory must be root:root 0700"
  [[ -z "$(find "$SECRET_DIR" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]] ||
    die "only regular secret files are permitted"
  local secret
  while IFS= read -r -d '' secret; do
    [[ "$(stat -c '%u:%g:%a' "$secret")" == "0:0:600" ]] ||
      die "at-rest secret must be root:root 0600: $secret"
  done < <(find "$SECRET_DIR" -mindepth 1 -maxdepth 1 -type f -print0)
  [[ -f "$SECRET_DIR/worker-secret" ]] || die "worker-secret is missing"
  [[ -f "$SECRET_DIR/router-credentials.json" ]] || die "router-credentials.json is missing"
}

verify_persistent_secret_generation() {
  local generation="$1" directory manifest actual
  validate_digest "$generation"
  directory="$SECRET_GENERATIONS_DIR/$generation"
  [[ -d "$directory" && ! -L "$directory" ]] || die "persistent secret generation is unavailable"
  [[ "$(stat -c '%u:%g:%a' "$directory")" == "0:0:700" ]] ||
    die "persistent secret generation must be root:root 0700"
  [[ -f "$directory/manifest.sha256" && ! -L "$directory/manifest.sha256" ]] ||
    die "persistent secret generation manifest is unavailable"
  [[ -z "$(find "$directory" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]] ||
    die "persistent secret generation contains a non-file entry"
  local secret
  while IFS= read -r -d '' secret; do
    [[ "$(stat -c '%u:%g:%a' "$secret")" == "0:0:600" ]] ||
      die "persistent secret generation files must be root:root 0600"
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -print0)
  manifest="$(sed '/  manifest\.sha256$/d' "$directory/manifest.sha256")"
  actual="$(canonical_secret_manifest "$directory" | sed '/  manifest\.sha256$/d')"
  [[ "$manifest" == "$actual" ]] || die "persistent secret generation manifest mismatch"
  [[ "$(printf '%s\n' "$manifest" | sha256sum | awk '{print $1}')" == "$generation" ]] ||
    die "persistent secret generation identity mismatch"
  [[ -f "$directory/worker-secret" && -f "$directory/router-credentials.json" ]] ||
    die "persistent secret generation is incomplete"
}

snapshot_secret_generation() {
  validate_source_secrets
  install -d -o root -g root -m 0700 "$SECRET_GENERATIONS_DIR"
  local before temporary after generation destination secret
  before="$(canonical_secret_manifest "$SECRET_DIR")"
  [[ -n "$before" ]] || die "secret source is empty"
  temporary="$(mktemp -d "$SECRET_GENERATIONS_DIR/.generation.XXXXXX")"
  chmod 0700 "$temporary"
  while IFS= read -r -d '' secret; do
    install -o root -g root -m 0600 "$secret" "$temporary/$(basename "$secret")"
  done < <(find "$SECRET_DIR" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
  after="$(canonical_secret_manifest "$temporary")"
  [[ "$before" == "$after" ]] || die "secret source changed while snapshotting"
  [[ "$before" == "$(canonical_secret_manifest "$SECRET_DIR")" ]] ||
    die "secret source changed during snapshot verification"
  generation="$(printf '%s\n' "$after" | sha256sum | awk '{print $1}')"
  validate_digest "$generation"
  printf '%s\n' "$after" > "$temporary/manifest.sha256"
  chmod 0600 "$temporary/manifest.sha256"
  destination="$SECRET_GENERATIONS_DIR/$generation"
  if [[ -e "$destination" ]]; then
    rm -rf -- "$temporary"
    verify_persistent_secret_generation "$generation"
  else
    durable_replace "$temporary" "$destination"
    verify_persistent_secret_generation "$generation"
  fi
  printf '%s\n' "$generation"
}

materialize_runtime_secret_generation() {
  local generation="$1" source destination temporary secret expected actual
  verify_persistent_secret_generation "$generation"
  source="$SECRET_GENERATIONS_DIR/$generation"
  destination="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
  install -d -o root -g "$WORKER_GID" -m 0750 "$RUNTIME_SECRET_GENERATIONS_DIR"
  if [[ -d "$destination" && ! -L "$destination" ]]; then
    verify_runtime_secret_generation "$generation"
    printf '%s\n' "$destination"
    return
  fi
  [[ ! -e "$destination" ]] || die "runtime secret generation path is unsafe"
  temporary="$(mktemp -d "$RUNTIME_SECRET_GENERATIONS_DIR/.generation.XXXXXX")"
  chown root:"$WORKER_GID" "$temporary"
  chmod 0750 "$temporary"
  while IFS= read -r -d '' secret; do
    [[ "$(basename "$secret")" != "manifest.sha256" ]] || continue
    install -o "$WORKER_UID" -g "$WORKER_GID" -m 0400 \
      "$secret" "$temporary/$(basename "$secret")"
  done < <(find "$source" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
  expected="$(sed '/  manifest\.sha256$/d' "$source/manifest.sha256")"
  actual="$(canonical_secret_manifest "$temporary")"
  [[ "$expected" == "$actual" ]] || die "runtime secret generation copy mismatch"
  durable_replace "$temporary" "$destination"
  verify_runtime_secret_generation "$generation"
  printf '%s\n' "$destination"
}

verify_runtime_secret_generation() {
  local generation="$1" source destination expected actual secret
  validate_digest "$generation"
  verify_persistent_secret_generation "$generation"
  source="$SECRET_GENERATIONS_DIR/$generation"
  destination="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
  [[ -d "$destination" && ! -L "$destination" ]] || die "runtime secret generation is unavailable"
  [[ "$(stat -c '%u:%g:%a' "$destination")" == "0:$WORKER_GID:750" ]] ||
    die "runtime secret generation must be root:worker 0750"
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]] ||
    die "runtime secret generation contains a non-file entry"
  while IFS= read -r -d '' secret; do
    [[ "$(stat -c '%u:%g:%a' "$secret")" == "$WORKER_UID:$WORKER_GID:400" ]] ||
      die "runtime secret generation files must be worker-owned 0400"
  done < <(find "$destination" -mindepth 1 -maxdepth 1 -type f -print0)
  expected="$(sed '/  manifest\.sha256$/d' "$source/manifest.sha256")"
  actual="$(canonical_secret_manifest "$destination")"
  [[ "$expected" == "$actual" ]] || die "runtime secret generation content mismatch"
  [[ -f "$destination/worker-secret" && -f "$destination/router-credentials.json" ]] ||
    die "runtime secret generation is incomplete"
}

validate_pointer() {
  local pointer="$1"
  [[ -f "$pointer" && ! -L "$pointer" ]] || die "release pointer missing: $pointer"
  [[ "$(stat -c '%u:%g:%a' "$pointer")" == "0:0:600" ]] || die "release pointer must be root:root 0600"
  jq -e '
    type == "object" and
    ((keys | sort) == ["archiveSha256","containerName","envFile","imageId","imageTag","projectName","releaseDirectory","releaseSha","schemaVersion","secretGeneration"]) and
    .schemaVersion == 2 and
    (.releaseSha | type == "string" and test("^[a-f0-9]{40}$")) and
    (.imageTag | type == "string" and test("^ihome-network-center-worker:[a-f0-9]{40}$")) and
    (.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
    (.archiveSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.secretGeneration | type == "string" and test("^[a-f0-9]{64}$")) and
    (.releaseDirectory | type == "string" and length <= 512) and
    (.envFile | type == "string" and length <= 512) and
    (.projectName | type == "string" and length <= 81) and
    (.containerName | type == "string" and length <= 101)
  ' "$pointer" >/dev/null || die "release pointer schema is invalid"
  local schema release_sha image_tag image_id generation release_dir env_file project container
  schema="$(jq -er '.schemaVersion' "$pointer")"
  release_sha="$(jq -er '.releaseSha' "$pointer")"
  image_tag="$(jq -er '.imageTag' "$pointer")"
  image_id="$(jq -er '.imageId' "$pointer")"
  generation="$(jq -er '.secretGeneration' "$pointer")"
  release_dir="$(jq -er '.releaseDirectory' "$pointer")"
  env_file="$(jq -er '.envFile' "$pointer")"
  project="$(jq -er '.projectName' "$pointer")"
  container="$(jq -er '.containerName' "$pointer")"
  [[ "$schema" == "2" ]] || die "pointer schema version is unsupported"
  validate_sha "$release_sha"
  [[ "$image_tag" == "ihome-network-center-worker:$release_sha" ]] || die "pointer image tag mismatch"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || die "pointer image ID is invalid"
  validate_digest "$generation"
  [[ "$release_dir" == "$RELEASES_DIR/$release_sha" ]] || die "pointer release path mismatch"
  [[ "$env_file" == "$release_dir"/* ]] || die "pointer environment path mismatch"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]{2,80}$ ]] || die "pointer project name is invalid"
  [[ "$container" =~ ^[a-z0-9][a-z0-9_.-]{2,100}$ ]] || die "pointer container name is invalid"
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || die "release directory is unavailable"
  [[ -f "$env_file" && ! -L "$env_file" ]] || die "release environment is unavailable"
  verify_persistent_secret_generation "$generation"
  docker image inspect "$image_id" >/dev/null 2>&1 || die "exact local image is unavailable"
  [[ "$(docker image inspect "$image_id" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" == "$release_sha" ]] ||
    die "image revision label mismatch"
}

write_pointer() {
  local destination="$1" release_sha="$2" image_tag="$3" image_id="$4"
  local archive_sha="$5" generation="$6" release_dir="$7" env_file="$8" project="$9"
  shift 9
  local container="$1" temporary
  temporary="$(mktemp "$STATE_DIR/.pointer.XXXXXX")"
  jq -n --arg releaseSha "$release_sha" --arg imageTag "$image_tag" \
    --arg imageId "$image_id" --arg archiveSha256 "$archive_sha" \
    --arg secretGeneration "$generation" --arg releaseDirectory "$release_dir" \
    --arg envFile "$env_file" --arg projectName "$project" --arg containerName "$container" \
    '{schemaVersion:2, releaseSha:$releaseSha, imageTag:$imageTag, imageId:$imageId,
      archiveSha256:$archiveSha256, secretGeneration:$secretGeneration,
      releaseDirectory:$releaseDirectory, envFile:$envFile,
      projectName:$projectName, containerName:$containerName}' > "$temporary"
  chmod 0600 "$temporary"
  durable_replace "$temporary" "$destination"
}

write_pointer_json() {
  local destination="$1" value="$2" temporary
  if [[ "$value" == "null" ]]; then
    durable_remove "$destination"
    return
  fi
  temporary="$(mktemp "$STATE_DIR/.pointer-json.XXXXXX")"
  printf '%s\n' "$value" | jq -e 'select(.schemaVersion == 2)' > "$temporary"
  chmod 0600 "$temporary"
  durable_replace "$temporary" "$destination"
  validate_pointer "$destination"
}

pointer_json_or_null() {
  [[ -f "$1" && ! -L "$1" ]] && jq -c . "$1" || printf 'null\n'
}

pointer_set_json() {
  jq -cn --argjson current "$(pointer_json_or_null "$CURRENT_POINTER")" \
    --argjson previous "$(pointer_json_or_null "$PREVIOUS_POINTER")" \
    --argjson pending "$(pointer_json_or_null "$PENDING_POINTER")" \
    '{current:$current,previous:$previous,pending:$pending}'
}

write_transition() {
  local operation="$1" phase="$2" before="$3" after="$4" target="$5" temporary
  temporary="$(mktemp "$STATE_DIR/.transition.XXXXXX")"
  jq -n --arg operation "$operation" --arg phase "$phase" --argjson before "$before" \
    --argjson after "$after" --argjson target "$target" \
    '{schemaVersion:1,operation:$operation,phase:$phase,before:$before,after:$after,target:$target}' \
    > "$temporary"
  chmod 0600 "$temporary"
  durable_replace "$temporary" "$TRANSITION_FILE"
}

validate_transition_journal() {
  local journal="$1" maximum_bytes=65536
  [[ -f "$journal" && ! -L "$journal" ]] || die "transition journal is unavailable"
  [[ "$(stat -c '%s' "$journal")" =~ ^[0-9]+$ && "$(stat -c '%s' "$journal")" -le "$maximum_bytes" ]] ||
    die "transition journal exceeds its byte bound"
  jq -e '
    def pointer:
      type == "object" and
      ((keys | sort) == ["archiveSha256","containerName","envFile","imageId","imageTag","projectName","releaseDirectory","releaseSha","schemaVersion","secretGeneration"]) and
      .schemaVersion == 2 and
      (.releaseSha | type == "string" and test("^[a-f0-9]{40}$")) and
      (.imageTag | type == "string" and test("^ihome-network-center-worker:[a-f0-9]{40}$")) and
      (.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
      (.archiveSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.secretGeneration | type == "string" and test("^[a-f0-9]{64}$")) and
      (.releaseDirectory | type == "string" and length <= 512) and
      (.envFile | type == "string" and length <= 512) and
      (.projectName | type == "string" and length <= 81) and
      (.containerName | type == "string" and length <= 101);
    def pointer_set:
      type == "object" and ((keys | sort) == ["current","pending","previous"]) and
      (.current == null or (.current | pointer)) and
      (.previous == null or (.previous | pointer)) and
      (.pending == null or (.pending | pointer));
    type == "object" and
    ((keys | sort) == ["after","before","operation","phase","schemaVersion","target"]) and
    .schemaVersion == 1 and
    (.operation == "promote" or .operation == "rollback") and
    (.phase == "prepared" or .phase == "commit-intent" or .phase == "committed" or .phase == "compensated" or .phase == "finalized") and
    (.before | pointer_set) and (.after | pointer_set) and (.target | pointer)
  ' "$journal" >/dev/null || die "transition journal schema is invalid"
}

write_last_transition() {
  local operation="$1" phase="$2" before="$3" after="$4" target="$5" temporary
  [[ ! -e "$LAST_TRANSITION_FILE" ]] || die "a prior transition requires explicit finalization"
  temporary="$(mktemp "$STATE_DIR/.last-transition.XXXXXX")"
  jq -n --arg operation "$operation" --arg phase "$phase" --argjson before "$before" \
    --argjson after "$after" --argjson target "$target" \
    '{schemaVersion:1,operation:$operation,phase:$phase,before:$before,after:$after,target:$target}' \
    > "$temporary"
  chmod 0600 "$temporary"
  validate_transition_journal "$temporary"
  durable_replace "$temporary" "$LAST_TRANSITION_FILE"
}

begin_transition() {
  [[ ! -e "$TRANSITION_FILE" ]] || die "a deployment transition already requires reconciliation"
  if [[ -e "$LAST_TRANSITION_FILE" ]]; then
    validate_transition_journal "$LAST_TRANSITION_FILE"
    [[ "$(jq -er '.phase' "$LAST_TRANSITION_FILE")" == finalized ]] ||
      die "the prior deployment transition requires explicit finalization"
    durable_remove "$LAST_TRANSITION_FILE"
  fi
  write_transition "$1" prepared "$2" "$3" "$4"
  failpoint after-transition-prepared
}

mark_transition_commit_intent() {
  local temporary
  [[ "$(jq -er '.phase' "$TRANSITION_FILE")" == "prepared" ]] || die "transition is not prepared"
  temporary="$(mktemp "$STATE_DIR/.transition.XXXXXX")"
  jq '.phase = "commit-intent"' "$TRANSITION_FILE" > "$temporary"
  chmod 0600 "$temporary"
  durable_replace "$temporary" "$TRANSITION_FILE"
  failpoint after-transition-commit-intent
}

apply_pointer_set() {
  local set="$1"
  write_pointer_json "$PREVIOUS_POINTER" "$(printf '%s' "$set" | jq -c '.previous')"
  failpoint after-previous-pointer
  write_pointer_json "$CURRENT_POINTER" "$(printf '%s' "$set" | jq -c '.current')"
  failpoint after-current-pointer
  write_pointer_json "$PENDING_POINTER" "$(printf '%s' "$set" | jq -c '.pending')"
  failpoint after-pending-pointer
}

apply_transition_after() {
  apply_pointer_set "$(jq -c '.after' "$TRANSITION_FILE")"
}

commit_transition() {
  validate_transition_journal "$TRANSITION_FILE"
  [[ "$(jq -er '.phase' "$TRANSITION_FILE")" == "commit-intent" ]] || die "transition is not ready to commit"
  if [[ -e "$LAST_TRANSITION_FILE" ]]; then
    validate_transition_journal "$LAST_TRANSITION_FILE"
    [[ "$(jq -er '.phase' "$LAST_TRANSITION_FILE")" == committed &&
       "$(jq -er '.operation' "$LAST_TRANSITION_FILE")" == "$(jq -er '.operation' "$TRANSITION_FILE")" &&
       "$(jq -c '.before' "$LAST_TRANSITION_FILE")" == "$(jq -c '.before' "$TRANSITION_FILE")" &&
       "$(jq -c '.after' "$LAST_TRANSITION_FILE")" == "$(jq -c '.after' "$TRANSITION_FILE")" &&
       "$(jq -c '.target' "$LAST_TRANSITION_FILE")" == "$(jq -c '.target' "$TRANSITION_FILE")" ]] ||
      die "durable transition commit is mixed"
  else
    write_last_transition "$(jq -er '.operation' "$TRANSITION_FILE")" committed \
      "$(jq -c '.before' "$TRANSITION_FILE")" "$(jq -c '.after' "$TRANSITION_FILE")" \
      "$(jq -c '.target' "$TRANSITION_FILE")"
  fi
  durable_remove "$TRANSITION_FILE"
}

make_release_env() {
  local destination="$1" release_sha="$2" emergency_stop="$3"
  local source="$CONFIG_DIR/worker.env" temporary
  [[ -f "$source" && ! -L "$source" ]] || die "worker.env is unavailable"
  if grep -Eq '^NETWORK_CENTER_(WORKER_SECRET|ROUTER_PASSWORD|ROUTER_PRIVATE_KEY|BACKUP_PASSWORD)=' "$source"; then
    die "inline secrets are forbidden in worker.env"
  fi
  temporary="$(mktemp "$(dirname "$destination")/.worker-env.XXXXXX")"
  awk '!/^NODE_OPTIONS=/ && !/^NETWORK_CENTER_(RELEASE_SHA|POLL_CONCURRENCY|COMMAND_CONCURRENCY|COMMAND_CLAIM_LIMIT|SFTP_CONCURRENCY|EMERGENCY_STOP)=/' \
    "$source" > "$temporary"
  cat >> "$temporary" <<EOF
NODE_OPTIONS=$EXPECTED_NODE_OPTIONS
NETWORK_CENTER_RELEASE_SHA=$release_sha
NETWORK_CENTER_POLL_CONCURRENCY=3
NETWORK_CENTER_COMMAND_CONCURRENCY=3
NETWORK_CENTER_COMMAND_CLAIM_LIMIT=3
NETWORK_CENTER_EMERGENCY_STOP=$emergency_stop
EOF
  chown 0:0 "$temporary"
  chmod 0600 "$temporary"
  mv -fT "$temporary" "$destination"
}

compose_for_pointer() {
  local pointer="$1" action="$2"
  local image_id generation release_dir env_file project container compose_log
  image_id="$(pointer_value "$pointer" '.imageId')"
  generation="$(pointer_value "$pointer" '.secretGeneration')"
  release_dir="$(pointer_value "$pointer" '.releaseDirectory')"
  env_file="$(pointer_value "$pointer" '.envFile')"
  project="$(pointer_value "$pointer" '.projectName')"
  container="$(pointer_value "$pointer" '.containerName')"
  # Same RPC-channel rule as the image build: `docker compose` writes its whole
  # progress log to stderr (measured: 0 bytes to stdout, 6 lines to stderr for a
  # single `up -d`), and the deploy client concatenates this command's stdout AND
  # stderr before requiring exactly ONE bounded JSON receipt. stage-candidate
  # therefore returned an unparseable receipt for a canary that had actually
  # started healthy. Nothing here produces receipt data -- every caller consumes
  # only the exit status, and the real verification is done by wait_healthy and
  # pointer_exact_healthy through `docker inspect` -- so the output belongs in a
  # root-only host log, not on stdout or stderr.
  compose_log="$STATE_DIR/last-compose.log"
  if [[ -f "$compose_log" ]] && (( $(stat -c '%s' "$compose_log" 2>/dev/null || echo 0) > 1048576 )); then
    : > "$compose_log"
  fi
  touch "$compose_log"
  chmod 0600 "$compose_log"
  printf '=== %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" "$project" >> "$compose_log"
  (
    export NETWORK_CENTER_IMAGE_REF="$image_id"
    export NETWORK_CENTER_CONTAINER_NAME="$container"
    export NETWORK_CENTER_ENV_FILE="$env_file"
    export NETWORK_CENTER_RUNTIME_SECRET_DIR_HOST="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
    export NETWORK_CENTER_BACKUP_DIR_HOST="$BACKUP_DIR"
    export NETWORK_CENTER_RESTART_POLICY="unless-stopped"
    if [[ "$action" == "up" ]]; then
      docker compose --project-name "$project" --file "$release_dir/docker-compose.yml" up -d --no-build --no-deps
    else
      docker compose --project-name "$project" --file "$release_dir/docker-compose.yml" down --timeout 300
    fi
  ) >> "$compose_log" 2>&1
}

wait_healthy() {
  local container="$1" expected_image="$2" release_sha="$3" status="" actual_image
  for _ in $(seq 1 120); do
    status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    sleep 1
  done
  [[ "$status" == "healthy" ]] || die "container did not become healthy: $container"
  actual_image="$(docker inspect "$container" --format '{{.Image}}')"
  [[ "$actual_image" == "$expected_image" ]] || die "container image readback mismatch"
  [[ "$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" == "$release_sha" ]] ||
    die "container revision readback mismatch"
}

start_pointer() {
  local pointer="$1" generation
  validate_pointer "$pointer"
  generation="$(pointer_value "$pointer" '.secretGeneration')"
  materialize_runtime_secret_generation "$generation" >/dev/null
  compose_for_pointer "$pointer" up
  wait_healthy "$(pointer_value "$pointer" '.containerName')" \
    "$(pointer_value "$pointer" '.imageId')" "$(pointer_value "$pointer" '.releaseSha')"
  pointer_exact_healthy "$pointer" || die "container security or secret-generation readback mismatch"
}

stop_pointer() {
  local pointer="$1"
  [[ -f "$pointer" && ! -L "$pointer" ]] || return 0
  validate_pointer "$pointer"
  compose_for_pointer "$pointer" down
}

pointer_exact_healthy() {
  local pointer="$1" container expected_image release_sha generation expected_mount expected_secret_mount
  local status actual_image actual_release actual_user readonly_rootfs memory nano_cpus pids_limit restart_policy
  local mounts cap_drop security_opt network_mode init_enabled tmpfs secret_mount_count container_env node_options_entry
  validate_pointer "$pointer"
  container="$(pointer_value "$pointer" '.containerName')"
  expected_image="$(pointer_value "$pointer" '.imageId')"
  release_sha="$(pointer_value "$pointer" '.releaseSha')"
  generation="$(pointer_value "$pointer" '.secretGeneration')"
  (verify_runtime_secret_generation "$generation") >/dev/null 2>&1 || return 1
  expected_mount="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
  expected_secret_mount="$expected_mount|/run/secrets/network-center|false"
  status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  actual_image="$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)"
  actual_release="$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
  actual_user="$(docker inspect "$container" --format '{{.Config.User}}' 2>/dev/null || true)"
  readonly_rootfs="$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null || true)"
  memory="$(docker inspect "$container" --format '{{.HostConfig.Memory}}' 2>/dev/null || true)"
  nano_cpus="$(docker inspect "$container" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || true)"
  pids_limit="$(docker inspect "$container" --format '{{.HostConfig.PidsLimit}}' 2>/dev/null || true)"
  restart_policy="$(docker inspect "$container" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true)"
  cap_drop="$(docker inspect "$container" --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' 2>/dev/null || true)"
  security_opt="$(docker inspect "$container" --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' 2>/dev/null || true)"
  network_mode="$(docker inspect "$container" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || true)"
  init_enabled="$(docker inspect "$container" --format '{{.HostConfig.Init}}' 2>/dev/null || true)"
  tmpfs="$(docker inspect "$container" --format '{{range $path, $options := .HostConfig.Tmpfs}}{{printf "%s:%s\n" $path $options}}{{end}}' 2>/dev/null || true)"
  mounts="$(docker inspect "$container" --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}' 2>/dev/null || true)"
  container_env="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)"
  node_options_entry="$(printf '%s\n' "$container_env" | awk '/^NODE_OPTIONS=/{print}')"
  [[ "$status" == healthy && "$actual_image" == "$expected_image" && "$actual_release" == "$release_sha" &&
     "$actual_user" == "10001:10001" && "$readonly_rootfs" == true && "$memory" == 536870912 &&
     "$nano_cpus" == 500000000 && "$pids_limit" == 128 && "$restart_policy" == unless-stopped &&
     "$cap_drop" == ALL && "$security_opt" == no-new-privileges:true && "$network_mode" == host &&
     "$init_enabled" == true && "$tmpfs" == '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700' &&
     "$node_options_entry" == "NODE_OPTIONS=$EXPECTED_NODE_OPTIONS" ]] || return 1
  ! printf '%s\n' "$mounts" | awk -F'|' '$1 == "/var/run/docker.sock" || $2 == "/var/run/docker.sock" { found=1 } END { exit !found }' || return 1
  secret_mount_count="$(printf '%s\n' "$mounts" | awk -F'|' -v source="$expected_mount" \
    '$1 == source || $2 == "/run/secrets/network-center" { count++ } END { print count+0 }')"
  [[ "$secret_mount_count" == 1 ]] || return 1
  printf '%s\n' "$mounts" | grep -Fqx "$expected_secret_mount"
}

temporary_pointer_from_json() {
  local value="$1" temporary
  temporary="$(mktemp "$STATE_DIR/.journal-pointer.XXXXXX")"
  printf '%s\n' "$value" > "$temporary"
  chmod 0600 "$temporary"
  printf '%s\n' "$temporary"
}

converge_pointer_set() {
  local desired="$1" pointer value temporary
  for pointer in "$CURRENT_POINTER" "$PENDING_POINTER"; do
    (stop_pointer "$pointer") >/dev/null 2>&1 || true
  done
  apply_pointer_set "$desired"
  for value in "$(printf '%s' "$desired" | jq -c '.current')" "$(printf '%s' "$desired" | jq -c '.pending')"; do
    [[ "$value" != "null" ]] || continue
    temporary="$(temporary_pointer_from_json "$value")"
    start_pointer "$temporary"
    rm -f -- "$temporary"
  done
}

pointer_container_running() {
  local pointer="$1" container status
  container="$(pointer_value "$pointer" '.containerName')"
  status="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)"
  [[ "$status" == running ]]
}

validate_runtime_intent() {
  local intent="$1"
  [[ -f "$intent" && ! -L "$intent" ]] || die "runtime intent is unavailable"
  [[ "$(stat -c '%s' "$intent")" -le 4096 ]] || die "runtime intent exceeds its byte bound"
  jq -e '
    type == "object" and
    ((keys | sort) == ["emergencyStop","operation","releaseSha","schemaVersion"]) and
    .schemaVersion == 1 and .operation == "emergency-stop" and
    (.emergencyStop | type == "boolean") and
    (.releaseSha | type == "string" and test("^[a-f0-9]{40}$"))
  ' "$intent" >/dev/null || die "runtime intent schema is invalid"
}

write_runtime_intent() {
  local release_sha="$1" emergency_stop="$2" temporary
  validate_sha "$release_sha"
  [[ "$emergency_stop" == true || "$emergency_stop" == false ]] || die "runtime intent value is invalid"
  temporary="$(mktemp "$STATE_DIR/.runtime-intent.XXXXXX")"
  jq -n --arg releaseSha "$release_sha" --argjson emergencyStop "$emergency_stop" \
    '{schemaVersion:1,operation:"emergency-stop",releaseSha:$releaseSha,emergencyStop:$emergencyStop}' \
    > "$temporary"
  chmod 0600 "$temporary"
  durable_replace "$temporary" "$RUNTIME_INTENT_FILE"
}

begin_runtime_mutation() {
  write_runtime_intent "$1" "$2"
  activation_mutation_in_flight=true
}

end_runtime_mutation() {
  activation_mutation_in_flight=false
  durable_remove "$RUNTIME_INTENT_FILE"
}

# Converges the live worker onto the runtime state the operator last asked for.
# Reached from every command (and therefore from `start-current` at boot), so an
# emergency stop that lost its ssh session mid-change is completed, not dropped.
recover_runtime_intent() {
  [[ -e "$RUNTIME_INTENT_FILE" ]] || return 0
  if ! (validate_runtime_intent "$RUNTIME_INTENT_FILE"); then
    quarantine_state_file "$RUNTIME_INTENT_FILE" runtime-intent
    return 0
  fi
  local release_sha emergency_stop env_file
  release_sha="$(jq -er '.releaseSha' "$RUNTIME_INTENT_FILE")"
  emergency_stop="$(jq -er '.emergencyStop' "$RUNTIME_INTENT_FILE")"
  if [[ ! -f "$CURRENT_POINTER" || -L "$CURRENT_POINTER" ]]; then
    quarantine_state_file "$RUNTIME_INTENT_FILE" runtime-intent
    return 0
  fi
  validate_pointer "$CURRENT_POINTER"
  if [[ "$(pointer_value "$CURRENT_POINTER" '.releaseSha')" != "$release_sha" ]]; then
    # Naming a release that is no longer current makes this intent unappliable;
    # the environment of the release that IS current must not be rewritten.
    abandon_runtime_intent "it names a release that is no longer current"
    return 0
  fi
  env_file="$(pointer_value "$CURRENT_POINTER" '.envFile')"
  # The operator's runtime state lands in the release environment BEFORE the
  # restart is attempted, so abandoning the journal below still leaves an
  # emergency stop applied to whatever starts the worker next.
  make_release_env "$env_file" "$release_sha" "$emergency_stop"
  if ! (start_pointer "$CURRENT_POINTER"); then
    # A paused worker cannot complete the poll cycle its health gate needs; that
    # is expected, and it must never be a reason to un-pause it.
    if [[ "$emergency_stop" != true ]] || ! pointer_container_running "$CURRENT_POINTER"; then
      abandon_runtime_intent "the worker did not come back under the recorded runtime state"
      return 0
    fi
    printf 'network-center activation: emergency stop reapplied without a health readback\n' >&2
  fi
  end_runtime_mutation
}

# recover_transition runs from start-current, so dying inside runtime-intent
# recovery wedges boot and every other command - exactly the permanent stop the
# transition-journal quarantine exists to prevent. Report loudly, keep the bytes
# for inspection, and let the pointer set stay authoritative.
abandon_runtime_intent() {
  printf 'network-center activation: recorded runtime intent could not be re-applied (%s)\n' "$1" >&2
  quarantine_state_file "$RUNTIME_INTENT_FILE" runtime-intent
}

recover_transition() {
  recover_runtime_intent
  [[ -e "$TRANSITION_FILE" ]] || return 0
  if ! (validate_transition_journal "$TRANSITION_FILE"); then
    quarantine_state_file "$TRANSITION_FILE" transition-journal
    return 0
  fi
  local phase target target_pointer before after
  phase="$(jq -er '.phase' "$TRANSITION_FILE")"
  before="$(jq -c '.before' "$TRANSITION_FILE")"
  after="$(jq -c '.after' "$TRANSITION_FILE")"
  target="$(jq -c '.target' "$TRANSITION_FILE")"
  case "$phase" in
    prepared)
      converge_pointer_set "$before"
      ;;
    commit-intent)
      target_pointer="$(temporary_pointer_from_json "$target")"
      if ! pointer_exact_healthy "$target_pointer"; then
        if ! (start_pointer "$target_pointer"); then
          converge_pointer_set "$before"
          rm -f -- "$target_pointer"
          rm -f -- "$TRANSITION_FILE"
          return 0
        fi
      fi
      if pointer_exact_healthy "$target_pointer"; then
        apply_pointer_set "$after"
        commit_transition
      else
        converge_pointer_set "$before"
        rm -f -- "$TRANSITION_FILE"
      fi
      rm -f -- "$target_pointer"
      ;;
    *)
      # Schema-valid but unreachable here: no writer leaves a committed,
      # compensated or finalized phase in transition.json. Report and step aside
      # rather than wedging boot; the pointer set stays authoritative.
      quarantine_state_file "$TRANSITION_FILE" transition-journal
      return 0
      ;;
  esac
  [[ ! -e "$TRANSITION_FILE" ]] || rm -f -- "$TRANSITION_FILE"
}

referenced_values() {
  local field="$1" pointer
  for pointer in "$CURRENT_POINTER" "$PREVIOUS_POINTER" "$PENDING_POINTER"; do
    [[ -f "$pointer" ]] && jq -er ".$field" "$pointer"
  done
  if [[ -f "$TRANSITION_FILE" ]]; then
    jq -er ".. | objects | .$field? // empty" "$TRANSITION_FILE"
  fi
  if [[ -f "$LAST_TRANSITION_FILE" ]]; then
    [[ "$(jq -er '.phase' "$LAST_TRANSITION_FILE")" == finalized ]] ||
      jq -er ".. | objects | .$field? // empty" "$LAST_TRANSITION_FILE"
  fi
}

value_is_kept() {
  local needle="$1" candidate
  shift
  for candidate in "$@"; do
    [[ -n "$candidate" && "$candidate" == "$needle" ]] && return 0
  done
  return 1
}

cleanup_unreferenced_secret_generations() {
  local -a kept=()
  local value path name container source
  while IFS= read -r value; do [[ -n "$value" ]] && kept+=("$value"); done < <(referenced_values secretGeneration)
  while IFS= read -r container; do
    while IFS= read -r source; do
      [[ "$source" == "$RUNTIME_SECRET_GENERATIONS_DIR/"* ]] && kept+=("$(basename "$source")")
    done < <(docker inspect "$container" --format '{{range .Mounts}}{{println .Source}}{{end}}' 2>/dev/null || true)
  done < <(docker ps -aq --filter 'label=com.ihomecrm.component=network-center-worker')
  for path in "$SECRET_GENERATIONS_DIR"/* "$RUNTIME_SECRET_GENERATIONS_DIR"/*; do
    [[ -d "$path" && ! -L "$path" ]] || continue
    name="$(basename "$path")"
    [[ "$name" =~ ^[a-f0-9]{64}$ ]] || continue
    value_is_kept "$name" "${kept[@]}" || rm -rf -- "$path"
  done
  # An interrupted snapshot/materialize leaves `.generation.XXXXXX` behind, and
  # the loop above cannot see it: the name is not a digest, and the glob skips
  # dotted entries entirely. Only the exact mktemp shape is swept, and only
  # inside the two generation roots this project owns.
  local staging
  for staging in "$SECRET_GENERATIONS_DIR" "$RUNTIME_SECRET_GENERATIONS_DIR"; do
    [[ -d "$staging" && ! -L "$staging" ]] || continue
    while IFS= read -r -d '' path; do
      [[ "$(basename "$path")" =~ ^\.generation\.[A-Za-z0-9]{6}$ ]] || continue
      rm -rf -- "$path"
    done < <(find "$staging" -mindepth 1 -maxdepth 1 -type d -print0)
  done
}

cleanup_unreferenced_releases() {
  local -a kept_sha=() kept_image=()
  local value path name image short_image label component
  while IFS= read -r value; do [[ -n "$value" ]] && kept_sha+=("$value"); done < <(referenced_values releaseSha)
  while IFS= read -r value; do [[ -n "$value" ]] && kept_image+=("$value"); done < <(referenced_values imageId)
  while IFS= read -r -d '' path; do
    name="$(basename "$path")"
    # `.release-<sha>.XXXXXX` is an interrupted stage: a SIGKILL or a power cut
    # runs no trap, so cleanup has to be able to see the residue by itself. It
    # can never be referenced - validate_pointer pins releaseDirectory to
    # $RELEASES_DIR/<sha>, so a staging name is never a pointer target - but the
    # tree this invocation still owns is skipped by exact path. Anything that is
    # neither a bare SHA nor this exact mktemp shape is left alone: the release
    # root is ours, but the disk is shared with another production service.
    if [[ "$name" =~ ^\.release-[a-f0-9]{40}\.[A-Za-z0-9]{6}$ ]]; then
      [[ "$path" == "$staging_temporary" ]] || rm -rf -- "$path"
      continue
    fi
    [[ "$name" =~ ^[a-f0-9]{40}$ ]] || continue
    value_is_kept "$name" "${kept_sha[@]}" || rm -rf -- "$path"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print0)
  while IFS= read -r -d '' path; do
    name="$(basename "$path" .tar.gz)"
    [[ "$name" =~ ^[a-f0-9]{40}$ ]] || continue
    value_is_kept "$name" "${kept_sha[@]}" || rm -f -- "$path"
  done < <(find "$INCOMING_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tar.gz' -print0)
  while IFS= read -r short_image; do
    [[ -n "$short_image" ]] || continue
    image="$(docker image inspect "$short_image" --format '{{.Id}}')"
    label="$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
    component="$(docker image inspect "$image" --format '{{ index .Config.Labels "com.ihomecrm.component" }}')"
    [[ "$component" == "network-center-worker" && "$label" =~ ^[a-f0-9]{40}$ ]] || die "managed image label is invalid"
    value_is_kept "$image" "${kept_image[@]}" || docker image rm "$image" >/dev/null
  done < <(docker image ls --filter 'label=com.ihomecrm.component=network-center-worker' --format '{{.ID}}' | sort -u)
  cleanup_unreferenced_secret_generations
}

cleanup_after_commit() {
  [[ "${NETWORK_CENTER_FAILPOINT:-}" != cleanup ]] || return 1
  (set -e; cleanup_unreferenced_releases)
}

stage_candidate_failed() {
  local release_sha="$1" temporary="$2"
  trap - ERR HUP INT TERM
  set +e
  staging_temporary=""
  if [[ -f "$PENDING_POINTER" ]] && [[ "$(jq -er '.releaseSha' "$PENDING_POINTER" 2>/dev/null)" == "$release_sha" ]]; then
    stop_pointer "$PENDING_POINTER" >/dev/null 2>&1 || true
    rm -f -- "$PENDING_POINTER"
  fi
  if [[ -n "$temporary" && "$temporary" == "$RELEASES_DIR/.release-$release_sha."* && -d "$temporary" && ! -L "$temporary" ]]; then
    rm -rf -- "$temporary"
  fi
  cleanup_unreferenced_releases >/dev/null 2>&1 || true
  printf 'network-center activation: candidate staging failed and scoped cleanup ran\n' >&2
  exit 1
}

stage_candidate() {
  local release_sha="$1" archive="$2" archive_sha="$3"
  local release_dir="$RELEASES_DIR/$release_sha" temporary="" candidate_dir
  local image_tag image_id label component archive_owner archive_mode generation
  local stored_archive="$INCOMING_DIR/$release_sha.tar.gz" env_file project container
  local build_log
  validate_sha "$release_sha"
  validate_digest "$archive_sha"
  [[ -f "$archive" && ! -L "$archive" ]] || die "release archive is unavailable"
  archive_owner="$(stat -c '%u:%g' "$archive")"
  archive_mode="$(stat -c '%a' "$archive")"
  [[ "$archive_owner" == "0:0" && "$archive_mode" == "600" ]] || die "release archive must be root:root 0600"
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$archive_sha" ]] || die "release archive digest mismatch"
  [[ ! -e "$PENDING_POINTER" ]] || die "a pending release already exists"
  # Reclaim BEFORE refusing the SHA. A session dropped between the `mv` below and
  # write_pointer leaves $RELEASES_DIR/<sha> with nothing referencing it; refusing
  # first made the obvious retry of the same SHA fail forever. Cleanup only ever
  # removes unreferenced entries, so a directory a pointer or a live journal still
  # references survives it and is refused by the check that follows.
  cleanup_unreferenced_releases
  [[ ! -e "$release_dir" ]] || die "release directory already exists"
  ensure_disk_reserve "$((MINIMUM_FREE_BYTES + STAGE_HEADROOM_BYTES))"
  if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "release archive contains an unsafe path"; fi
  if tar -tvzf "$archive" | awk '$1 ~ /^[lh]/ { found = 1 } END { exit !found }'; then
    die "release archive symlinks and hard links are forbidden"
  fi
  # The ERR trap never sees a signal, and `ssh sudo --` SIGHUPs this script the
  # moment the session drops - which is exactly when an unpacked, half-built
  # staging tree is on disk. Compensate on the signal too instead of leaving it
  # for the next stage to find.
  trap 'stage_candidate_failed "$release_sha" "$temporary"' ERR HUP INT TERM
  temporary="$(mktemp -d "$RELEASES_DIR/.release-$release_sha.XXXXXX")"
  staging_temporary="$temporary"
  tar -xzf "$archive" -C "$temporary"
  candidate_dir="$temporary/infra/network-center-worker"
  [[ -d "$candidate_dir" && ! -L "$candidate_dir" ]] || die "worker archive root is missing"
  [[ -z "$(find "$candidate_dir" -type l -print -quit)" ]] || die "release source symlinks are forbidden"
  chown -R 0:0 "$candidate_dir"
  find "$candidate_dir" -type d -exec chmod 0755 {} +
  find "$candidate_dir" -type f -exec chmod 0644 {} +
  chmod 0755 "$candidate_dir/deploy/"*.sh
  image_tag="ihome-network-center-worker:$release_sha"
  # stage-candidate's contract with the deploy client is "return exactly ONE
  # bounded JSON receipt", and the client concatenates this command's stdout AND
  # stderr before parsing it. BuildKit writes its whole progress log to stderr
  # (measured: 0 bytes to stdout), so an unredirected build guarantees an
  # unparseable receipt for a build that actually succeeded. Keep the build off
  # both RPC channels and leave it in a root-only log that `die` names.
  build_log="$STATE_DIR/last-build.log"
  : > "$build_log"
  chmod 0600 "$build_log"
  if ! docker build --pull=false --build-arg "NETWORK_CENTER_RELEASE_SHA=$release_sha" \
      --tag "$image_tag" "$candidate_dir" >> "$build_log" 2>&1; then
    die "release image build failed; see $build_log on the host"
  fi
  image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || die "built image ID is invalid"
  label="$(docker image inspect "$image_id" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  component="$(docker image inspect "$image_id" --format '{{ index .Config.Labels "com.ihomecrm.component" }}')"
  [[ "$label" == "$release_sha" && "$component" == "network-center-worker" ]] || die "built image labels mismatch"
  ensure_disk_reserve "$MINIMUM_FREE_BYTES"
  mv "$candidate_dir" "$release_dir"
  rmdir "$temporary/infra" "$temporary"
  temporary=""
  staging_temporary=""
  install -o root -g root -m 0600 "$archive" "$stored_archive"
  generation="$(snapshot_secret_generation)"
  materialize_runtime_secret_generation "$generation" >/dev/null
  env_file="$release_dir/.env.canary"
  make_release_env "$env_file" "$release_sha" true
  project="ihome-nc-canary-${release_sha:0:12}"
  container="ihome-network-center-worker-canary-${release_sha:0:12}"
  write_pointer "$PENDING_POINTER" "$release_sha" "$image_tag" "$image_id" "$archive_sha" \
    "$generation" "$release_dir" "$env_file" "$project" "$container"
  if ! (start_pointer "$PENDING_POINTER"); then
    (stop_pointer "$PENDING_POINTER") || true
    rm -f -- "$PENDING_POINTER"
    cleanup_unreferenced_releases
    die "emergency-stop canary failed"
  fi
  # Hand the signals back to the top-level handlers rather than to their default
  # disposition: everything after this point is a runtime mutation again.
  trap - ERR HUP INT TERM
  install_activation_signal_handlers
  jq -cn --arg releaseSha "$release_sha" --arg imageId "$image_id" --arg secretGeneration "$generation" \
    '{schemaVersion:2,releaseSha:$releaseSha,imageId:$imageId,secretGeneration:$secretGeneration,
      canary:"healthy",emergencyStop:true}'
}

force_pointer_emergency_stop() {
  local pointer="$1" release_sha env_file
  validate_pointer "$pointer"
  release_sha="$(pointer_value "$pointer" '.releaseSha')"
  env_file="$(pointer_value "$pointer" '.envFile')"
  make_release_env "$env_file" "$release_sha" true
}

abort_pending() {
  local release_sha="$1" image_id generation cleanup="complete"
  recover_transition
  validate_sha "$release_sha"
  validate_pointer "$PENDING_POINTER"
  [[ "$(pointer_value "$PENDING_POINTER" '.releaseSha')" == "$release_sha" ]] || die "pending release mismatch"
  image_id="$(pointer_value "$PENDING_POINTER" '.imageId')"
  generation="$(pointer_value "$PENDING_POINTER" '.secretGeneration')"
  stop_pointer "$PENDING_POINTER"
  rm -f -- "$PENDING_POINTER"
  cleanup_after_commit >/dev/null 2>&1 || cleanup="deferred"
  jq -cn --arg releaseSha "$release_sha" --arg imageId "$image_id" --arg secretGeneration "$generation" \
    --arg cleanup "$cleanup" '{schemaVersion:2,releaseSha:$releaseSha,imageId:$imageId,
      secretGeneration:$secretGeneration,pending:"aborted",cleanup:$cleanup}'
}

set_last_transition_phase() {
  local phase="$1" temporary
  validate_transition_journal "$LAST_TRANSITION_FILE"
  temporary="$(mktemp "$STATE_DIR/.last-transition.XXXXXX")"
  jq --arg phase "$phase" '.phase = $phase' "$LAST_TRANSITION_FILE" > "$temporary"
  chmod 0600 "$temporary"
  validate_transition_journal "$temporary"
  durable_replace "$temporary" "$LAST_TRANSITION_FILE"
}

compensate_last_transition() {
  local release_sha="$1" operation phase target_sha before current
  recover_transition
  validate_sha "$release_sha"
  validate_transition_journal "$LAST_TRANSITION_FILE"
  operation="$(jq -er '.operation' "$LAST_TRANSITION_FILE")"
  phase="$(jq -er '.phase' "$LAST_TRANSITION_FILE")"
  target_sha="$(jq -er '.target.releaseSha' "$LAST_TRANSITION_FILE")"
  [[ "$operation" == promote && "$target_sha" == "$release_sha" ]] ||
    die "last transition does not match the requested promotion"
  [[ "$phase" == committed || "$phase" == compensated ]] || die "last transition is not compensatable"
  before="$(jq -c '.before' "$LAST_TRANSITION_FILE")"
  if [[ "$phase" == committed ]]; then
    if [[ "$(pointer_set_json)" == "$(jq -c '.after' "$LAST_TRANSITION_FILE")" ]]; then
      converge_pointer_set "$before"
    elif [[ "$(pointer_set_json)" != "$before" ]]; then
      die "committed transition pointer set is mixed"
    fi
    [[ "$(pointer_set_json)" == "$before" ]] || die "compensation did not restore the exact pre-state"
    current="$(printf '%s' "$before" | jq -c '.current')"
    [[ "$current" == null ]] || pointer_exact_healthy "$CURRENT_POINTER" ||
      die "compensated current release is not exact healthy"
    set_last_transition_phase compensated
  else
    [[ "$(pointer_set_json)" == "$before" ]] || die "compensated pointer set is mixed"
  fi
  jq -cn --arg releaseSha "$release_sha" \
    '{schemaVersion:2,releaseSha:$releaseSha,result:"compensated",finalization:"required"}'
}

finalize_last_transition() {
  local release_sha="$1" phase target_sha desired cleanup="complete"
  recover_transition
  validate_sha "$release_sha"
  validate_transition_journal "$LAST_TRANSITION_FILE"
  phase="$(jq -er '.phase' "$LAST_TRANSITION_FILE")"
  target_sha="$(jq -er '.target.releaseSha' "$LAST_TRANSITION_FILE")"
  [[ "$target_sha" == "$release_sha" ]] || die "last transition release mismatch"
  [[ "$phase" == committed || "$phase" == compensated || "$phase" == finalized ]] || die "last transition is not finalizable"
  if [[ "$phase" != finalized ]]; then
    if [[ "$phase" == committed ]]; then desired="$(jq -c '.after' "$LAST_TRANSITION_FILE")"
    else desired="$(jq -c '.before' "$LAST_TRANSITION_FILE")"; fi
    [[ "$(pointer_set_json)" == "$desired" ]] || die "finalization pointer set is mixed"
    [[ "$(printf '%s' "$desired" | jq -c '.current')" == null ]] || pointer_exact_healthy "$CURRENT_POINTER" ||
      die "finalization current release is not exact healthy"
    set_last_transition_phase finalized
  fi
  cleanup_after_commit >/dev/null 2>&1 || cleanup="deferred"
  jq -cn --arg releaseSha "$release_sha" --arg cleanup "$cleanup" \
    '{schemaVersion:2,releaseSha:$releaseSha,result:"finalized",cleanup:$cleanup}'
}

inspect_pointer_state() {
  local pointer="$1"
  [[ -f "$pointer" && ! -L "$pointer" ]] || { printf 'null\n'; return; }
  validate_pointer "$pointer"
  local release_sha image_id generation container container_exists=false container_status="missing"
  local container_health="missing" actual_image="" actual_release="" persistent_available=false runtime_available=false exact_match=false
  local actual_user="" readonly_rootfs=false memory=0 nano_cpus=0 pids_limit=0 restart_policy="" docker_socket=false
  local secret_mount=false secret_mount_source="" secret_mount_destination="" secret_mount_read_only=false expected_mount expected_secret_mount
  local mounts="" cap_drop="" security_opt="" network_mode="" init_enabled=false tmpfs="" container_env="" node_options=""
  local cap_drop_all=false no_new_privileges=false host_network=false exact_tmpfs=false exact_node_options=false secret_mount_count=0
  release_sha="$(pointer_value "$pointer" '.releaseSha')"
  image_id="$(pointer_value "$pointer" '.imageId')"
  generation="$(pointer_value "$pointer" '.secretGeneration')"
  container="$(pointer_value "$pointer" '.containerName')"
  expected_mount="$RUNTIME_SECRET_GENERATIONS_DIR/$generation"
  expected_secret_mount="$expected_mount|/run/secrets/network-center|false"
  if (verify_persistent_secret_generation "$generation") >/dev/null 2>&1; then persistent_available=true; fi
  if (verify_runtime_secret_generation "$generation") >/dev/null 2>&1; then runtime_available=true; fi
  if docker inspect "$container" >/dev/null 2>&1; then
    container_exists=true
    container_status="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || printf unknown)"
    container_health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || printf unknown)"
    actual_image="$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)"
    actual_release="$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
    actual_user="$(docker inspect "$container" --format '{{.Config.User}}' 2>/dev/null || true)"
    readonly_rootfs="$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null || printf false)"
    memory="$(docker inspect "$container" --format '{{.HostConfig.Memory}}' 2>/dev/null || printf 0)"
    nano_cpus="$(docker inspect "$container" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || printf 0)"
    pids_limit="$(docker inspect "$container" --format '{{.HostConfig.PidsLimit}}' 2>/dev/null || printf 0)"
    restart_policy="$(docker inspect "$container" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true)"
    cap_drop="$(docker inspect "$container" --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' 2>/dev/null || true)"
    security_opt="$(docker inspect "$container" --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' 2>/dev/null || true)"
    network_mode="$(docker inspect "$container" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || true)"
    init_enabled="$(docker inspect "$container" --format '{{.HostConfig.Init}}' 2>/dev/null || printf false)"
    tmpfs="$(docker inspect "$container" --format '{{range $path, $options := .HostConfig.Tmpfs}}{{printf "%s:%s\n" $path $options}}{{end}}' 2>/dev/null || true)"
    mounts="$(docker inspect "$container" --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}' 2>/dev/null || true)"
    container_env="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)"
    node_options="$(printf '%s\n' "$container_env" | awk -F= '/^NODE_OPTIONS=/{count++; value=substr($0, index($0, "=") + 1)} END {if (count == 1) print value}')"
    if printf '%s\n' "$mounts" | awk -F'|' '$1 == "/var/run/docker.sock" || $2 == "/var/run/docker.sock" { found=1 } END { exit !found }'; then docker_socket=true; fi
    secret_mount_count="$(printf '%s\n' "$mounts" | awk -F'|' -v source="$expected_mount" \
      '$1 == source || $2 == "/run/secrets/network-center" { count++ } END { print count+0 }')"
    if [[ "$secret_mount_count" == 1 ]] && printf '%s\n' "$mounts" | grep -Fqx "$expected_secret_mount"; then
      secret_mount=true
      secret_mount_source="$expected_mount"
      secret_mount_destination=/run/secrets/network-center
      secret_mount_read_only=true
    fi
    [[ "$cap_drop" == ALL ]] && cap_drop_all=true
    [[ "$security_opt" == no-new-privileges:true ]] && no_new_privileges=true
    [[ "$network_mode" == host ]] && host_network=true
    [[ "$tmpfs" == '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700' ]] && exact_tmpfs=true
    [[ "$node_options" == "$EXPECTED_NODE_OPTIONS" ]] && exact_node_options=true
  fi
  if [[ "$container_exists" == true && "$container_status" == running && "$container_health" == healthy &&
        "$actual_image" == "$image_id" && "$actual_release" == "$release_sha" &&
        "$persistent_available" == true && "$runtime_available" == true && "$actual_user" == "10001:10001" &&
        "$readonly_rootfs" == true && "$memory" == 536870912 && "$nano_cpus" == 500000000 &&
        "$pids_limit" == 128 && "$restart_policy" == unless-stopped && "$docker_socket" == false && "$secret_mount" == true &&
        "$cap_drop_all" == true && "$no_new_privileges" == true && "$host_network" == true &&
        "$init_enabled" == true && "$exact_tmpfs" == true && "$exact_node_options" == true ]]; then
    exact_match=true
  fi
  jq -cn --argjson pointer "$(jq -c . "$pointer")" --argjson exists "$container_exists" \
    --arg status "$container_status" --arg health "$container_health" --arg actualImage "$actual_image" \
    --arg actualRelease "$actual_release" --argjson persistent "$persistent_available" \
    --argjson runtime "$runtime_available" --argjson exact "$exact_match" --arg user "$actual_user" \
    --argjson readonlyRootfs "$readonly_rootfs" --argjson memory "$memory" --argjson nanoCpus "$nano_cpus" \
    --argjson pidsLimit "$pids_limit" --arg restartPolicy "$restart_policy" \
    --argjson dockerSocket "$docker_socket" --argjson secretMount "$secret_mount" \
    --arg secretMountSource "$secret_mount_source" --arg secretMountDestination "$secret_mount_destination" \
    --argjson secretMountReadOnly "$secret_mount_read_only" --arg capDrop "$cap_drop" --arg securityOpt "$security_opt" \
    --arg networkMode "$network_mode" --argjson initEnabled "$init_enabled" --arg tmpfs "$tmpfs" \
    --arg nodeOptions "$node_options" --argjson exactNodeOptions "$exact_node_options" \
    --argjson capDropAll "$cap_drop_all" --argjson noNewPrivileges "$no_new_privileges" \
    --argjson hostNetwork "$host_network" --argjson exactTmpfs "$exact_tmpfs" \
    '$pointer + {container:{exists:$exists,status:$status,health:$health,imageId:(if $actualImage == "" then null else $actualImage end),
      releaseSha:(if $actualRelease == "" then null else $actualRelease end),exactMatch:$exact},
      secrets:{persistentAvailable:$persistent,runtimeAvailable:$runtime,exactMatch:($persistent and $runtime)},
      security:{user:$user,readonlyRootfs:$readonlyRootfs,memory:$memory,nanoCpus:$nanoCpus,
        pidsLimit:$pidsLimit,restartPolicy:$restartPolicy,dockerSocketMounted:$dockerSocket,
        exactSecretGenerationMounted:$secretMount,secretMountSource:$secretMountSource,
        secretMountDestination:$secretMountDestination,secretMountReadOnly:$secretMountReadOnly,
        capDrop:$capDrop,capDropAll:$capDropAll,securityOpt:$securityOpt,noNewPrivileges:$noNewPrivileges,
        networkMode:$networkMode,hostNetwork:$hostNetwork,initEnabled:$initEnabled,tmpfs:$tmpfs,exactTmpfs:$exactTmpfs,
        nodeOptions:$nodeOptions,exactNodeOptions:$exactNodeOptions}}'
}

inspect_state() {
  local transition="null" last_transition="null"
  if [[ -f "$TRANSITION_FILE" ]]; then
    validate_transition_journal "$TRANSITION_FILE"
    transition="$(jq -c '{operation,phase}' "$TRANSITION_FILE")"
  fi
  if [[ -f "$LAST_TRANSITION_FILE" ]]; then
    validate_transition_journal "$LAST_TRANSITION_FILE"
    last_transition="$(jq -c '{schemaVersion,operation,phase,targetReleaseSha:.target.releaseSha}' "$LAST_TRANSITION_FILE")"
  fi
  jq -cn --argjson transition "$transition" \
    --argjson lastTransition "$last_transition" \
    --argjson current "$(inspect_pointer_state "$CURRENT_POINTER")" \
    --argjson previous "$(inspect_pointer_state "$PREVIOUS_POINTER")" \
    --argjson pending "$(inspect_pointer_state "$PENDING_POINTER")" \
    '{schemaVersion:2,transition:$transition,lastTransition:$lastTransition,current:$current,previous:$previous,pending:$pending}'
}

reconcile_state() {
  recover_transition
  inspect_state
}

promote_pending() {
  local release_sha="$1" before old_current candidate active_env target_pointer target after
  recover_transition
  validate_sha "$release_sha"
  validate_pointer "$PENDING_POINTER"
  [[ "$(pointer_value "$PENDING_POINTER" '.releaseSha')" == "$release_sha" ]] || die "pending release mismatch"
  before="$(pointer_set_json)"
  old_current="$(printf '%s' "$before" | jq -c '.current')"
  candidate="$(jq -c . "$PENDING_POINTER")"
  stop_pointer "$PENDING_POINTER"
  active_env="$(pointer_value "$PENDING_POINTER" '.releaseDirectory')/.env.active"
  make_release_env "$active_env" "$release_sha" true
  target_pointer="$(mktemp "$STATE_DIR/.candidate.XXXXXX")"
  printf '%s' "$candidate" | jq --arg envFile "$active_env" --arg projectName ihome-network-center \
    --arg containerName ihome-network-center-worker '.envFile=$envFile | .projectName=$projectName | .containerName=$containerName' \
    > "$target_pointer"
  chmod 0600 "$target_pointer"
  target="$(jq -c . "$target_pointer")"
  after="$(jq -cn --argjson current "$target" --argjson previous "$old_current" '{current:$current,previous:$previous,pending:null}')"
  begin_transition promote "$before" "$after" "$target"
  [[ "$old_current" == "null" ]] || stop_pointer "$CURRENT_POINTER"
  failpoint after-old-current-stopped
  if ! (start_pointer "$target_pointer"); then
    converge_pointer_set "$before"
    rm -f -- "$TRANSITION_FILE" "$target_pointer"
    die "active candidate failed; restore-previous completed"
  fi
  mark_transition_commit_intent
  apply_transition_after
  pointer_exact_healthy "$CURRENT_POINTER" || die "committed current state is not exact healthy"
  commit_transition
  rm -f -- "$target_pointer"
  jq -cn --argjson pointer "$(jq -c . "$CURRENT_POINTER")" \
    '$pointer | {schemaVersion:2,releaseSha,imageId,secretGeneration,active:"healthy",finalization:"required"}'
}

set_emergency_stop() {
  local requested="$1" release_sha env_file previous_env health=healthy
  recover_transition
  [[ "$requested" == true || "$requested" == false ]] || die "emergency stop must be true or false"
  validate_pointer "$CURRENT_POINTER"
  release_sha="$(pointer_value "$CURRENT_POINTER" '.releaseSha')"
  env_file="$(pointer_value "$CURRENT_POINTER" '.envFile')"
  previous_env="$(mktemp "$STATE_DIR/.worker-env-rollback.XXXXXX")"
  cp --preserve=mode "$env_file" "$previous_env"
  # Durable intent first: this runs under `ssh sudo --`, and a dropped session
  # SIGHUPs the script. Without a record on disk the worker would stay stopped
  # while current.release still pointed at the release and the oneshot unit still
  # reported active - 15 buildings silently unpolled.
  begin_runtime_mutation "$release_sha" "$requested"
  stop_pointer "$CURRENT_POINTER"
  make_release_env "$env_file" "$release_sha" "$requested"
  if ! (start_pointer "$CURRENT_POINTER"); then
    if [[ "$requested" == true ]]; then
      # An emergency stop must never revert itself. The health gate only passes
      # after a full polling cycle plus a Supabase round trip, which is exactly
      # what the fleet an operator is pausing cannot deliver; restoring the prior
      # environment here re-armed the worker they were trying to stop.
      if ! pointer_container_running "$CURRENT_POINTER"; then
        end_runtime_mutation
        rm -f -- "$previous_env"
        die "emergency stop is applied but the worker container is not running"
      fi
      health=unverified
      printf 'network-center activation: emergency stop applied without a health readback\n' >&2
    else
      mv -fT "$previous_env" "$env_file"
      if ! (start_pointer "$CURRENT_POINTER"); then
        end_runtime_mutation
        die "emergency-stop change failed and prior environment could not be restored"
      fi
      end_runtime_mutation
      die "emergency-stop change failed; prior environment restored"
    fi
  fi
  end_runtime_mutation
  rm -f -- "$previous_env"
  jq -cn --arg releaseSha "$release_sha" --argjson emergencyStop "$requested" --arg health "$health" \
    '{schemaVersion:2,releaseSha:$releaseSha,emergencyStop:$emergencyStop,health:$health}'
}

# The README documents driving these commands over ssh. Non-interactive bash with
# no HUP trap dies the instant the session drops, so without these the window
# between stopping and restarting the worker has no compensation at all.
handle_activation_signal() {
  local signal="$1"
  trap - HUP INT TERM EXIT
  if [[ "$activation_mutation_in_flight" != true ]]; then
    die "interrupted by SIG$signal before any runtime mutation"
  fi
  activation_mutation_in_flight=false
  set +e
  recover_runtime_intent
  die "interrupted by SIG$signal during a runtime mutation; the recorded intent was reapplied"
}

handle_activation_exit() {
  local status=$?
  trap - HUP INT TERM EXIT
  [[ "$activation_mutation_in_flight" == true ]] || return "$status"
  activation_mutation_in_flight=false
  set +e
  recover_runtime_intent
  die "exited during a runtime mutation; the recorded intent was reapplied"
}

install_activation_signal_handlers() {
  trap 'handle_activation_signal HUP' HUP
  trap 'handle_activation_signal INT' INT
  trap 'handle_activation_signal TERM' TERM
  trap 'handle_activation_exit' EXIT
}

main() {
  install_activation_signal_handlers
  [[ "$(id -u)" == "0" ]] || die "must run as root"
  install -d -o root -g root -m 0700 "$RELEASES_DIR" "$INCOMING_DIR" "$STATE_DIR" "$SECRET_GENERATIONS_DIR"
  install -d -o root -g "$WORKER_GID" -m 0750 "$RUNTIME_SECRET_GENERATIONS_DIR"
  exec 9>"$STATE_DIR/deploy.lock"
  flock -n 9 || die "another deployment owns the rollout lock"
  case "${1:-}" in
    stage-candidate) [[ $# == 4 ]] || die "stage-candidate requires release SHA, archive and digest"; recover_transition; stage_candidate "$2" "$3" "$4" ;;
    promote-pending) [[ $# == 2 ]] || die "promote-pending requires release SHA"; promote_pending "$2" ;;
    abort-pending) [[ $# == 2 ]] || die "abort-pending requires release SHA"; abort_pending "$2" ;;
    inspect-state) [[ $# == 1 ]] || die "inspect-state accepts no arguments"; inspect_state ;;
    reconcile-state) [[ $# == 1 ]] || die "reconcile-state accepts no arguments"; reconcile_state ;;
    compensate-last-transition) [[ $# == 2 ]] || die "compensate-last-transition requires release SHA"; compensate_last_transition "$2" ;;
    finalize-last-transition) [[ $# == 2 ]] || die "finalize-last-transition requires release SHA"; finalize_last_transition "$2" ;;
    start-current) [[ $# == 1 ]] || die "start-current accepts no arguments"; recover_transition; start_pointer "$CURRENT_POINTER" ;;
    stop-current) [[ $# == 1 ]] || die "stop-current accepts no arguments"; recover_transition; stop_pointer "$CURRENT_POINTER" ;;
    set-emergency-stop) [[ $# == 2 ]] || die "set-emergency-stop requires true or false"; set_emergency_stop "$2" ;;
    *) die "expected stage-candidate, promote-pending, abort-pending, inspect-state, reconcile-state, compensate-last-transition, finalize-last-transition, start-current, stop-current or set-emergency-stop" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
