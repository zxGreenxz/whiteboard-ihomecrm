"""``ops.sh`` với ``docker`` giả: kế hoạch không ghi gì, --apply chép/sao lưu/bật, rơi về restart an toàn.

``docker`` giả trả lời đúng các câu ``ops.sh`` hỏi (inspect, top, exec cat/grep/sed/python/hermes, restart),
giữ trạng thái ``mode``/``enabled`` của plugin theo hồ sơ như ``hermes config set``/``plugins enable``, và
ghi lại mọi lệnh. Không có Docker, Hermes hay VPS thật: lệnh ``hermes`` trong container, nạp nóng qua
control socket và restart thật chỉ kiểm được trên VPS.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from support import PLUGIN_DIR

OPS = PLUGIN_DIR / "ops.sh"
PLUGIN = "ihome-session-reset"
TESTED_COMMIT = "d923a5eb487a17c0a68801bba9ef0f56c81040a8"
REGISTER_LINE = "2026-10-31 INFO x: ihome-session-reset: đã đăng ký hook pre_gateway_dispatch (hồ sơ owner, tiến trình gateway)"

FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
state() { mkdir -p "$FAKE_STATE/$1"; printf '%s' "$FAKE_STATE/$1/$2"; }
profile_of_path() { printf '%s' "$1" | sed -n 's#.*/profiles/\([^/]*\)/.*#\1#p'; }
cmd="$1"; shift
case "$cmd" in
  inspect)
    [ "${1:-}" = -f ] || exit 0
    case "$2" in
      '{{.State.Running}}') echo true ;;
      *Mounts*) echo "$FAKE_HOME_MOUNT" ;;
      *Config.Env*) printf 'PATH=/usr/bin\nHERMES_HOME=/home/hermes/.hermes\n' ;;
      '{{.Config.User}}') echo "$FAKE_USER" ;;
      *Entrypoint*) printf '%s\n%s\n' "${FAKE_ENTRYPOINT:-[\"hermes\"]}" "${FAKE_CMD:-[\"--profile\",\"owner\",\"gateway\",\"run\"]}" ;;
      '{{.HostConfig.NetworkMode}}') echo container:worker-1 ;;
      '{{.Id}}') echo "${FAKE_WORKER_ID:-worker-1}" ;;
      *) echo "inspect lạ: $2" >&2; exit 3 ;;
    esac ;;
  top)
    echo "PID COMMAND"
    echo "10 /sbin/docker-init -- hermes --profile owner gateway run"
    echo "11 /opt/hermes/.venv/bin/python -P -c import os; from hermes_cli.main import main; sys.exit(main()) --profile owner gateway run"
    [ -n "${FAKE_TOP_EXTRA:-}" ] && echo "12 $FAKE_TOP_EXTRA"
    exit 0 ;;
  exec)
    [ "$1" = -i ] && shift
    shift
    case "$1" in
      cat) printf '{"commit": "%s", "displayVersion": "0.22.2"}\n' "$FAKE_COMMIT" ;;
      grep) exit "${FAKE_GREP_STATUS:-0}" ;;
      test) exit 0 ;;
      sed)
        case "$4" in
          *plugins_dispatch.py) printf '%b' "${FAKE_BOUNDED_BLOCK:-_HOOK_TIMEOUT_BOUNDED_HOOKS: set[str] = {\n    \"post_tool_call\",\n    \"post_gateway_admission\",\n}\n}" ;;
          *slash_commands_session.py) printf '%b' "${FAKE_RESET_PREFIX:-    async def _handle_reset_command(self, event: MessageEvent) -> str:\n        self._invalidate_session_run_generation(session_key, reason=\"session_reset\")\n        self._release_running_agent_state(session_key)\n}" ;;
        esac ;;
      /opt/hermes/.venv/bin/python)
        what="${@: -1}"
        if [ "$what" = lookup ]; then
          while read -r sid; do echo "${sid%$'\r'} end_reason=session_reset phiên kế=s-new"; done
          exit 0
        fi
        p="$(profile_of_path "$4")"
        case "$what" in
          mode) cat "$(state "$p" mode)" 2>/dev/null; echo ;;
          enabled) cat "$(state "$p" enabled)" 2>/dev/null || echo False ;;
          enabled-without) echo '["ihome-zalo-native"]' ;;
          *) echo "plugins.enabled có plugin: $(cat "$(state "$p" enabled)" 2>/dev/null || echo False)"
             echo "plugins.isolation: ${FAKE_ISOLATION:-in_process (mặc định)}"
             echo "settings: {'mode': '$(cat "$(state "$p" mode)" 2>/dev/null)'}" ;;
        esac ;;
      hermes)
        p="$3"; shift 3
        case "$1 ${2:-} ${3:-}" in
          "config set plugins.entries.ihome-session-reset.settings.mode") printf '%s' "$4" > "$(state "$p" mode)" ;;
          "config set plugins.enabled") case "$4" in *ihome-session-reset*) echo True ;; *) echo False ;; esac > "$(state "$p" enabled)" ;;
          "config unset plugins.entries.ihome-session-reset") rm -f "$(state "$p" mode)" ;;
          "plugins enable ihome-session-reset")
            echo True > "$(state "$p" enabled)"
            echo "Plugin $3 enabled. Takes effect on next session."
            echo "$FAKE_ENABLE_OUTPUT"
            if [ -n "${FAKE_ENABLE_LOG:-}" ]; then echo "$FAKE_ENABLE_LOG" >> "$FAKE_HOME_MOUNT/.hermes/profiles/owner/logs/agent.log"; fi ;;
          "plugins disable ihome-session-reset")
            [ -d "$FAKE_HOME_MOUNT/.hermes/profiles/$p/plugins/ihome-session-reset" ] || { echo "Unknown plugin" >&2; exit 1; }
            echo False > "$(state "$p" enabled)"
            echo "Plugin $3 disabled. Takes effect on next session." ;;
          "plugins list "*) echo "ihome-session-reset  $(cat "$(state "$p" enabled)" 2>/dev/null)" ;;
          *) echo "hermes $*" ;;
        esac ;;
      *) echo "exec lạ: $*" >&2; exit 4 ;;
    esac ;;
  restart)
    [ -n "${FAKE_RESTART_NOOP:-}" ] && { echo restarted; exit 0; }
    python3 - "$FAKE_HOME_MOUNT/.hermes/profiles/owner/gateway_state.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
data["start_time"] = int(data.get("start_time") or 0) + 1000
json.dump(data, open(sys.argv[1], "w", encoding="utf-8"))
PY
    echo restarted ;;
  *) echo "docker lạ: $cmd" >&2; exit 5 ;;
esac
"""


def _bash() -> str:
    bash = shutil.which("bash")
    if not bash:
        raise AssertionError("ops.sh cần bash; thiếu bash là chưa kiểm, không phải đạt")
    return bash


class OpsScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bash = _bash()
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.home = self.root / "home"
        self.owner = self.home / ".hermes" / "profiles" / "owner"
        self.tkt = self.home / ".hermes" / "profiles" / "tkt"
        for profile in (self.owner, self.tkt):
            (profile / "logs").mkdir(parents=True)
            (profile / "config.yaml").write_text("model: fixture\n", encoding="utf-8")
        self.set_gateway(active=0)
        (self.owner / "logs" / "agent.log").write_text("2026-10-30 INFO x: khởi động\n", encoding="utf-8")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER, encoding="utf-8", newline="\n")
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.log = self.root / "docker.log"
        self.log.write_text("", encoding="utf-8")
        self.state = self.root / "state"
        self.backups = self.root / "backups"
        ids = subprocess.run([self.bash, "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""],
                             capture_output=True, text=True, check=True).stdout
        self.env = dict(
            os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", FAKE_LOG=self.log.as_posix(),
            FAKE_HOME_MOUNT=self.home.as_posix(), FAKE_USER=ids, FAKE_COMMIT=TESTED_COMMIT,
            FAKE_STATE=self.state.as_posix(),
            FAKE_ENABLE_OUTPUT="Gateway reloaded plugins — active in the running gateway now: gateway_transforms.",
            FAKE_ENABLE_LOG=REGISTER_LINE,  # mặc định: gateway nạp được plugin và ghi dòng đăng ký
            IHOME_BACKUP_ROOT=self.backups.as_posix(), IHOME_IDLE_TIMEOUT="5", IHOME_READY_TIMEOUT="5",
            IHOME_LIVE_TIMEOUT="2", PYTHONIOENCODING="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def set_gateway(self, active: int, zalo: str = "connected") -> None:
        (self.owner / "gateway_state.json").write_text(json.dumps({
            "gateway_state": "running", "active_agents": active, "start_time": 474923409,
            "platforms": {"zalo_personal": {"state": zalo}},
        }), encoding="utf-8")

    def set_mode(self, profile: str, mode: str) -> None:
        (self.state / profile).mkdir(parents=True, exist_ok=True)
        (self.state / profile / "mode").write_text(mode, encoding="utf-8")

    def mode(self, profile: str) -> str:
        path = self.state / profile / "mode"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def enabled(self, profile: str) -> str:
        path = self.state / profile / "enabled"
        return path.read_text(encoding="utf-8").strip() if path.exists() else "False"

    def ops(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([self.bash, OPS.as_posix(), *args], env={**self.env, **env},
                              capture_output=True, text=True, encoding="utf-8", timeout=120)

    def docker_calls(self) -> str:
        return self.log.read_text(encoding="utf-8")

    def assert_ok(self, result: subprocess.CompletedProcess) -> None:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # ------------------------------------------------------------------ probe

    def test_probe_passes_on_tested_build(self):
        result = self.ops("probe", "--profile", "owner")
        self.assert_ok(result)
        self.assertIn("probe: đạt", result.stdout)
        self.assertIn("không nằm trong _HOOK_TIMEOUT_BOUNDED_HOOKS", result.stdout)
        self.assertIn("nhả slot trước await đầu tiên", result.stdout)
        self.assertNotIn("CẢNH BÁO", result.stdout)

    def test_probe_refuses_when_a_hermes_seam_is_missing(self):
        result = self.ops("probe", "--profile", "owner", FAKE_GREP_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("THIẾU", result.stdout)

    def test_probe_refuses_when_the_hook_gets_a_timeout(self):
        block = '_HOOK_TIMEOUT_BOUNDED_HOOKS: set[str] = {\\n    "pre_gateway_dispatch",\\n}\\n'
        result = self.ops("probe", "--profile", "owner", FAKE_BOUNDED_BLOCK=block)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("có thể bị cắt thời gian", result.stdout)

    def test_probe_refuses_when_reset_awaits_before_releasing_the_slot(self):
        prefix = ("    async def _handle_reset_command(self, event: MessageEvent) -> str:\\n"
                  "        await self._cleanup_old_agent_for_reset(session_key)\\n"
                  "        self._release_running_agent_state(session_key)\\n")
        result = self.ops("probe", "--profile", "owner", FAKE_RESET_PREFIX=prefix)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("có await trước khi nhả slot", result.stdout)

    def test_probe_refuses_host_isolation(self):
        result = self.ops("probe", "--profile", "owner", FAKE_ISOLATION="host")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("placeholder", result.stdout)

    def test_probe_warns_on_another_build(self):
        result = self.ops("probe", "--profile", "owner", FAKE_COMMIT="0" * 40)
        self.assert_ok(result)
        self.assertIn("CẢNH BÁO", result.stdout)

    def test_gateway_profile_read_from_entrypoint_and_cmd(self):
        result = self.ops("install", "--profile", "owner", FAKE_ENTRYPOINT='["hermes","--profile","owner"]',
                          FAKE_CMD='["gateway","run"]')
        self.assert_ok(result)
        self.assertIn("gateway đang phục vụ: owner", result.stdout)
        self.assertNotIn("Không gateway nào phục vụ", result.stdout)

    # ------------------------------------------------------------------ install

    def test_install_without_apply_only_prints_the_plan(self):
        result = self.ops("install", "--profile", "owner")
        self.assert_ok(result)
        self.assertIn("[kế hoạch] install -d", result.stdout)
        self.assertIn(f"[kế hoạch] hermes_cli config set plugins.entries.{PLUGIN}.settings.mode observe", result.stdout)
        self.assertIn(f"[kế hoạch] hermes --profile owner plugins enable {PLUGIN}", result.stdout)
        self.assertFalse((self.owner / "plugins").exists())
        self.assertFalse(self.backups.exists())
        calls = self.docker_calls()
        self.assertNotIn("restart", calls)
        self.assertNotIn("hermes --profile", calls)

    def test_install_apply_copies_backs_up_sets_mode_and_enables_live(self):
        result = self.ops("install", "--profile", "owner", "--apply")
        self.assert_ok(result)
        for name in ("plugin.yaml", "__init__.py", "policy.py", "hook.py"):
            self.assertEqual((self.owner / "plugins" / PLUGIN / name).read_bytes(), (PLUGIN_DIR / name).read_bytes())
        self.assertFalse((self.owner / "plugins" / PLUGIN / "ops.sh").exists())
        self.assertFalse((self.owner / "plugins" / PLUGIN / "tests").exists())
        [backup] = list((self.backups / "owner").iterdir())
        self.assertEqual((backup / "config.yaml").read_text(encoding="utf-8"), "model: fixture\n")
        calls = self.docker_calls()
        set_mode = calls.index(f"hermes --profile owner config set plugins.entries.{PLUGIN}.settings.mode observe")
        enable = calls.index(f"hermes --profile owner plugins enable {PLUGIN}")
        self.assertLess(set_mode, enable)  # mode ghi trước khi bật
        self.assertNotIn("restart", calls)  # gateway ghi dòng đăng ký mới: hook đã vào gateway
        self.assertIn("Gateway đã ghi dòng đăng ký hook mới", result.stdout)
        self.assertEqual((self.mode("owner"), self.enabled("owner")), ("observe", "True"))
        self.assertIn("khớp nguồn: hook.py", result.stdout)

    def test_reinstall_without_mode_keeps_daily(self):
        """Mục 3: chạy lại install không hạ daily về observe."""
        self.set_mode("owner", "daily")
        result = self.ops("install", "--profile", "owner", "--apply")
        self.assert_ok(result)
        self.assertIn("Giữ mode=daily", result.stdout)
        self.assertNotIn("settings.mode", self.docker_calls())
        self.assertEqual(self.mode("owner"), "daily")

    def test_explicit_mode_is_written(self):
        self.set_mode("owner", "observe")
        self.assert_ok(self.ops("install", "--profile", "owner", "--mode", "daily", "--apply"))
        self.assertEqual(self.mode("owner"), "daily")

    def test_reloaded_without_our_hook_falls_back_to_restart(self):
        """Mục 4b: "Gateway reloaded plugins" mà gateway không ghi dòng đăng ký mới."""
        result = self.ops("install", "--profile", "owner", "--apply",
                          FAKE_ENABLE_OUTPUT="Gateway reloaded plugins; nothing of this plugin needs a session or restart.",
                          FAKE_ENABLE_LOG="")
        self.assert_ok(result)
        self.assertIn("Không thấy dòng đăng ký hook mới của gateway", result.stdout)
        self.assertIn("restart -t 180 hermes-owner", self.docker_calls())
        self.assertIn("gateway chạy lại (start_time 474923409 → 474924409)", result.stdout)

    def test_gateway_transforms_without_a_gateway_log_line_is_not_proof(self):
        """R3: `gateway_transforms` có thể là activation của dashboard/`hermes serve`, không phải gateway."""
        result = self.ops("install", "--profile", "owner", "--apply", FAKE_ENABLE_LOG="")
        self.assert_ok(result)
        self.assertIn("chưa đủ", result.stdout)
        self.assertNotIn("Gateway đã ghi dòng đăng ký hook mới", result.stdout)
        self.assertIn("restart -t 180 hermes-owner", self.docker_calls())
        self.assertIn("gateway chạy lại (start_time 474923409 → 474924409)", result.stdout)

    def test_new_registration_log_line_counts_as_live(self):
        result = self.ops("install", "--profile", "owner", "--apply",
                          FAKE_ENABLE_OUTPUT="Gateway reloaded plugins; nothing of this plugin needs a session or restart.",
                          FAKE_ENABLE_LOG=REGISTER_LINE)
        self.assert_ok(result)
        self.assertIn("Gateway đã ghi dòng đăng ký hook mới", result.stdout)
        self.assertNotIn("restart -t", self.docker_calls())

    def test_registration_line_from_another_process_does_not_count(self):
        line = REGISTER_LINE.replace("tiến trình gateway", "tiến trình khác")
        result = self.ops("install", "--profile", "owner", "--apply", FAKE_ENABLE_LOG=line)
        self.assert_ok(result)
        self.assertIn("restart -t 180 hermes-owner", self.docker_calls())

    def test_old_registration_lines_do_not_count(self):
        """Dòng đăng ký từ lần nạp trước (đã có trong log) không chứng minh lần nạp này."""
        with (self.owner / "logs" / "agent.log").open("a", encoding="utf-8") as handle:
            handle.write(REGISTER_LINE + "\n")
        result = self.ops("install", "--profile", "owner", "--apply", FAKE_ENABLE_LOG="")
        self.assert_ok(result)
        self.assertIn("restart -t 180 hermes-owner", self.docker_calls())

    def test_restart_waits_for_a_new_start_time(self):
        """Mục 11: gateway không khởi động lại (start_time không đổi) thì dừng, không báo xong."""
        result = self.ops("install", "--profile", "owner", "--activate", "restart", "--apply", FAKE_RESTART_NOOP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("chưa sẵn sàng", result.stderr)

    def test_restart_refused_when_sidecar_points_to_another_worker(self):
        result = self.ops("install", "--profile", "owner", "--activate", "restart", "--apply", FAKE_WORKER_ID="worker-2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tạo lại sidecar", result.stderr)
        self.assertNotIn("restart -t", self.docker_calls())

    def test_restart_refused_while_an_acceptance_cli_runs(self):
        """Mục 5: docker restart giết lượt CLI nghiệm thu chạy cùng container."""
        cli = "/opt/hermes/.venv/bin/python -P -c from hermes_cli.main import main; main() --profile tkt chat --query-file - -Q"
        result = self.ops("install", "--profile", "owner", "--activate", "restart", "--apply", FAKE_TOP_EXTRA=cli)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("còn tiến trình hermes khác", result.stderr)
        self.assertNotIn("restart -t", self.docker_calls())

    def test_live_fallback_restart_refused_while_an_acceptance_cli_runs(self):
        """Mục 5, lối restart dự phòng của chế độ live và của uninstall --activate restart."""
        cli = "/usr/local/bin/hermes --profile tkh chat --query-file - -Q --continue tkh-c3"
        result = self.ops("install", "--profile", "owner", "--apply", FAKE_TOP_EXTRA=cli,
                          FAKE_ENABLE_OUTPUT="Restart the gateway for the plugin to take effect", FAKE_ENABLE_LOG="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("còn tiến trình hermes khác", result.stderr)
        uninstall = self.ops("uninstall", "--profile", "owner", "--activate", "restart", "--apply", FAKE_TOP_EXTRA=cli)
        self.assertNotEqual(uninstall.returncode, 0)
        self.assertIn("còn tiến trình hermes khác", uninstall.stderr)
        self.assertEqual(self.mode("owner"), "off")  # đã tắt từ bước đầu dù restart bị từ chối
        self.assertNotIn("restart -t", self.docker_calls())

    def test_busy_gateway_blocks_before_any_write(self):
        self.set_gateway(active=1)
        result = self.ops("install", "--profile", "owner", "--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("chưa rảnh", result.stderr)
        self.assertFalse((self.owner / "plugins").exists())
        self.assertNotIn("hermes --profile", self.docker_calls())

    def test_profile_without_gateway_is_installed_without_restart(self):
        result = self.ops("install", "--profile", "tkt", "--activate", "restart", "--apply")
        self.assert_ok(result)
        self.assertTrue((self.tkt / "plugins" / PLUGIN / "hook.py").is_file())
        self.assertIn("Không gateway nào phục vụ hồ sơ tkt", result.stdout)
        self.assertNotIn("restart -t", self.docker_calls())

    def test_backups_are_rotated(self):
        for stamp in ("20261001T000000Z", "20261002T000000Z", "20261003T000000Z", "not-a-backup"):
            (self.backups / "owner" / stamp).mkdir(parents=True)
        result = self.ops("set-mode", "daily", "--profile", "owner", "--apply", IHOME_KEEP_BACKUPS="2")
        self.assert_ok(result)
        kept = sorted(path.name for path in (self.backups / "owner").iterdir())
        self.assertEqual(len([name for name in kept if name.endswith("Z")]), 2)
        self.assertNotIn("20261001T000000Z", kept)
        self.assertIn("not-a-backup", kept)  # không đụng thư mục lạ

    # ------------------------------------------------------------------ set-mode, status, uninstall

    def test_set_mode_writes_through_hermes_cli(self):
        result = self.ops("set-mode", "daily", "--profile", "owner", "--apply")
        self.assert_ok(result)
        self.assertEqual(self.mode("owner"), "daily")
        self.assertNotEqual(self.ops("set-mode", "always", "--profile", "owner", "--apply").returncode, 0)

    def test_status_shows_audit_and_end_reason_and_survives_broken_lines(self):
        data_dir = self.owner / "plugin-data" / f"agent-plugin-{PLUGIN}-0123abcd"
        data_dir.mkdir(parents=True)
        (data_dir / "resets.jsonl").write_text("\n".join([
            json.dumps({"action": "reset", "old_session_id": "20261017_090000_aaaa1111", "new_session_id": "s2"}),
            "{không phải json",
            json.dumps({"action": "observe", "old_session_id": "20261031_080000_bbbb2222", "new_session_id": None}),
        ]) + "\n", encoding="utf-8")
        result = self.ops("status", "--profile", "owner")
        self.assert_ok(result)
        self.assertIn("(dòng hỏng, bỏ qua)", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertIn("20261017_090000_aaaa1111 end_reason=session_reset", result.stdout)
        self.assertIn("20261031_080000_bbbb2222 end_reason=session_reset", result.stdout)

    def test_uninstall_turns_off_first_and_keeps_plugin_loaded_without_restart(self):
        self.assert_ok(self.ops("install", "--profile", "owner", "--mode", "daily", "--apply"))
        self.log.write_text("", encoding="utf-8")
        result = self.ops("uninstall", "--profile", "owner", "--apply")
        self.assert_ok(result)
        calls = self.docker_calls().splitlines()
        hermes_calls = [line for line in calls if "hermes --profile" in line]
        self.assertIn(f"config set plugins.entries.{PLUGIN}.settings.mode off", hermes_calls[0])  # bước đầu
        self.assertEqual((self.mode("owner"), self.enabled("owner")), ("off", "False"))
        self.assertFalse((self.owner / "plugins" / PLUGIN).exists())
        self.assertEqual(len(list((self.backups / "owner").glob("*/plugin-removed/hook.py"))), 1)
        self.assertNotIn("restart -t", self.docker_calls())
        self.assertIn("module còn nạp trong gateway", result.stdout)

    def test_uninstall_can_be_rerun_after_stopping_midway(self):
        """Mục 7: thư mục đã chuyển đi nhưng plugin còn trong plugins.enabled."""
        self.assert_ok(self.ops("install", "--profile", "owner", "--apply"))
        shutil.move(str(self.owner / "plugins" / PLUGIN), str(self.root / "moved"))
        result = self.ops("uninstall", "--profile", "owner", "--apply")
        self.assert_ok(result)
        self.assertIn("config set plugins.enabled", self.docker_calls())
        self.assertEqual((self.mode("owner"), self.enabled("owner")), ("off", "False"))
        again = self.ops("uninstall", "--profile", "owner", "--apply")
        self.assert_ok(again)
        self.assertIn("plugins.enabled không còn", again.stdout)

    def test_uninstall_with_restart_purges_settings_after_the_restart(self):
        self.assert_ok(self.ops("install", "--profile", "owner", "--mode", "daily", "--apply"))
        kept = self.ops("uninstall", "--profile", "owner", "--purge-settings", "--apply")
        self.assert_ok(kept)
        self.assertIn("Giữ plugins.entries", kept.stdout)  # gateway còn nạp plugin: không xoá về mặc định daily
        self.assertEqual(self.mode("owner"), "off")
        purged = self.ops("uninstall", "--profile", "owner", "--purge-settings", "--activate", "restart", "--apply")
        self.assert_ok(purged)
        calls = self.docker_calls()
        self.assertLess(calls.index("restart -t 180 hermes-owner"), calls.index(f"config unset plugins.entries.{PLUGIN}"))
        self.assertEqual(self.mode("owner"), "")

    def test_bad_arguments(self):
        self.assertNotEqual(self.ops("install").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "../owner").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "khong-co").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "owner", "--activate", "now").returncode, 0)
        self.assertNotEqual(self.ops("explode", "--profile", "owner").returncode, 0)
        trailing = self.ops("install", "--profile")
        self.assertNotEqual(trailing.returncode, 0)
        self.assertIn("--profile cần một giá trị", trailing.stderr)
        swallowed = self.ops("install", "--profile", "--apply")
        self.assertNotEqual(swallowed.returncode, 0)
        self.assertIn("--profile cần một giá trị", swallowed.stderr)


if __name__ == "__main__":
    unittest.main()
