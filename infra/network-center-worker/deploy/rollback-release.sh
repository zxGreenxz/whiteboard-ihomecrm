#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

NETWORK_CENTER_ROOT="${NETWORK_CENTER_ROOT:-/opt/ihome-network-center}"
export NETWORK_CENTER_ROOT
# Installed stable activation library is resolved at runtime.
# shellcheck disable=SC1091
source "$NETWORK_CENTER_ROOT/bin/activate-release.sh"

rollback_main() {
  [[ "$(id -u)" == "0" ]] || die "must run as root"
  [[ $# == 0 ]] || die "rollback accepts no arguments"
  install -d -o root -g root -m 0700 "$STATE_DIR"
  exec 9>"$STATE_DIR/deploy.lock"
  flock -n 9 || die "another deployment owns the rollout lock"
  recover_transition
  validate_pointer "$CURRENT_POINTER"
  validate_pointer "$PREVIOUS_POINTER"

  local before old_current old_previous pending target target_pointer target_env after
  local target_sha target_image target_generation
  before="$(pointer_set_json)"
  old_current="$(printf '%s' "$before" | jq -c '.current')"
  old_previous="$(printf '%s' "$before" | jq -c '.previous')"
  pending="$(printf '%s' "$before" | jq -c '.pending')"
  target_env="$(printf '%s' "$old_previous" | jq -r '.releaseDirectory')/.env.rollback.$(date -u +%Y%m%dT%H%M%SZ).$$"
  make_release_env "$target_env" "$(printf '%s' "$old_previous" | jq -r '.releaseSha')" true
  target="$(printf '%s' "$old_previous" | jq -c --arg envFile "$target_env" \
    --arg projectName ihome-network-center --arg containerName ihome-network-center-worker \
    '.envFile=$envFile | .projectName=$projectName | .containerName=$containerName')"
  target_pointer="$(temporary_pointer_from_json "$target")"
  target_sha="$(pointer_value "$target_pointer" '.releaseSha')"
  target_image="$(pointer_value "$target_pointer" '.imageId')"
  target_generation="$(pointer_value "$target_pointer" '.secretGeneration')"
  after="$(jq -cn --argjson current "$target" --argjson previous "$old_current" \
    --argjson pending "$pending" '{current:$current,previous:$previous,pending:$pending}')"

  begin_transition rollback "$before" "$after" "$target"
  stop_pointer "$CURRENT_POINTER"
  failpoint rollback-after-current-stopped
  if ! (start_pointer "$target_pointer"); then
    converge_pointer_set "$before"
    rm -f -- "$TRANSITION_FILE" "$target_pointer" "$target_env"
    die "previous release failed health readback; current release restored"
  fi
  mark_transition_commit_intent
  apply_transition_after
  pointer_exact_healthy "$CURRENT_POINTER" || die "committed rollback state is not exact healthy"
  commit_transition
  rm -f -- "$target_pointer"
  jq -cn --arg releaseSha "$target_sha" --arg imageId "$target_image" \
    --arg secretGeneration "$target_generation" \
    '{schemaVersion:2,releaseSha:$releaseSha,imageId:$imageId,
      secretGeneration:$secretGeneration,rollback:"healthy",finalization:"required"}'
}

rollback_main "$@"
