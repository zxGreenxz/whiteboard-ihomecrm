"""``ops.sh`` với ``docker`` giả: kế hoạch không ghi gì, --apply chép/sao lưu/bật, rơi về restart an toàn.

``docker`` giả trả lời đúng các câu ``ops.sh`` hỏi (inspect, exec cat/grep/python/hermes, restart) và ghi
lại mọi lệnh. Không có Docker, Hermes hay VPS thật: lệnh ``hermes`` trong container, nạp nóng qua
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

FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
cmd="$1"; shift
case "$cmd" in
  inspect)
    [ "${1:-}" = -f ] || exit 0
    case "$2" in
      '{{.State.Running}}') echo true ;;
      *Mounts*) echo "$FAKE_HOME_MOUNT" ;;
      *Config.Env*) printf 'PATH=/usr/bin\nHERMES_HOME=/home/hermes/.hermes\n' ;;
      '{{.Config.User}}') echo "$FAKE_USER" ;;
      '{{json .Config.Cmd}}') echo '["--profile","owner","gateway","run"]' ;;
      '{{.HostConfig.NetworkMode}}') echo container:worker-1 ;;
      '{{.Id}}') echo "${FAKE_WORKER_ID:-worker-1}" ;;
      *) echo "inspect lạ: $2" >&2; exit 3 ;;
    esac ;;
  exec)
    [ "$1" = -i ] && shift
    shift
    case "$1" in
      cat) printf '{"commit": "%s", "displayVersion": "0.22.2"}\n' "$FAKE_COMMIT" ;;
      grep) exit "${FAKE_GREP_STATUS:-0}" ;;
      test) exit 0 ;;
      /opt/hermes/.venv/bin/python)
        if [ "$2" = -c ]; then
          while read -r sid; do echo "${sid%$'\r'} end_reason=session_reset phiên kế=s-new"; done
        else
          cat >/dev/null
          echo "plugins.enabled có plugin: True"
          echo "plugins.isolation: ${FAKE_ISOLATION:-in_process (mặc định)}"
        fi ;;
      hermes)
        shift 3
        case "$1 ${2:-}" in
          "plugins enable") echo "Plugin $3 enabled. Takes effect on next session."; echo "$FAKE_ENABLE_OUTPUT" ;;
          "plugins disable") echo "Plugin $3 disabled. Takes effect on next session." ;;
          "plugins list") echo "ihome-session-reset  enabled  1.0.0" ;;
          *) echo "hermes $*" ;;
        esac ;;
      *) echo "exec lạ: $*" >&2; exit 4 ;;
    esac ;;
  restart) echo "$(date +%s).5" >> "$FAKE_STARTS_LOG"; echo restarted ;;
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
        (self.owner / "gateway-starts.log").write_text("1793194607.37723\n", encoding="utf-8")
        (self.owner / "logs" / "agent.log").write_text(
            "2026-10-31 INFO x: ihome-session-reset: đã đăng ký hook pre_gateway_dispatch (hồ sơ owner)\n",
            encoding="utf-8")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER, encoding="utf-8", newline="\n")
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.log = self.root / "docker.log"
        self.log.write_text("", encoding="utf-8")
        self.backups = self.root / "backups"
        ids = subprocess.run([self.bash, "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""],
                             capture_output=True, text=True, check=True).stdout
        self.env = dict(
            os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", FAKE_LOG=self.log.as_posix(),
            FAKE_HOME_MOUNT=self.home.as_posix(), FAKE_USER=ids, FAKE_COMMIT=TESTED_COMMIT,
            FAKE_STARTS_LOG=(self.owner / "gateway-starts.log").as_posix(),
            FAKE_ENABLE_OUTPUT="Gateway reloaded plugins — active in the running gateway now: gateway_transforms.",
            IHOME_BACKUP_ROOT=self.backups.as_posix(), IHOME_IDLE_TIMEOUT="5", IHOME_READY_TIMEOUT="5",
            PYTHONIOENCODING="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def set_gateway(self, active: int, zalo: str = "connected") -> None:
        (self.owner / "gateway_state.json").write_text(json.dumps({
            "gateway_state": "running", "active_agents": active,
            "platforms": {"zalo_personal": {"state": zalo}},
        }), encoding="utf-8")

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
        self.assertNotIn("CẢNH BÁO", result.stdout)

    def test_probe_refuses_when_a_hermes_seam_is_missing(self):
        result = self.ops("probe", "--profile", "owner", FAKE_GREP_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("THIẾU", result.stdout)

    def test_probe_refuses_host_isolation(self):
        result = self.ops("probe", "--profile", "owner", FAKE_ISOLATION="host")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("placeholder", result.stdout)

    def test_probe_warns_on_another_build(self):
        result = self.ops("probe", "--profile", "owner", FAKE_COMMIT="0" * 40)
        self.assert_ok(result)
        self.assertIn("CẢNH BÁO", result.stdout)

    # ------------------------------------------------------------------ install

    def test_install_without_apply_only_prints_the_plan(self):
        result = self.ops("install", "--profile", "owner")
        self.assert_ok(result)
        self.assertIn("[kế hoạch] install -d", result.stdout)
        self.assertIn(f"[kế hoạch] hermes_cli config set plugins.entries.{PLUGIN}.settings.mode observe",
                      result.stdout)
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
        self.assertNotIn("restart", calls)  # gateway xác nhận nạp nóng
        self.assertIn("khớp nguồn: hook.py", result.stdout)

    def test_install_falls_back_to_controlled_restart_when_gateway_silent(self):
        result = self.ops("install", "--profile", "owner", "--mode", "daily", "--apply",
                          FAKE_ENABLE_OUTPUT="Restart the gateway for the plugin to take effect")
        self.assert_ok(result)
        self.assertIn("restart -t 180 hermes-owner", self.docker_calls())
        self.assertIn("gateway chạy lại, zalo_personal=connected", result.stdout)

    def test_restart_refused_when_sidecar_points_to_another_worker(self):
        result = self.ops("install", "--profile", "owner", "--activate", "restart", "--apply", FAKE_WORKER_ID="worker-2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tạo lại sidecar", result.stderr)
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

    # ------------------------------------------------------------------ set-mode, status, uninstall

    def test_set_mode_writes_through_hermes_cli(self):
        result = self.ops("set-mode", "daily", "--profile", "owner", "--apply")
        self.assert_ok(result)
        self.assertIn(f"config set plugins.entries.{PLUGIN}.settings.mode daily", self.docker_calls())
        self.assertNotEqual(self.ops("set-mode", "always", "--profile", "owner", "--apply").returncode, 0)

    def test_status_shows_audit_and_end_reason(self):
        data_dir = self.owner / "plugin-data" / f"agent-plugin-{PLUGIN}-0123abcd"
        data_dir.mkdir(parents=True)
        (data_dir / "state.json").write_text(json.dumps({"resets": [
            {"action": "reset", "old_session_id": "20261017_090000_aaaa1111", "new_session_id": "s2"},
            {"action": "observe", "old_session_id": "20261031_080000_bbbb2222", "new_session_id": None},
        ]}), encoding="utf-8")
        result = self.ops("status", "--profile", "owner")
        self.assert_ok(result)
        self.assertIn("20261017_090000_aaaa1111 end_reason=session_reset", result.stdout)
        self.assertIn("20261031_080000_bbbb2222 end_reason=session_reset", result.stdout)

    def test_uninstall_disables_moves_plugin_out_and_restarts(self):
        self.assert_ok(self.ops("install", "--profile", "owner", "--apply"))
        result = self.ops("uninstall", "--profile", "owner", "--apply")
        self.assert_ok(result)
        self.assertFalse((self.owner / "plugins" / PLUGIN).exists())
        moved = list((self.backups / "owner").glob("*/plugin-removed/hook.py"))
        self.assertEqual(len(moved), 1)
        calls = self.docker_calls()
        self.assertIn(f"plugins disable {PLUGIN}", calls)
        self.assertIn("restart -t 180 hermes-owner", calls)  # disable không tự nạp lại gateway

    def test_bad_arguments(self):
        self.assertNotEqual(self.ops("install").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "../owner").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "khong-co").returncode, 0)
        self.assertNotEqual(self.ops("install", "--profile", "owner", "--activate", "now").returncode, 0)
        self.assertNotEqual(self.ops("explode", "--profile", "owner").returncode, 0)


if __name__ == "__main__":
    unittest.main()
