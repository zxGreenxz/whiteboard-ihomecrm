#!/usr/bin/env bash
# Cài, đổi chế độ, xem trạng thái và gỡ plugin ihome-session-reset cho MỘT hồ sơ Hermes trong container.
#
# Chạy trên host VPS bằng root, từ bản repo đã ghim (script lấy plugin từ chính thư mục của nó):
#   bash ops.sh probe     --profile tkt                  # chỉ đọc: kiểm bề mặt Hermes plugin cần
#   bash ops.sh install   --profile tkt [--mode observe|daily|off] [--activate live|restart|none] [--apply]
#   bash ops.sh set-mode  daily|observe|off --profile owner [--apply]   # có hiệu lực ở tin kế tiếp
#   bash ops.sh status    --profile owner                # chỉ đọc: cấu hình, gateway, sổ, end_reason
#   bash ops.sh uninstall --profile owner [--purge-settings] [--activate restart|none] [--apply]
#
# Không có --apply thì chỉ in kế hoạch. Không in config.yaml/.env; chỉ đọc vài khóa của plugin.
set -euo pipefail

PLUGIN=ihome-session-reset
SETTINGS_KEY="plugins.entries.${PLUGIN}.settings"
PLUGIN_FILES=(plugin.yaml __init__.py policy.py hook.py)
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTED_COMMIT=d923a5eb487a17c0a68801bba9ef0f56c81040a8   # Hermes 0.22.2: bản đã đọc mã khi viết plugin
HERMES_PY=/opt/hermes/.venv/bin/python
REGISTER_MARK="$PLUGIN: đã đăng ký hook pre_gateway_dispatch"   # dòng log do register() ghi
GATEWAY_MARK="tiến trình gateway"                                 # chỉ tiến trình `hermes … gateway run`

CONTAINER=hermes-owner
WORKER=ihome-zalo-worker
PROFILE=""
MODE=""
ACTIVATE=live
APPLY=0
PURGE_SETTINGS=0
RESTARTED=0
IDLE_TIMEOUT="${IHOME_IDLE_TIMEOUT:-600}"     # chờ gateway hết lượt đang chạy (giây)
READY_TIMEOUT="${IHOME_READY_TIMEOUT:-300}"   # chờ gateway chạy lại và Zalo nối lại (giây)
LIVE_TIMEOUT="${IHOME_LIVE_TIMEOUT:-15}"      # chờ gateway ghi dòng đăng ký hook sau nạp nóng (giây)
KEEP_BACKUPS="${IHOME_KEEP_BACKUPS:-10}"      # số bản sao lưu giữ lại cho mỗi hồ sơ (có secret)
STOP_TIMEOUT=180                              # docker restart -t: thời gian drain trước SIGKILL
BACKUP_ROOT="${IHOME_BACKUP_ROOT:-/root/ihome-hermes-backups/session-reset}"

say() { printf '%s\n' "$*"; }
die() { printf 'DỪNG: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

COMMAND="${1:-}"
[ -n "$COMMAND" ] || usage
shift
if [ "$COMMAND" = set-mode ] && [ $# -gt 0 ] && [[ "$1" != --* ]]; then MODE="$1"; shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --profile|--mode|--activate|--container|--worker)
      [ $# -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || die "$1 cần một giá trị"
      case "$1" in
        --profile) PROFILE="$2" ;;
        --mode) MODE="$2" ;;
        --activate) ACTIVATE="$2" ;;
        --container) CONTAINER="$2" ;;
        --worker) WORKER="$2" ;;
      esac
      shift 2 ;;
    --purge-settings) PURGE_SETTINGS=1; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage ;;
    *) die "tham số lạ: $1" ;;
  esac
done
case "$COMMAND" in probe|install|set-mode|status|uninstall) ;; *) usage ;; esac
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "--profile <tên hồ sơ> bắt buộc (vd. tkt, owner)"
case "$ACTIVATE" in live|restart|none) ;; *) die "--activate phải là live|restart|none" ;; esac
[[ "$KEEP_BACKUPS" =~ ^[1-9][0-9]*$ ]] || die "IHOME_KEEP_BACKUPS phải là số nguyên dương"

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
# Hồ sơ gateway đọc từ Entrypoint + Cmd ghép lại (--profile có thể nằm ở Entrypoint).
GW_PROFILE="$(docker inspect -f '{{json .Config.Entrypoint}}{{"\n"}}{{json .Config.Cmd}}' "$CONTAINER" | python3 -c '
import json, sys
argv = []
for line in sys.stdin:
    line = line.strip()
    if line and line != "null":
        argv += json.loads(line) or []
profile = ""
if "gateway" in argv and "run" in argv[argv.index("gateway"):]:
    for flag in ("--profile", "-p"):
        if flag in argv and argv.index(flag) + 1 < len(argv):
            profile = argv[argv.index(flag) + 1]
print(profile)')"
GW_HOST="$HERMES_HOME_HOST/profiles/${GW_PROFILE:-_khong_co_}"

serves_profile() { [ -n "$GW_PROFILE" ] && [ "$GW_PROFILE" = "$PROFILE" ]; }

# ------------------------------------------------------------------ đọc trạng thái

# "<gateway_state> <active_agents> <zalo_personal.state> <start_time>" từ gateway_state.json.
gateway_state() {
  python3 - "$GW_HOST/gateway_state.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    print("unknown -1 unknown -")
    raise SystemExit
zalo = ((data.get("platforms") or {}).get("zalo_personal") or {}).get("state") or "none"
print(data.get("gateway_state") or "unknown", data.get("active_agents", -1), zalo, data.get("start_time") or "-")
PY
}

# Đọc vài khóa của plugin trong config.yaml của hồ sơ (không bao giờ in cả tệp). Venv Hermes không có
# PyYAML: đọc bằng hermes_yaml (bộ đọc của chính Hermes), dự phòng ruamel.yaml.
CONFIG_PY='
import json, sys
sys.path.insert(0, "/opt/hermes")
try:
    from hermes_yaml import safe_load
except Exception:
    from ruamel.yaml import YAML
    safe_load = YAML(typ="safe").load
path, plugin, what = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as handle:
    cfg = safe_load(handle) or {}
plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
entries = plugins.get("entries") if isinstance(plugins.get("entries"), dict) else {}
entry = entries.get(plugin) if isinstance(entries.get(plugin), dict) else {}
settings = entry.get("settings") if isinstance(entry.get("settings"), dict) else {}
enabled = [str(name) for name in (plugins.get("enabled") or [])]
mode = settings.get("mode")
if what == "mode":
    print("" if mode is None else "daily" if mode is True else "off" if mode is False else str(mode))
elif what == "enabled":
    print(plugin in enabled)
elif what == "enabled-without":
    print(json.dumps([name for name in enabled if name != plugin]))
else:
    gateway = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    print("plugins.enabled có plugin:", plugin in enabled)
    print("plugins.disabled có plugin:", plugin in (plugins.get("disabled") or []))
    print("plugins.isolation:", plugins.get("isolation", "in_process (mặc định)"))
    print("settings:", settings)
    print("có khối session_reset cũ:", "session_reset" in cfg or "session_reset" in gateway)
    print("timezone của hồ sơ:", cfg.get("timezone"))
'
config_py() { hx "$HERMES_PY" -c "$CONFIG_PY" "$PROFILE_IN/config.yaml" "$PLUGIN" "$1"; }
config_view() { config_py view; }

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

# Số dòng "đã đăng ký hook" mà chính tiến trình gateway ghi vào log của hồ sơ gateway.
gateway_register_count() {
  local log="$GW_HOST/logs/agent.log"
  [ -f "$log" ] || { echo 0; return 0; }
  grep -a -F -- "$REGISTER_MARK" "$log" | grep -c -F -- "$GATEWAY_MARK" || true
}

# Tiến trình hermes khác trong container ngoài gateway (vd. lượt CLI nghiệm thu `hermes --profile tkt
# chat`): docker restart sẽ giết chúng.
other_hermes() {
  docker top "$CONTAINER" -eo pid,args 2>/dev/null | awk 'NR > 1' \
    | grep -E 'hermes_cli\.main|(^|[ /])hermes( |$)' | grep -v -F 'gateway run' || true
}

# ------------------------------------------------------------------ probe (chỉ đọc)

probe() {
  say "== probe $CONTAINER / hồ sơ $PROFILE (gateway đang phục vụ: ${GW_PROFILE:-không có})"
  local commit failed=0 block view
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
  check gateway/run.py 'def _peek_session_state(self, session_key: str) -> Optional[SessionState]:'
  check gateway/authz_mixin.py 'def _delivery_adapter_for(self, source: Optional[SessionSource]):'
  check gateway/run_busy.py 'def _queue_depth(self, session_key: str, *, adapter: Any = None) -> int:'
  check gateway/run_busy.py 'def _is_goal_continuation_event(event_or_text: Any) -> bool:'
  check gateway/run_goals.py 'event._heartbeat_session_id = session_id'
  check gateway/session.py 'def lookup_by_session_key(self, session_key: str)'
  check gateway/session.py 'def set_session_metadata(self, session_key: str, key: str, value: Any) -> bool:'
  check gateway/session.py 'def reset_session(self, session_key: str, display_name: Optional[str] = None)'
  check gateway/session.py 'resume_pending: bool = False'
  check gateway/session_state.py 'update_prompt_pending: bool = False'
  check tools/async_delegation.py 'def has_live_for_session(session_key: str = "", origin_ui_session_id: str = "", parent_session_id: str = "") -> bool:'
  check tools/process_registry.py 'def has_active_for_session(self, session_key: str, max_active_age: Optional[float] = None) -> bool:'
  check tools/clarify_gateway.py 'def get_pending_for_session(session_key: str, *, include_choice_prompts: bool = False)'
  check tools/slash_confirm.py 'def get_pending(session_key: str) -> Optional[dict[str, Any]]:'
  check tools/approval.py 'def has_blocking_approval(session_key: str) -> bool:'
  check hermes_cli/plugins.py 'def get_config(self, key: str, default: Any = None) -> Any:'
  # Hook chạy trong chính task chủ phiên của adapter: guard + `_session_tasks[key]` đặt trước, task đó await
  # thẳng handler (bọc scope, không tạo task) → `_handle_message` → `_hm_admit_event` → hook (plugin chỉ
  # hoãn khi task chủ phiên là task KHÁC).
  check gateway/platforms/base.py 'self._session_tasks[session_key] = task'
  check gateway/platforms/base.py 'response = await self._message_handler(event)'
  check gateway/run_adapters.py 'return self._standalone_scoped(self._handle_message)'
  check gateway/run_adapters.py 'return await handler(*args)'
  check gateway/run_inbound.py '_admitted = await self._hm_admit_event(event)'
  check gateway/run_inbound.py 'event = await self._hm_pre_gateway_dispatch_hook(event, source)'
  check hermes_cli/plugins_dispatch.py 'ret = await (asyncio.wait_for(ret, timeout) if use_timeout else ret)'
  # Bất biến: hook không bị cắt thời gian (chạy tới khi xong) và /new không await trước khi nhả slot.
  block="$(hx sed -n '/^_HOOK_TIMEOUT_BOUNDED_HOOKS: set\[str\] = {/,/^}/p' /opt/hermes/hermes_cli/plugins_dispatch.py)"
  if [ -n "$block" ] && ! grep -q -F 'pre_gateway_dispatch' <<<"$block"; then
    say "  có    pre_gateway_dispatch không nằm trong _HOOK_TIMEOUT_BOUNDED_HOOKS"
  else
    say "  THIẾU pre_gateway_dispatch có thể bị cắt thời gian (_HOOK_TIMEOUT_BOUNDED_HOOKS)"; failed=1
  fi
  block="$(hx sed -n '/async def _handle_reset_command(self, event: MessageEvent)/,/self._release_running_agent_state(session_key)/p' /opt/hermes/gateway/slash_commands_session.py)"
  if grep -q -F 'self._release_running_agent_state(session_key)' <<<"$block" && ! grep -q -E '(^|[^A-Za-z_])await([^A-Za-z_]|$)' <<<"$block"; then
    say "  có    _handle_reset_command nhả slot trước await đầu tiên"
  else
    say "  THIẾU _handle_reset_command có await trước khi nhả slot"; failed=1
  fi
  if hx test -f /usr/share/zoneinfo/Asia/Ho_Chi_Minh; then
    say "  có    tzdata Asia/Ho_Chi_Minh"
  else
    say "  (không có tzdata: plugin dùng UTC+7 cố định)"
  fi
  view="$(config_view)"
  say "$view" | sed 's/^/  /'
  if grep -q '^plugins.isolation: host' <<<"$view"; then say "  THIẾU: plugins.isolation=host — hook chỉ nhận placeholder"; failed=1; fi
  [ "$failed" = 0 ] || die "bề mặt Hermes khác lúc viết plugin; không cài"
  say "probe: đạt"
}

# ------------------------------------------------------------------ gateway: chờ rảnh, khởi động lại an toàn

wait_idle() {
  local waited=0 state active zalo started
  while :; do
    read -r state active zalo started <<<"$(gateway_state)"
    if [ "$APPLY" != 1 ]; then say "[kế hoạch] chờ gateway rảnh (hiện: state=$state active_agents=$active zalo=$zalo)"; return 0; fi
    if [ "$state" = running ] && [ "$active" = 0 ]; then say "gateway rảnh (zalo_personal=$zalo)"; return 0; fi
    [ "$waited" -lt "$IDLE_TIMEOUT" ] || die "gateway chưa rảnh sau ${IDLE_TIMEOUT}s (state=$state active_agents=$active)"
    sleep 5
    waited=$((waited + 5))
  done
}

refuse_if_other_hermes() {
  local others
  others="$(other_hermes)"
  [ -z "$others" ] && return 0
  if [ "$APPLY" != 1 ]; then
    say "[kế hoạch] lúc này còn tiến trình hermes khác trong $CONTAINER (restart sẽ dừng lại):"
    say "$others"
    return 0
  fi
  die "còn tiến trình hermes khác trong $CONTAINER (vd. lượt CLI nghiệm thu); docker restart sẽ giết chúng — chạy lại khi xong:
$others"
}

# Thứ tự an toàn cho Zalo: KHÔNG đụng worker (giữ phiên đăng nhập Zalo; tin đến lúc gateway nghỉ nằm trong
# journal của worker); sidecar phải còn trỏ đúng namespace mạng của worker hiện tại; không còn tiến trình
# hermes nào khác (CLI nghiệm thu) trong container; chờ hết lượt đang chạy; SIGTERM với hạn 180 s cho
# gateway drain; chờ start_time mới, gateway chạy và Zalo nối lại.
restart_gateway() {
  local netmode worker_id waited=0 state active zalo before started
  netmode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")"
  worker_id="$(docker inspect -f '{{.Id}}' "$WORKER" 2>/dev/null || true)"
  [ -n "$worker_id" ] || die "không thấy $WORKER; không restart sidecar khi worker vắng"
  [ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" = true ] || die "$WORKER không chạy"
  [ "$netmode" = "container:$worker_id" ] || die "$CONTAINER trỏ $netmode, khác worker hiện tại; tạo lại sidecar theo infra/hermes-zalo-native/README.md, không docker restart"
  refuse_if_other_hermes
  wait_idle
  refuse_if_other_hermes
  read -r state active zalo before <<<"$(gateway_state)"
  act docker restart -t "$STOP_TIMEOUT" "$CONTAINER"
  [ "$APPLY" = 1 ] || return 0
  while :; do
    read -r state active zalo started <<<"$(gateway_state)"
    if [ "$started" != - ] && [ "$started" != "$before" ] && [ "$state" = running ] && [ "$zalo" = connected ]; then
      RESTARTED=1
      say "gateway chạy lại (start_time $before → $started), zalo_personal=connected"
      return 0
    fi
    [ "$waited" -lt "$READY_TIMEOUT" ] || die "sau ${READY_TIMEOUT}s gateway chưa sẵn sàng (state=$state zalo=$zalo start_time=$started); xem logs/agent.log"
    sleep 5
    waited=$((waited + 5))
  done
}

# `plugins enable` LUÔN gửi reload-plugins qua control socket khi gateway đang chạy: gateway nạp lại mọi
# plugin của hồ sơ (cả ihome-zalo-native), không có cờ tắt. Bằng chứng DUY NHẤT là dòng "đã đăng ký hook
# … (hồ sơ P, tiến trình gateway)" MỚI do chính tiến trình `hermes … gateway run` ghi vào log của hồ sơ.
# Output của lệnh enable chỉ để tham khảo: `gateway_transforms` có thể là activation của dashboard hay
# `hermes serve` chứ không phải gateway, còn câu "Gateway reloaded plugins" có cả khi plugin KHÔNG nạp được.
activate() {
  local cli_output="$1" before="$2" waited=0
  if ! serves_profile; then
    say "Không gateway nào phục vụ hồ sơ $PROFILE trong $CONTAINER (gateway: ${GW_PROFILE:-không có}); hook chỉ chạy khi có 'hermes --profile $PROFILE gateway run'."
    return 0
  fi
  case "$ACTIVATE" in
    none)
      say "Không khởi động lại. Lệnh enable đã gửi reload-plugins: gateway nạp được thì hook chạy ngay, không thì ở lần khởi động sau." ;;
    restart) restart_gateway ;;
    live)
      if [ "$APPLY" != 1 ]; then
        say "[kế hoạch] kích hoạt khi gateway ghi dòng đăng ký hook mới (tối đa ${LIVE_TIMEOUT}s); không thì khởi động lại có kiểm soát"
        return 0
      fi
      if grep -q -F 'gateway_transforms' <<<"$cli_output"; then
        say "Output có gateway_transforms (có thể của dashboard/hermes serve, chưa đủ): chờ dòng đăng ký hook của gateway."
      fi
      while [ "$waited" -lt "$LIVE_TIMEOUT" ]; do
        if [ "$(gateway_register_count)" -gt "$before" ]; then
          say "Gateway đã ghi dòng đăng ký hook mới (tiến trình gateway)."
          return 0
        fi
        sleep 1
        waited=$((waited + 1))
      done
      say "Không thấy dòng đăng ký hook mới của gateway sau ${LIVE_TIMEOUT}s; khởi động lại có kiểm soát."
      restart_gateway ;;
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

# Giữ KEEP_BACKUPS bản mới nhất của hồ sơ (tên là thời điểm UTC nên thứ tự tên là thứ tự thời gian).
prune_backups() {
  local base="$BACKUP_ROOT/$PROFILE" old
  [ -d "$base" ] || return 0
  find "$base" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' \
    | sort | head -n "-$KEEP_BACKUPS" | while read -r old; do act rm -rf -- "$base/$old"; done
}

verify() {
  say "== kiểm sau cài"
  local f state active zalo started
  for f in "${PLUGIN_FILES[@]}"; do
    if cmp -s "$SRC_DIR/$f" "$PLUGIN_HOST/$f"; then say "  khớp nguồn: $f"; else say "  LỆCH/THIẾU: $f"; fi
  done
  config_view | sed 's/^/  /'
  hermes_cli plugins list 2>&1 | grep -i -- "$PLUGIN" | sed 's/^/  plugins list: /' || say "  plugins list: không thấy $PLUGIN"
  if serves_profile; then
    read -r state active zalo started <<<"$(gateway_state)"
    say "  gateway: state=$state active_agents=$active zalo_personal=$zalo start_time=$started"
    grep -a -F -- "$PLUGIN:" "$PROFILE_HOST/logs/agent.log" 2>/dev/null | tail -n 5 | cut -c1-260 | sed 's/^/  log: /' || true
  fi
}

# ------------------------------------------------------------------ lệnh

install_plugin() {
  case "$MODE" in ""|daily|observe|off) ;; *) die "--mode phải là daily|observe|off" ;; esac
  probe
  local f dir uid gid out="" existing before
  for f in "${PLUGIN_FILES[@]}"; do [ -f "$SRC_DIR/$f" ] || die "thiếu $SRC_DIR/$f"; done
  existing="$(config_py mode)"
  dir="$(new_backup_dir)"
  uid="${OWNER%%:*}"
  gid="${OWNER##*:}"
  say "== cài $PLUGIN vào $PLUGIN_HOST (mode=${MODE:-giữ nguyên}, activate=$ACTIVATE)"
  # Định khởi động lại thì dừng trước mọi bước ghi nếu còn lượt CLI nghiệm thu trong container.
  if serves_profile && [ "$ACTIVATE" = restart ]; then refuse_if_other_hermes; fi
  # `plugins enable` nạp nóng cả gateway: chờ rảnh trước, kể cả khi không định khởi động lại.
  if serves_profile; then wait_idle; fi
  backup "$dir"
  act install -d -o "$uid" -g "$gid" -m 0755 "$PLUGIN_HOST"
  for f in "${PLUGIN_FILES[@]}"; do act install -o "$uid" -g "$gid" -m 0644 "$SRC_DIR/$f" "$PLUGIN_HOST/$f"; done
  # Ghi chế độ TRƯỚC khi bật để lần nạp đầu đã đúng mode. Không có --mode thì giữ giá trị đang có;
  # chỉ lần cài đầu (chưa có mode) mới đặt observe (chưa đổi phiên nào).
  if [ -n "$MODE" ]; then
    act hermes_cli config set "$SETTINGS_KEY.mode" "$MODE"
  elif [ -z "$existing" ]; then
    act hermes_cli config set "$SETTINGS_KEY.mode" observe
  else
    say "Giữ mode=$existing đang có (không có --mode)."
  fi
  before="$(gateway_register_count)"
  if [ "$APPLY" = 1 ]; then
    out="$(hermes_cli plugins enable "$PLUGIN" 2>&1)" || { say "$out"; die "plugins enable lỗi; sao lưu ở $dir"; }
    say "$out"
  else
    say "[kế hoạch] hermes --profile $PROFILE plugins enable $PLUGIN"
  fi
  activate "$out" "$before"
  prune_backups
  if [ "$APPLY" = 1 ]; then verify; fi
  say "Tắt tức thì (không restart): bash $0 set-mode off --profile $PROFILE --apply"
}

set_mode() {
  case "$MODE" in daily|observe|off) ;; *) die "set-mode daily|observe|off" ;; esac
  backup "$(new_backup_dir)"
  # Plugin đọc lại config.yaml ở mỗi tin (cache theo mtime): không cần nạp lại hay khởi động lại.
  act hermes_cli config set "$SETTINGS_KEY.mode" "$MODE"
  prune_backups
  if [ "$APPLY" = 1 ]; then config_view; fi
}

status() {
  say "== $PLUGIN / hồ sơ $PROFILE"
  if [ -d "$PLUGIN_HOST" ]; then say "thư mục plugin: có"; else say "thư mục plugin: KHÔNG"; fi
  verify
  local audit_file items
  audit_file="$(ls -1 "$PROFILE_HOST"/plugin-data/*"$PLUGIN"*/resets.jsonl 2>/dev/null | head -n 1 || true)"
  if [ -z "$audit_file" ]; then
    say "sổ plugin-data: chưa có (chưa có tin nào sau mốc kể từ khi bật)"
    return 0
  fi
  items="$(python3 - "$audit_file" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()[-10:]
except OSError as exc:
    print(f"(không đọc được sổ: {exc})")
    raise SystemExit
for line in lines:
    try:
        item = json.loads(line)
    except ValueError:
        print("(dòng hỏng, bỏ qua)")
        continue
    print(json.dumps(item, ensure_ascii=False))
PY
)"
  say "== 10 mục sổ gần nhất ($audit_file)"
  say "$items"
  say "== end_reason của phiên cũ trong state.db (chỉ đọc)"
  python3 -c '
import json, sys
for line in sys.stdin:
    try:
        item = json.loads(line)
    except ValueError:
        continue
    sid = item.get("old_session_id") if isinstance(item, dict) else None
    if sid:
        print(sid)' <<<"$items" | hxi "$HERMES_PY" -c "$LOOKUP_PY" "$PROFILE_IN/state.db" lookup
}

uninstall_plugin() {
  local dir out="" enabled
  dir="$(new_backup_dir)"
  say "== gỡ $PLUGIN khỏi hồ sơ $PROFILE (activate=$ACTIVATE)"
  backup "$dir"
  # Bước đầu: tắt ngay (plugin đọc lại config ở mỗi tin), nên dừng giữa chừng hay chạy lại đều an toàn.
  act hermes_cli config set "$SETTINGS_KEY.mode" off
  enabled="$(config_py enabled)"
  if [ "$enabled" = True ] && [ -d "$PLUGIN_HOST" ]; then
    if [ "$APPLY" = 1 ]; then
      out="$(hermes_cli plugins disable "$PLUGIN" 2>&1)" || { say "$out"; die "plugins disable lỗi; sao lưu ở $dir"; }
      say "$out"
    else
      say "[kế hoạch] hermes --profile $PROFILE plugins disable $PLUGIN"
    fi
  elif [ "$enabled" = True ]; then
    # Lần chạy trước đã chuyển thư mục đi: `plugins disable` không còn nhận ra plugin, bỏ khỏi danh sách.
    act hermes_cli config set plugins.enabled "$(config_py enabled-without)"
  else
    say "plugins.enabled không còn $PLUGIN."
  fi
  if [ -d "$PLUGIN_HOST" ]; then act mv "$PLUGIN_HOST" "$dir/plugin-removed"; fi
  # `plugins disable` không gửi reload-plugins: module còn trong gateway tới lần khởi động sau (mode off).
  if serves_profile && [ "$ACTIVATE" = restart ]; then
    restart_gateway
  elif serves_profile; then
    say "Hook đã tắt (mode off); module còn nạp trong gateway tới lần khởi động sau — dùng --activate restart để gỡ khỏi bộ nhớ ngay."
  fi
  if [ "$PURGE_SETTINGS" = 1 ]; then
    if ! serves_profile || [ "$RESTARTED" = 1 ] || [ "$APPLY" != 1 ]; then
      act hermes_cli config unset "plugins.entries.$PLUGIN"
    else
      say "Giữ plugins.entries.$PLUGIN (mode off): gateway còn nạp plugin, xoá cấu hình lúc này sẽ đưa nó về mặc định daily. Chạy lại với --purge-settings sau lần khởi động kế tiếp."
    fi
  fi
  prune_backups
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
