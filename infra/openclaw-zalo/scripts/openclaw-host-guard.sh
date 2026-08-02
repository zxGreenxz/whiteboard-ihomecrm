#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "invalid host guard argument" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ "${runtime_env#/}" != "$runtime_env" ] && [ -f "$runtime_env" ] && [ ! -L "$runtime_env" ] || {
  echo "--runtime-env must be an absolute regular metadata file" >&2
  exit 64
}
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
organization_id=$(sed -n 's/^OPENCLAW_ORGANIZATION_ID=//p' "$runtime_env")
watchdog_url=$(sed -n 's/^OPENCLAW_WATCHDOG_EDGE_URL=//p' "$runtime_env")
key_generation=$(sed -n 's/^OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION=//p' "$runtime_env")
[ "$(grep -c '^OPENCLAW_CELL_ID=' "$runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_ORGANIZATION_ID=' "$runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_WATCHDOG_EDGE_URL=' "$runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION=' "$runtime_env")" -eq 1 ] || exit 64
printf '%s\n' "$key_generation" | grep -Eq '^[1-9][0-9]{0,15}$' || {
  echo "watchdog signing key generation is invalid" >&2
  exit 64
}
valid_uuid() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; }
valid_uuid "$cell_id" && valid_uuid "$organization_id" || { echo "host guard identities are invalid" >&2; exit 64; }
case "$watchdog_url" in
  https://*/functions/v1/openclaw-watchdog|https://*/functions/v1/openclaw-watchdog/) ;;
  *) echo "host guard requires the dedicated watchdog Edge URL" >&2; exit 64 ;;
esac
case "$watchdog_url" in *gateway*|*:18789/*|*:3000/*|*:8080/*) echo "Gateway URLs are forbidden" >&2; exit 64 ;; esac

docker_host=${DOCKER_HOST:-}
case "$docker_host" in unix:///run/user/*/docker.sock) ;; *) echo "rootless DOCKER_HOST is required" >&2; exit 64 ;; esac
uid_part=${docker_host#unix:///run/user/}; uid_part=${uid_part%/docker.sock}
[ "$uid_part" = "$(id -u)" ] || { echo "DOCKER_HOST must belong to this runner" >&2; exit 64; }

operations_dir="$runtime_root/operations/$cell_id"
state_file="$operations_dir/host-guard.state"
pause_file="$operations_dir/host-guard.pause"
metrics_file="$runtime_root/operations/host/model-endpoint.metrics"
# Khoá KÝ Ed25519 riêng của host, KHÔNG phải bearer dùng chung: bearer replay được
# và không chứng minh được operation/body/tổ chức/thế hệ khoá. Khoá riêng chỉ được
# openssl đọc từ file 0400, không bao giờ vào argv hay biến môi trường.
signing_key_file="$runtime_root/secrets/$cell_id/openclaw_watchdog_envelope_key.pem"
install -d -m 0700 "$operations_dir"
[ -f "$signing_key_file" ] && [ ! -L "$signing_key_file" ] && \
  [ "$(stat -c %a "$signing_key_file")" = "400" ] || {
  echo "watchdog signing key must be a 0400 regular file" >&2
  exit 1
}

now=$(date +%s)
violation_since=0
clear_since=0
trip_since=0
stopped=0
if [ -f "$state_file" ] && [ ! -L "$state_file" ]; then
  violation_since=$(sed -n 's/^violation_since=//p' "$state_file")
  clear_since=$(sed -n 's/^clear_since=//p' "$state_file")
  trip_since=$(sed -n 's/^trip_since=//p' "$state_file")
  stopped=$(sed -n 's/^stopped=//p' "$state_file")
fi
for value in "$violation_since" "$clear_since" "$trip_since" "$stopped"; do
  case "$value" in ''|*[!0-9]*) echo "host guard state is invalid" >&2; exit 1 ;; esac
done

ram_percent=$(awk '/MemTotal:/ {t=$2} /MemAvailable:/ {a=$2} END {if (!t) exit 1; printf "%.2f", ((t-a)*100)/t}' /proc/meminfo)
swap_percent=$(awk '/SwapTotal:/ {t=$2} /SwapFree:/ {f=$2} END {if (!t) print "0.00"; else printf "%.2f", ((t-f)*100)/t}' /proc/meminfo)
load_one=$(awk '{print $1}' /proc/loadavg)
set -- $(df -Pk / | awk 'NR==2 {print $2, $4}')
root_total_kib=$1
root_free_kib=$2
root_free_percent=$(awk -v free="$root_free_kib" -v total="$root_total_kib" 'BEGIN {printf "%.2f", (free*100)/total}')
root_free_gib=$(awk -v free="$root_free_kib" 'BEGIN {printf "%.2f", free/1048576}')

router_p95_regression=999
router_error_rate=100
metrics_age=999999
if [ -f "$metrics_file" ] && [ ! -L "$metrics_file" ]; then
  router_p95_regression=$(sed -n 's/^ROUTER_CLI_P95_REGRESSION_PERCENT=//p' "$metrics_file")
  router_error_rate=$(sed -n 's/^ROUTER_CLI_ERROR_RATE_PERCENT=//p' "$metrics_file")
  metrics_observed=$(sed -n 's/^OBSERVED_AT_EPOCH=//p' "$metrics_file")
  case "$metrics_observed" in ''|*[!0-9]*) metrics_observed=0 ;; esac
  metrics_age=$((now - metrics_observed))
fi

gt() { awk -v left="$1" -v right="$2" 'BEGIN {exit !(left > right)}'; }
lt() { awk -v left="$1" -v right="$2" 'BEGIN {exit !(left < right)}'; }

raw_reasons=
gt "$router_p95_regression" 20 && raw_reasons="${raw_reasons} router_p95"
gt "$router_error_rate" 1 && raw_reasons="${raw_reasons} router_errors"
[ "$metrics_age" -le 90 ] || raw_reasons="${raw_reasons} router_probe_stale"
gt "$ram_percent" 75 && raw_reasons="${raw_reasons} ram"
gt "$swap_percent" 10 && raw_reasons="${raw_reasons} swap"
gt "$load_one" 12 && raw_reasons="${raw_reasons} load"
if lt "$root_free_gib" 200 || lt "$root_free_percent" 20; then raw_reasons="${raw_reasons} root_disk"; fi

if [ -n "$raw_reasons" ]; then
  [ "$violation_since" -ne 0 ] || violation_since=$now
  clear_since=0
else
  violation_since=0
  [ "$clear_since" -ne 0 ] || clear_since=$now
fi

elapsed=$((now - violation_since))
trip_reasons=
case " $raw_reasons " in *" swap "*) trip_reasons="${trip_reasons} swap" ;; esac
case " $raw_reasons " in *" root_disk "*) trip_reasons="${trip_reasons} root_disk" ;; esac
if [ "$violation_since" -ne 0 ] && [ "$elapsed" -ge 300 ]; then
  for reason in router_p95 router_errors router_probe_stale; do
    case " $raw_reasons " in *" $reason "*) trip_reasons="${trip_reasons} $reason" ;; esac
  done
fi
if [ "$violation_since" -ne 0 ] && [ "$elapsed" -ge 900 ]; then
  for reason in ram load; do
    case " $raw_reasons " in *" $reason "*) trip_reasons="${trip_reasons} $reason" ;; esac
  done
fi

write_state() {
  tmp="$state_file.tmp.$$"
  umask 077
  printf 'violation_since=%s\nclear_since=%s\ntrip_since=%s\nstopped=%s\n' "$violation_since" "$clear_since" "$trip_since" "$stopped" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$state_file"
}

# Operation ID phải TẤT ĐỊNH theo (tổ chức, cell, trạng thái, fingerprint, mốc trip)
# để lần post lại sau khi mất phản hồi KHÔNG tạo incident/notification trùng.
# Dẫn xuất name-based bằng SHA-1 với domain separation chuỗi, rồi định dạng theo
# khuôn UUID v5 (nibble phiên bản = 5, biến thể = 10xx) cho khớp UUID_PATTERN mà
# Edge kiểm ([1-5]). Không dùng namespace nhị phân RFC 4122 — chỉ cần tất định,
# chống va chạm và đúng khuôn dạng.
OPERATION_ID_DOMAIN='ihome-openclaw-host-guard-operation-v1'
derive_operation_id() {
  digest=$(printf '%s\0%s\0%s\0%s\0%s\0%s' \
    "$OPERATION_ID_DOMAIN" "$organization_id" "$cell_id" "$1" "$2" "$3" \
    | sha1sum | cut -c1-32)
  printf '%s-%s-5%s-%s%s-%s\n' \
    "$(printf '%s' "$digest" | cut -c1-8)" \
    "$(printf '%s' "$digest" | cut -c9-12)" \
    "$(printf '%s' "$digest" | cut -c14-16)" \
    "$(printf '%s' "$digest" | cut -c17-17 | sed 's/^[0-3]/8/;s/^[4-7]/9/;s/^[89]/a/;s/^[a-f]/b/')" \
    "$(printf '%s' "$digest" | cut -c18-20)" \
    "$(printf '%s' "$digest" | cut -c21-32)"
}

ENVELOPE_DOMAIN='ihome-openclaw-watchdog-envelope-v1'
ENVELOPE_AUDIENCE='openclaw-watchdog-edge'
ENVELOPE_PATH='/functions/v1/openclaw-watchdog'

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Envelope phải là JCS: khoá sắp xếp tăng dần, không khoảng trắng. Thứ tự dưới đây
# ĐÃ sắp xếp — đổi tên trường thì phải sắp lại, nếu không Edge tính chữ ký khác.
build_envelope() {
  printf '{"audience":"%s","bodySha256":"%s","keyGeneration":%s,"method":"POST","nonce":"%s","operation":"host.guard","organizationId":"%s","path":"%s","timestamp":%s,"version":1}' \
    "$ENVELOPE_AUDIENCE" "$1" "$key_generation" "$2" "$organization_id" "$ENVELOPE_PATH" "$3"
}

# Nonce PHẢI mới mỗi lần gửi (kể cả khi post lại): nonce lặp bị Edge từ chối như
# replay nên lần thử lại sẽ không bao giờ vào được. Tính bất biến của tác động do
# operation_id tất định đảm nhiệm, không phải nonce.
post_guard() {
  guard_state=$1
  fingerprint=$2
  operation_id=$(derive_operation_id "$guard_state" "$fingerprint" "$trip_since")
  payload=$(printf '%s' "{\"version\":1,\"operation\":\"HOST_GUARD\",\"organizationId\":\"$organization_id\",\"operationId\":\"$operation_id\",\"observedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"cellId\":\"$cell_id\",\"state\":\"$guard_state\",\"fingerprint\":\"$fingerprint\",\"controls\":[\"PAUSE_OUTBOUND_AI_MEDIA\"],\"contentFreeMetrics\":{\"ramPercent\":$ram_percent,\"swapPercent\":$swap_percent,\"loadOne\":$load_one,\"rootFreePercent\":$root_free_percent,\"rootFreeGiB\":$root_free_gib,\"routerP95RegressionPercent\":$router_p95_regression,\"routerErrorRatePercent\":$router_error_rate}}")
  body_sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -r | cut -d' ' -f1)
  # KHÔNG dùng `curl --retry`: nó gửi lại y nguyên envelope cũ, mà nonce lặp thì
  # Edge từ chối như replay -> lần thử lại không bao giờ thành công. Mỗi lần thử
  # phải ký một envelope mới (nonce + timestamp mới) trên CÙNG payload, nên tác
  # động vẫn tất định theo operation_id.
  attempt=1
  while [ "$attempt" -le 3 ]; do
    nonce=$(cat /proc/sys/kernel/random/uuid)
    envelope=$(build_envelope "$body_sha256" "$nonce" "$(date -u +%s)")
    # Preimage có byte NUL nên KHÔNG dùng command substitution (nuốt NUL), và Ed25519
    # là thuật toán one-shot nên `openssl pkeyutl -rawin` đòi đầu vào SEEK được —
    # đọc từ pipe sẽ chết "unable to determine file size for oneshot operation".
    # Vì vậy ghi preimage ra file tạm rồi ký bằng -in. `trap` dọn file kể cả khi
    # unit bị kill giữa chừng.
    preimage_file="$operations_dir/host-guard.preimage.$$"
    trap 'rm -f "$preimage_file"' EXIT HUP INT TERM
    (umask 077; { printf '%s' "$ENVELOPE_DOMAIN"; printf '\000'; printf '%s' "$envelope"; } > "$preimage_file")
    # `sh` không có pipefail và `set -e` đã bị vô hiệu trong hàm này (call site dùng
    # `|| post_failed=1`), nên openssl hỏng sẽ ÂM THẦM cho ra chữ ký rỗng. Ký ở bước
    # riêng, kiểm mã thoát, rồi mới encode — hỏng khoá phải nói rõ là hỏng khoá.
    if ! openssl pkeyutl -sign -rawin -inkey "$signing_key_file" -in "$preimage_file" \
      > "$preimage_file.sig"
    then
      rm -f "$preimage_file" "$preimage_file.sig"
      trap - EXIT HUP INT TERM
      echo "watchdog envelope signing failed; check $signing_key_file" >&2
      return 2
    fi
    signature=$(base64url < "$preimage_file.sig")
    rm -f "$preimage_file" "$preimage_file.sig"
    trap - EXIT HUP INT TERM
    # base64url của chữ ký Ed25519 64 byte luôn dài đúng 86 ký tự, chỉ gồm [A-Za-z0-9_-].
    if [ "${#signature}" -ne 86 ] || printf '%s' "$signature" | grep -q '[^A-Za-z0-9_-]'; then
      echo "watchdog envelope signature is malformed" >&2
      return 2
    fi
    # Header đi qua stdin (`--config -`), KHÔNG qua argv: /proc/<pid>/cmdline đọc
    # được bởi mọi user cục bộ, và envelope+chữ ký còn dùng lại được trong 60 giây.
    if printf 'header = "Content-Type: application/json"\nheader = "X-OpenClaw-Watchdog-Envelope: %s"\nheader = "X-OpenClaw-Watchdog-Signature: %s"\n' \
      "$(printf '%s' "$envelope" | base64url)" "$signature" | \
      curl --config - --fail --silent --show-error --max-time 10 \
        --data-binary "$payload" "$watchdog_url" >/dev/null
    then
      return 0
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

post_failed=0

if [ -n "$trip_reasons" ]; then
  fingerprint=$(printf '%s' "$trip_reasons" | awk '{$1=$1; gsub(/ /,"-"); print "host-guard:" $0}')
  guard_state=STILL_TRIPPED
  if [ ! -f "$pause_file" ]; then
    trip_since=$now
    tmp="$pause_file.tmp.$$"
    umask 077
    printf 'version=1\nstate=PAUSED\nfingerprint=%s\nmanual_resume_permission=openclaw_zalo.manage_operations\n' "$fingerprint" > "$tmp"
    chmod 0600 "$tmp"
    mv -f "$tmp" "$pause_file"
    guard_state=TRIPPED
  fi
  [ "$trip_since" -ne 0 ] || trip_since=$now
  # FAIL-CLOSED: ghi mốc trip TRƯỚC khi gọi Edge. Nếu Edge chết, `set -e` từng
  # làm script thoát tại curl nên trip_since không bao giờ được lưu và mốc dừng
  # 10 phút không bao giờ tới. Giờ trạng thái cục bộ bền vững trước, việc báo
  # Edge không được phép ngăn cưỡng chế cục bộ.
  write_state
  post_guard "$guard_state" "$fingerprint" || post_failed=1
  if [ $((now - trip_since)) -ge 600 ] && [ "$stopped" -eq 0 ]; then
    /usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" docker compose \
      --project-name "openclaw-zalo-$cell_id" --env-file "$runtime_env" \
      -f "$infra_dir/compose.cell.yaml" stop --timeout 30 cell bridge
    stopped=1
  fi
elif [ -f "$pause_file" ] && [ "$clear_since" -ne 0 ] && [ $((now - clear_since)) -ge 900 ]; then
  # The marker deliberately remains. Only an operator with manage_operations
  # may clear it after reviewing the incident and resuming canonical controls.
  write_state
  post_guard CLEAR_PENDING "host-guard:clear-pending-manual-resume" || post_failed=1
fi

write_state

# Báo lỗi cho timer SAU khi đã cưỡng chế cục bộ xong, không phải thay cho nó.
if [ "$post_failed" -ne 0 ]; then
  echo "watchdog post failed; local host-guard enforcement already applied" >&2
  exit 1
fi
