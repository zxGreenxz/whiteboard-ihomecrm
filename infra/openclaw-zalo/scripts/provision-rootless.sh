#!/bin/sh
set -eu

runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runner_user=${OPENCLAW_RUNNER_USER:-openclaw-runner}

[ "$(id -u)" -eq 0 ] || { echo "provisioning requires root" >&2; exit 1; }
mountpoint -q "$runtime_root" || {
  echo "$runtime_root must be a pre-provisioned fixed-size filesystem" >&2
  exit 1
}
runtime_kib=$(df -Pk "$runtime_root" | awk 'NR==2 {print $2}')
[ "$runtime_kib" -le 20971520 ] || { echo "runtime filesystem exceeds 20 GiB" >&2; exit 1; }

if ! id "$runner_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh "$runner_user"
fi
runner_uid=$(id -u "$runner_user")
runner_home=$(getent passwd "$runner_user" | cut -d: -f6)

install -d -m 0700 -o "$runner_user" -g "$runner_user" \
  "$runtime_root/docker" "$runtime_root/cells" "$runtime_root/config" \
  "$runtime_root/secrets" "$runtime_root/logs" "$runtime_root/operations"
install -d -m 0700 -o "$runner_user" -g "$runner_user" "$runner_home/.config/docker"

daemon_config="$runner_home/.config/docker/daemon.json"
tmp_config="$daemon_config.tmp.$$"
printf '{"data-root":"%s","log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}\n' \
  "$runtime_root/docker" >"$tmp_config"
chown "$runner_user:$runner_user" "$tmp_config"
chmod 0600 "$tmp_config"
mv -f "$tmp_config" "$daemon_config"

loginctl enable-linger "$runner_user"
runuser -u "$runner_user" -- env \
  HOME="$runner_home" \
  XDG_RUNTIME_DIR="/run/user/$runner_uid" \
  DOCKER_HOST="unix:///run/user/$runner_uid/docker.sock" \
  dockerd-rootless-setuptool.sh install
runuser -u "$runner_user" -- env XDG_RUNTIME_DIR="/run/user/$runner_uid" \
  systemctl --user enable --now docker.service

echo "dedicated rootless Docker provisioned for $runner_user"
