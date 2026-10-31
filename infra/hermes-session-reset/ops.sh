#!/usr/bin/env bash
# Cài, đổi chế độ, xem trạng thái và gỡ plugin ihome-session-reset cho MỘT hồ sơ Hermes trong container.
#
# Chạy trên host VPS bằng root, từ bản repo đã ghim (script lấy plugin từ chính thư mục của nó):
#   bash ops.sh probe     --profile tkt                  # chỉ đọc: kiểm bề mặt Hermes plugin cần
#   bash ops.sh install   --profile tkt [--mode observe|daily|off] [--activate live|restart|none] [--apply]
#   bash ops.sh set-mode  daily|observe|off --profile owner [--apply]   # có hiệu lực ở tin kế tiếp
#   bash ops.sh status    --profile owner                # chỉ đọc: cấu hình, gateway, sổ, end_reason
#   bash ops.sh uninstall --profile owner [--purge-settings] [--activate live|restart|none] [--apply]
#
# Không có --apply thì chỉ in kế hoạch. Không in config.yaml/.env; chỉ đọc vài khóa của plugin.
set -euo pipefail

PLUGIN=ihome-session-reset
SETTINGS_KEY="plugins.entries.${PLUGIN}.settings"
PLUGIN_FILES=(plugin.yaml __init__.py policy.py hook.py)
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTED_COMMIT=d923a5eb487a17c0a68801bba9ef0f56c81040a8   # Hermes 0.22.2: bản đã đọc mã khi viết plugin
HERMES_PY=/opt/hermes/.venv/bin/python

CONTAINER=hermes-owner
WORKER=ihome-zalo-worker
PROFILE=""
MODE=""
ACTIVATE=live
APPLY=0
PURGE_SETTINGS=0
IDLE_TIMEOUT="${IHOME_IDLE_TIMEOUT:-600}"     # chờ gateway hết lượt đang chạy (giây)
READY_TIMEOUT="${IHOME_READY_TIMEOUT:-300}"   # chờ gateway chạy lại và Zalo nối lại (giây)
STOP_TIMEOUT=180                              # docker restart -t: thời gian drain trước SIGKILL
BACKUP_ROOT="${IHOME_BACKUP_ROOT:-/root/ihome-hermes-backups/session-reset}"

say() { printf '%s\n' "$*"; }
die() { printf 'DỪNG: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

COMMAND="${1:-}"
[ -n "$COMMAND" ] || usage
shift
if [ "$COMMAND" = set-mode ] && [ $# -gt 0 ]; then MODE="$1"; shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --activate) ACTIVATE="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --worker) WORKER="${2:-}"; shift 2 ;;
    --purge-settings) PURGE_SETTINGS=1; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage ;;
    *) die "tham số lạ: $1" ;;
  esac
done
case "$COMMAND" in probe|install|set-mode|status|uninstall) ;; *) usage ;; esac
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "--profile <tên hồ sơ> bắt buộc (vd. tkt, owner)"
case "$ACTIVATE" in live|restart|none) ;; *) die "--activate phải là live|restart|none" ;; esac

# Lệnh ghi/đổi chỉ chạy khi có --apply; không thì in kế hoạch.
act() {
  if [ "$APPLY" = 1 ]; then
    say "+ $*"
    "$@"
  else
    say "[kế hoạch] $*"
  fi
}

hx() { docker exec "$CONTAINER" "$@"; }
hxi() { docker exec -i "$CONTAINER" "$@"; }
hermes_cli() { docker exec "$CONTAINER" hermes --profile "$PROFILE" "$@"; }

# ------------------------------------------------------------------ đường dẫn (lấy từ docker inspect)

docker inspect "$CONTAINER" >/dev/null 2>&1 || die "không thấy container $CONTAINER"
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true ] || die "$CONTAINER không chạy"
HOME_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/hermes"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ -n "$HOME_MOUNT" ] || die "$CONTAINER không bind /home/hermes"
HERMES_HOME_IN="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n 's/^HERMES_HOME=//p')"
HERMES_HOME_IN="${HERMES_HOME_IN:-/home/hermes/.hermes}"
case "$HERMES_HOME_IN" in /home/hermes/*) ;; *) die "HERMES_HOME=$HERMES_HOME_IN không nằm trong /home/hermes" ;; esac
HERMES_HOME_HOST="${HOME_MOUNT}${HERMES_HOME_IN#/home/hermes}"
PROFILE_IN="$HERMES_HOME_IN/profiles/$PROFILE"
PROFILE_HOST="$HERMES_HOME_HOST/profiles/$PROFILE"
PLUGIN_HOST="$PROFILE_HOST/plugins/$PLUGIN"
[ -f "$PROFILE_HOST/config.yaml" ] || die "không thấy hồ sơ $PROFILE ($PROFILE_HOST/config.yaml)"
OWNER="$(docker inspect -f '{{.Config.User}}' "$CONTAINER")"
[[ "$OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die "user của $CONTAINER phải dạng uid:gid, đang là '$OWNER'"
GW_PROFILE="$(docker inspect -f '{{json .Config.Cmd}}' "$CONTAINER" | python3 -c '
import json, sys
cmd = json.load(sys.stdin) or []
print(cmd[cmd.index("--profile") + 1] if "--profile" in cmd and "gateway" in cmd else "")')"
GW_HOST="$HERMES_HOME_HOST/profiles/${GW_PROFILE:-_khong_co_}"

serves_profile() { [ -n "$GW_PROFILE" ] && [ "$GW_PROFILE" = "$PROFILE" ]; }

# ------------------------------------------------------------------ đọc trạng thái

# "<gateway_state> <active_agents> <zalo_personal.state>" từ gateway_state.json của hồ sơ gateway.
gateway_state() {
  python3 - "$GW_HOST/gateway_state.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("unknown -1 unknown")
    raise SystemExit
zalo = ((data.get("platforms") or {}).get("zalo_personal") or {}).get("state") or "none"
print(data.get("gateway_state") or "unknown", data.get("active_agents", -1), zalo)
PY
}

last_start() { tail -n 1 "$GW_HOST/gateway-starts.log" 2>/dev/null | cut -d. -f1 || true; }

# Chỉ in các khóa liên quan (không bao giờ in cả config.yaml). Venv Hermes không có PyYAML: đọc bằng
# hermes_yaml (bộ đọc của chính Hermes), dự phòng ruamel.yaml.
config_view() {
  hxi "$HERMES_PY" - "$PROFILE_IN/config.yaml" "$PLUGIN" <<'PY'
import sys
sys.path.insert(0, "/opt/hermes")
try:
    from hermes_yaml import safe_load
except Exception:
    from ruamel.yaml import YAML
    safe_load = YAML(typ="safe").load
with open(sys.argv[1], encoding="utf-8") as handle:
    cfg = safe_load(handle) or {}
plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
entry = (plugins.get("entries") or {}).get(sys.argv[2]) or {}
print("plugins.enabled có plugin:", sys.argv[2] in (plugins.get("enabled") or []))
print("plugins.disabled có plugin:", sys.argv[2] in (plugins.get("disabled") or []))
print("plugins.isolation:", plugins.get("isolation", "in_process (mặc định)"))
print("settings:", entry.get("settings") if isinstance(entry, dict) else entry)
gateway = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
print("có khối session_reset cũ:", "session_reset" in cfg or "session_reset" in gateway)
print("timezone của hồ sơ:", cfg.get("timezone"))
PY
}

# Tra end_reason (chỉ đọc, mode=ro) cho các id phiên cũ đọc từ stdin, mỗi dòng một id.
LOOKUP_PY='
import re, sqlite3, sys
ids = [line.strip() for line in sys.stdin if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", line.strip())]
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
for sid in ids:
    row = con.execute("SELECT end_reason FROM sessions WHERE id = ?", (sid,)).fetchone()
    nxt = con.execute("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC LIMIT 1",
                      (sid,)).fetchone()
    print(sid, "end_reason=" + str(row[0] if row else "(không có hàng)"), "phiên kế=" + (nxt[0] if nxt else "-"))
'

# ------------------------------------------------------------------ probe (chỉ đọc)

probe() {
  say "== probe $CONTAINER / hồ sơ $PROFILE (gateway đang phục vụ: ${GW_PROFILE:-không có})"
  local commit failed=0
  commit="$(hx cat /opt/hermes/install-stamp.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("commit",""), d.get("displayVersion",""))')"
  say "Hermes: $commit"
  [ "${commit%% *}" = "$TESTED_COMMIT" ] || say "CẢNH BÁO: khác bản đã đọc mã ($TESTED_COMMIT); xem kỹ các điểm dưới"
  check() {
    if hx grep -q -F -- "$2" "/opt/hermes/$1"; then say "  có    $1: $2"; else say "  THIẾU $1: $2"; failed=1; fi
  }
  check hermes_cli/plugins.py '"pre_gateway_dispatch", "post_gateway_admission"'
  check gateway/run_inbound.py '"pre_gateway_dispatch", event=event, gateway=self,'
  check gateway/slash_commands_session.py 'async def _handle_reset_command(self, event: MessageEvent)'
  check gateway/slash_commands_session.py '_title_arg = event.get_command_args().strip()'
  check gateway/run.py 'def _session_key_for_source(self, source: SessionSource) -> str:'
  check gateway/run.py 'def _is_session_running(self, session_key: str) -> bool:'
  check gateway/run.py 'def _is_user_authorized_for_source('
  check gateway/session.py 'def lookup_by_session_key(self, session_key: str)'
  check gateway/session.py 'def set_session_metadata(self, session_key: str, key: str, value: Any) -> bool:'
  check gateway/session.py 'def reset_session(self, session_key: str, display_name: Optional[str] = None)'
  check hermes_cli/plugins.py 'def get_config(self, key: str, default: Any = None) -> Any:'
  if hx test -f /usr/share/zoneinfo/Asia/Ho_Chi_Minh; then
    say "  có    tzdata Asia/Ho_Chi_Minh"
  else
    say "  (không có tzdata: plugin dùng UTC+7 cố định)"
  fi
  local view
  view="$(config_view)"
  say "$view" | sed 's/^/  /'
  if grep -q '^plugins.isolation: host' <<<"$view"; then say "  THIẾU: plugins.isolation=host — hook chỉ nhận placeholder"; failed=1; fi
  [ "$failed" = 0 ] || die "bề mặt Hermes khác lúc viết plugin; không cài"
  say "probe: đạt"
}

# ------------------------------------------------------------------ gateway: chờ rảnh, khởi động lại an toàn

wait_idle() {
  local waited=0 state active zalo
  while :; do
    read -r state active zalo <<<"$(gateway_state)"
    if [ "$APPLY" != 1 ]; then say "[kế hoạch] chờ gateway rảnh (hiện: state=$state active_agents=$active zalo=$zalo)"; return 0; fi
    if [ "$state" = running ] && [ "$active" = 0 ]; then say "gateway rảnh (zalo_personal=$zalo)"; return 0; fi
    [ "$waited" -lt "$IDLE_TIMEOUT" ] || die "gateway chưa rảnh sau ${IDLE_TIMEOUT}s (state=$state active_agents=$active)"
    sleep 5
    waited=$((waited + 5))
  done
}

# Thứ tự an toàn cho Zalo: KHÔNG đụng worker (giữ phiên đăng nhập Zalo; tin đến lúc gateway nghỉ nằm trong
# journal của worker); sidecar phải còn trỏ đúng namespace mạng của worker hiện tại; chờ hết lượt đang chạy;
# SIGTERM với hạn 180 s cho gateway drain; chờ gateway ghi lần khởi động mới và Zalo nối lại.
restart_gateway() {
  local netmode worker_id before waited=0 state active zalo started
  netmode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")"
  worker_id="$(docker inspect -f '{{.Id}}' "$WORKER" 2>/dev/null || true)"
  [ -n "$worker_id" ] || die "không thấy $WORKER; không restart sidecar khi worker vắng"
  [ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" = true ] || die "$WORKER không chạy"
  [ "$netmode" = "container:$worker_id" ] || die "$CONTAINER trỏ $netmode, khác worker hiện tại; tạo lại sidecar theo infra/hermes-zalo-native/README.md, không docker restart"
  wait_idle
  before="$(last_start)"
  act docker restart -t "$STOP_TIMEOUT" "$CONTAINER"
  [ "$APPLY" = 1 ] || return 0
  while :; do
    read -r state active zalo <<<"$(gateway_state)"
    started="$(last_start)"
    if [ -n "$started" ] && [ "$started" != "$before" ] && [ "$state" = running ] && [ "$zalo" = connected ]; then
      say "gateway chạy lại, zalo_personal=connected"
      return 0
    fi
    [ "$waited" -lt "$READY_TIMEOUT" ] || die "sau ${READY_TIMEOUT}s gateway chưa sẵn sàng (state=$state zalo=$zalo); xem logs/agent.log"
    sleep 5
    waited=$((waited + 5))
  done
}

# live: `plugins enable` tự gửi reload-plugins qua control socket, hook có hiệu lực ngay không restart;
# gateway không xác nhận (hoặc lệnh không gửi, như `plugins disable`) thì khởi động lại có kiểm soát.
activate() {
  local cli_output="$1"
  if ! serves_profile; then
    say "Không gateway nào phục vụ hồ sơ $PROFILE trong $CONTAINER (gateway: ${GW_PROFILE:-không có}); hook chỉ chạy khi có 'hermes --profile $PROFILE gateway run'."
    return 0
  fi
  case "$ACTIVATE" in
    none) say "Bỏ qua kích hoạt (--activate none): gateway nạp lại plugin ở lần khởi động sau." ;;
    restart) restart_gateway ;;
    live)
      if [ "$APPLY" != 1 ]; then
        say "[kế hoạch] nếu gateway không in 'Gateway reloaded plugins' thì khởi động lại có kiểm soát"
      elif ! grep -q 'Gateway reloaded plugins' <<<"$cli_output"; then
        say "Gateway không xác nhận nạp lại; chuyển sang khởi động lại có kiểm soát."
        restart_gateway
      fi ;;
  esac
}

new_backup_dir() { printf '%s/%s/%s' "$BACKUP_ROOT" "$PROFILE" "$(date -u +%Y%m%dT%H%M%SZ)"; }

# Thư mục riêng của root: umask 077 cho cả thư mục cha mới tạo, chmod cho thư mục cuối.
mkdir_private() { (umask 077 && mkdir -p "$1") && chmod 700 "$1"; }

backup() {
  local dir="$1"
  act mkdir_private "$dir"
  act cp -p "$PROFILE_HOST/config.yaml" "$dir/config.yaml"
  if [ -d "$PLUGIN_HOST" ]; then act cp -a "$PLUGIN_HOST" "$dir/plugin"; fi
  say "Sao lưu: $dir (ngoài HERMES_HOME, root 0700; config.yaml chứa secret, không chép đi nơi khác)"
}

verify() {
  say "== kiểm sau cài"
  local f state active zalo
  for f in "${PLUGIN_FILES[@]}"; do
    if cmp -s "$SRC_DIR/$f" "$PLUGIN_HOST/$f"; then say "  khớp nguồn: $f"; else say "  LỆCH/THIẾU: $f"; fi
  done
  config_view | sed 's/^/  /'
  hermes_cli plugins list 2>&1 | grep -i -- "$PLUGIN" | sed 's/^/  plugins list: /' || say "  plugins list: không thấy $PLUGIN"
  if serves_profile; then
    read -r state active zalo <<<"$(gateway_state)"
    say "  gateway: state=$state active_agents=$active zalo_personal=$zalo"
    grep -a -F -- "$PLUGIN:" "$PROFILE_HOST/logs/agent.log" 2>/dev/null | tail -n 5 | cut -c1-260 | sed 's/^/  log: /' || true
  fi
}

# ------------------------------------------------------------------ lệnh

install_plugin() {
  MODE="${MODE:-observe}"
  case "$MODE" in daily|observe|off) ;; *) die "--mode phải là daily|observe|off" ;; esac
  probe
  local f dir uid gid out=""
  for f in "${PLUGIN_FILES[@]}"; do [ -f "$SRC_DIR/$f" ] || die "thiếu $SRC_DIR/$f"; done
  dir="$(new_backup_dir)"
  uid="${OWNER%%:*}"
  gid="${OWNER##*:}"
  say "== cài $PLUGIN vào $PLUGIN_HOST (mode=$MODE, activate=$ACTIVATE)"
  if serves_profile && [ "$ACTIVATE" != none ]; then wait_idle; fi
  backup "$dir"
  act install -d -o "$uid" -g "$gid" -m 0755 "$PLUGIN_HOST"
  for f in "${PLUGIN_FILES[@]}"; do act install -o "$uid" -g "$gid" -m 0644 "$SRC_DIR/$f" "$PLUGIN_HOST/$f"; done
  # Ghi chế độ TRƯỚC khi bật để lần nạp đầu đã đúng mode (observe = chưa đổi phiên nào).
  act hermes_cli config set "$SETTINGS_KEY.mode" "$MODE"
  if [ "$APPLY" = 1 ]; then
    out="$(hermes_cli plugins enable "$PLUGIN" 2>&1)" || { say "$out"; die "plugins enable lỗi; sao lưu ở $dir"; }
    say "$out"
  else
    say "[kế hoạch] hermes --profile $PROFILE plugins enable $PLUGIN"
  fi
  activate "$out"
  if [ "$APPLY" = 1 ]; then verify; fi
  say "Tắt tức thì (không restart): bash $0 set-mode off --profile $PROFILE --apply"
}

set_mode() {
  case "$MODE" in daily|observe|off) ;; *) die "set-mode daily|observe|off" ;; esac
  backup "$(new_backup_dir)"
  # Plugin đọc lại config.yaml ở mỗi tin (cache theo mtime): không cần nạp lại hay khởi động lại.
  act hermes_cli config set "$SETTINGS_KEY.mode" "$MODE"
  if [ "$APPLY" = 1 ]; then config_view; fi
}

status() {
  say "== $PLUGIN / hồ sơ $PROFILE"
  if [ -d "$PLUGIN_HOST" ]; then say "thư mục plugin: có"; else say "thư mục plugin: KHÔNG"; fi
  verify
  local state_file items
  state_file="$(ls -1 "$PROFILE_HOST"/plugin-data/*"$PLUGIN"*/state.json 2>/dev/null | head -n 1 || true)"
  if [ -z "$state_file" ]; then
    say "sổ plugin-data: chưa có (chưa có tin nào sau mốc kể từ khi bật)"
    return 0
  fi
  items="$(python3 - "$state_file" <<'PY'
import json, sys
for item in (json.load(open(sys.argv[1], encoding="utf-8")).get("resets") or [])[-10:]:
    print(json.dumps(item, ensure_ascii=False))
PY
)"
  say "== 10 mục sổ gần nhất ($state_file)"
  say "$items"
  say "== end_reason của phiên cũ trong state.db (chỉ đọc)"
  python3 -c '
import json, sys
for line in sys.stdin:
    sid = json.loads(line).get("old_session_id")
    if sid:
        print(sid)' <<<"$items" | hxi "$HERMES_PY" -c "$LOOKUP_PY" "$PROFILE_IN/state.db"
}

uninstall_plugin() {
  local dir out=""
  dir="$(new_backup_dir)"
  say "== gỡ $PLUGIN khỏi hồ sơ $PROFILE (activate=$ACTIVATE)"
  if serves_profile && [ "$ACTIVATE" != none ]; then wait_idle; fi
  backup "$dir"
  if [ "$APPLY" = 1 ]; then
    out="$(hermes_cli plugins disable "$PLUGIN" 2>&1)" || { say "$out"; die "plugins disable lỗi; sao lưu ở $dir"; }
    say "$out"
  else
    say "[kế hoạch] hermes --profile $PROFILE plugins disable $PLUGIN"
  fi
  if [ -d "$PLUGIN_HOST" ]; then act mv "$PLUGIN_HOST" "$dir/plugin-removed"; fi
  if [ "$PURGE_SETTINGS" = 1 ]; then act hermes_cli config unset "plugins.entries.$PLUGIN"; fi
  # `plugins disable` không gửi reload-plugins: hook còn trong gateway tới lần khởi động lại.
  activate "$out"
  if [ "$APPLY" = 1 ]; then config_view; fi
  say "Phiên đã làm mới không tự quay lại; muốn về phiên cũ thì gõ /resume <old_session_id> (id trong status)."
}

case "$COMMAND" in
  probe) probe ;;
  install) install_plugin ;;
  set-mode) set_mode ;;
  status) status ;;
  uninstall) uninstall_plugin ;;
esac
