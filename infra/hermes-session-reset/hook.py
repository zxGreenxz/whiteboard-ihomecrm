"""Nối chính sách làm mới phiên vào gateway Hermes qua hook ``pre_gateway_dispatch``.

Kiểu "lười": tin người dùng đầu tiên tới một phiên đã bắt đầu trước mốc (04:00 giờ Việt Nam) thì phiên
được làm mới ngay trước khi tin đó vào agent. Việc làm mới đi đúng đường ``/new`` của lõi
(``GatewayRunner._handle_reset_command``): vô hiệu lượt cũ, dọn tài nguyên và bộ nhớ của agent cũ,
``on_session_finalize``, ``session:end``/``session:reset``, ``on_session_reset``, rồi
``SessionStore.reset_session``. Banner "phiên mới" của ``/new`` bị bỏ, người dùng không nhận thêm tin.

Đường ``/new`` xoá trạng thái hội thoại (tin xếp hàng, prompt đang chờ, ``/model`` riêng, ``/yolo``),
ngắt delegation và tiến trình nền của phiên. Vì vậy plugin chỉ làm mới khi phiên thật sự rảnh và chỉ
với tin người dùng thật; còn việc dở thì để tin rảnh kế tiếp.

Hook nhận runner và session store thật, nên plugin chạy được khi ``plugins.isolation`` là
``in_process`` (mặc định). Các phương thức gạch dưới của runner là bề mặt nội bộ của Hermes 0.22.2
(``d923a5eb``): thiếu cái nào thì plugin log một lần rồi đứng ngoài, không chặn tin.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import json
import logging
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Optional

from .policy import (
    MODE_OBSERVE, PLUGIN_NAME, SETTING_KEYS, Decision, Settings, decide, parse_settings,
)

log = logging.getLogger(__name__)

HOOK_NAME = "pre_gateway_dispatch"
METADATA_KEY = "ihome_session_reset"
AUDIT_FILE = "resets.jsonl"
AUDIT_MAX_BYTES = 256 * 1024
RESET_RETRY_BACKOFF = timedelta(minutes=10)
# Như gateway/run_busy.py::_is_goal_continuation_event (dùng khi runner không có phương thức đó).
GOAL_CONTINUATION_PREFIX = "[Continuing toward your standing goal]\nGoal:"

# Lệnh điều khiển hay xem phiên hiện tại, hoặc trả lời prompt đang chờ: không làm mới trước chúng (làm
# mới sẽ xoá đúng thứ lệnh cần). Lệnh có nội dung (/plan, /moa, skill, /model, ...) vẫn được xét như
# tin thường, để việc mới của ngày bắt đầu trong phiên mới.
SESSION_CONTROL_COMMANDS = frozenset({
    "new", "reset", "resume", "sessions", "retry", "undo", "branch", "title", "save", "compress",
    "compact", "topic", "stop", "approve", "deny", "queue", "q", "steer", "s", "status", "goal", "loop",
    "proactive", "heartbeat", "hb", "yes", "no", "ok", "confirm", "always", "remember", "cancel",
    "nevermind", "start", "help", "whoami", "context", "ctx", "usage", "sethome", "set-home", "pause",
})

_GATEWAY_API = (
    "_session_key_for_source", "_is_session_running", "_is_user_authorized_for_source",
    "_handle_reset_command", "_queue_depth", "_delivery_adapter_for",
)
_STORE_API = ("lookup_by_session_key",)
_MAX_TRACKED_KEYS = 512


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


def _error_text(error: Optional[BaseException]) -> Optional[str]:
    return None if error is None else f"{type(error).__name__}: {error}"[:300]


# ---------------------------------------------------------------------- tin nào được xét làm mới


def command_name(event: Any) -> Optional[str]:
    """Tên lệnh ``/...`` (chữ thường, không dấu ``/``), hoặc None với tin thường."""
    get_command = getattr(event, "get_command", None)
    if callable(get_command):
        try:
            return get_command() or None
        except Exception:
            pass
    text = str(getattr(event, "text", "") or "").lstrip()
    if not text.startswith("/"):
        return None
    raw = text.split(maxsplit=1)[0][1:].lower().split("@", 1)[0]
    return None if not raw or "/" in raw else raw


def _canonical_command(name: str) -> str:
    """Tên chuẩn của lệnh theo danh mục Hermes (``compact`` → ``compress``); không có Hermes thì giữ."""
    try:
        from hermes_cli.commands import resolve_command
        definition = resolve_command(name)
    except Exception:
        return name
    return str(getattr(definition, "name", "") or name)


def _is_goal_continuation(event: Any, gateway: Any) -> bool:
    check = getattr(gateway, "_is_goal_continuation_event", None)
    if callable(check):
        try:
            return bool(check(event))
        except Exception:
            pass
    return str(getattr(event, "text", "") or "").startswith(GOAL_CONTINUATION_PREFIX)


def trigger_skip_reason(event: Any, gateway: Any = None) -> Optional[str]:
    """None khi tin là tin người dùng thật được xét làm mới; nếu không, lý do bỏ qua.

    Sự kiện lõi tự sinh không có ``message_id``: ``/retry`` gửi lại câu hỏi, heartbeat, lượt tiếp nối
    ``/goal``/``/loop`` (``gateway/run_goals.py::_synthetic_prompt_event``). Adapter Zalo luôn gán
    ``messageId``."""
    if event is None:
        return "no_event"
    if getattr(event, "internal", False):
        return "internal"
    if getattr(event, "allow_gateway_control", True) is False:
        return "plugin_event"
    if not getattr(event, "message_id", None):
        return "synthetic"
    if getattr(event, "_heartbeat_session_id", None):
        return "heartbeat"
    if _is_goal_continuation(event, gateway):
        return "goal_continuation"
    name = command_name(event)
    if name is not None and (name in SESSION_CONTROL_COMMANDS or _canonical_command(name) in SESSION_CONTROL_COMMANDS):
        return "session_command"
    return None


def as_new_command(event: Any) -> Any:
    """Bản sao sự kiện với chữ ``/new``: ``_handle_reset_command`` lấy ``get_command_args()`` làm tiêu
    đề phiên mới, mà với tin thường hàm đó trả nguyên văn tin. ``/new`` trơn thì không đặt tiêu đề."""
    if dataclasses.is_dataclass(event) and not isinstance(event, type):
        try:
            return dataclasses.replace(event, text="/new")
        except (TypeError, ValueError):
            pass
    clone = copy.copy(event)
    clone.text = "/new"
    return clone


def missing_api(gateway: Any, store: Any) -> list[str]:
    """Các phương thức runner/store mà plugin cần nhưng không có (placeholder của ``isolation: host``,
    hoặc Hermes đã đổi nội bộ)."""
    missing = [f"gateway.{name}" for name in _GATEWAY_API if not callable(getattr(gateway, name, None))]
    missing += [f"session_store.{name}" for name in _STORE_API if not callable(getattr(store, name, None))]
    return missing


def is_gateway_process(argv: Optional[list[str]] = None) -> bool:
    """Tiến trình hiện tại là ``hermes … gateway run`` (không phải CLI ``plugins enable`` hay dashboard)."""
    args = list(sys.argv if argv is None else argv)
    return "gateway" in args and "run" in args[args.index("gateway"):]


# ---------------------------------------------------------------------- phiên còn việc dở không


class HermesProbes:
    """Hỏi các module công cụ của Hermes xem phiên còn việc dở. Tách ra để test thay bằng bản giả."""

    def live_delegation(self, session_key: str, session_id: Optional[str]) -> bool:
        from tools.async_delegation import has_live_for_session
        return bool(has_live_for_session(session_key=session_key, parent_session_id=session_id or ""))

    def active_process(self, session_key: str) -> bool:
        from tools.process_registry import process_registry
        return bool(process_registry.has_active_for_session(session_key))

    def pending_clarify(self, session_key: str) -> bool:
        from tools.clarify_gateway import get_pending_for_session
        return get_pending_for_session(session_key, include_choice_prompts=True) is not None

    def pending_slash_confirm(self, session_key: str) -> bool:
        from tools.slash_confirm import get_pending
        return bool(get_pending(session_key))

    def pending_approval(self, session_key: str) -> bool:
        from tools.approval import has_blocking_approval
        return bool(has_blocking_approval(session_key))


# ---------------------------------------------------------------------- sổ JSONL


@contextmanager
def _exclusive_lock(path: Path) -> Iterator[None]:
    """Khóa độc quyền liên tiến trình trên một tệp khóa riêng (tệp sổ bị đổi tên khi xoay vòng)."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name == "nt":  # chỉ để test trên Windows; plugin chạy trên Linux
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


class AuditLog:
    """Sổ chỉ ghi thêm ``resets.jsonl`` trong thư mục plugin-data của hồ sơ. Một khóa phủ cả xoay vòng
    lẫn ghi; mỗi mục là một lần ``write`` với ``O_APPEND``, nên không mất mục khi ghi đồng thời."""

    def __init__(self, directory: Callable[[], Any], *, max_bytes: int = AUDIT_MAX_BYTES) -> None:
        self._directory = directory
        self._max_bytes = max_bytes

    def append(self, item: Mapping[str, Any]) -> None:
        directory = Path(self._directory())
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / AUDIT_FILE
        data = (json.dumps(dict(item), ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
        with _exclusive_lock(directory / f".{AUDIT_FILE}.lock"):
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                size = 0
            if size and size + len(data) > self._max_bytes:
                os.replace(path, directory / f"{AUDIT_FILE}.1")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, data)
            finally:
                os.close(fd)


# ---------------------------------------------------------------------- bộ xử lý


class DailySessionReset:
    """Trạng thái của plugin trong một tiến trình gateway (khóa theo session key, nhật ký một lần)."""

    def __init__(
        self, settings_loader: Callable[[], Optional[Mapping[str, Any]]], *, audit: Any = None,
        profile: str = "", clock: Optional[Callable[[], datetime]] = None,
        naive_tz: Optional[tzinfo] = None, zone_loader: Optional[Callable[[str], tzinfo]] = None,
        probes: Any = None, logger: Optional[logging.Logger] = None,
    ) -> None:
        self._settings_loader = settings_loader
        self._audit = audit
        self.profile = profile
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._naive_tz = naive_tz
        self._zone_loader = zone_loader
        self._probes = probes if probes is not None else HermesProbes()
        self._log = logger or log
        self._locks: dict[str, asyncio.Lock] = {}
        self._noted: dict[tuple[str, str], str] = {}
        self._warned: set[str] = set()
        self._retry_after: dict[str, datetime] = {}
        self._settings_cache: Optional[tuple[tuple, Settings]] = None

    async def pre_gateway_dispatch(
        self, event: Any = None, gateway: Any = None, session_store: Any = None, **_payload: Any,
    ) -> None:
        """Callback của hook. Luôn trả ``None`` (cho tin đi tiếp như thường); lỗi chỉ được log."""
        try:
            await self._handle(event, gateway, session_store)
        except Exception as exc:
            first = self._warn_once(f"error:{type(exc).__name__}", "%s: lỗi khi xét làm mới phiên (%s: %s); "
                                    "tin vẫn đi tiếp", PLUGIN_NAME, type(exc).__name__, exc)
            if not first:
                self._log.debug("%s: lỗi lặp lại", PLUGIN_NAME, exc_info=True)
        return None

    # ------------------------------------------------------------------ quyết định

    def settings(self) -> Settings:
        """Cấu hình hiện tại; đọc lại mỗi tin (config.yaml đổi là có hiệu lực, không cần khởi động
        lại), chỉ phân tích và log lại khi giá trị thô đổi."""
        raw = self._settings_loader() or {}
        snapshot = tuple((key, repr(raw.get(key))) for key in SETTING_KEYS)
        cached = self._settings_cache
        if cached is not None and cached[0] == snapshot:
            return cached[1]
        settings = parse_settings(raw, zone_loader=self._zone_loader)
        for warning in settings.warnings:
            self._log.warning("%s: %s", PLUGIN_NAME, warning)
        self._log.info(
            "%s: cấu hình hồ sơ %s mode=%s at=%02d:%02d timezone=%s applies_to=%s", PLUGIN_NAME,
            self.profile or "?", settings.mode, settings.at_hour, settings.at_minute,
            settings.timezone_name, ",".join(sorted(settings.applies_to)) or "-",
        )
        self._settings_cache = (snapshot, settings)
        return settings

    def _decide(self, settings: Settings, entry: Any, source: Any) -> Decision:
        chat_type = getattr(source, "chat_type", None) or getattr(entry, "chat_type", None)
        return decide(
            settings, created_at=getattr(entry, "created_at", None), chat_type=chat_type,
            now=self._clock(), naive_tz=self._naive_tz,
        )

    def busy_reason(self, gateway: Any, key: str, entry: Any, source: Any) -> Optional[str]:
        """Lý do chưa làm mới được (phiên còn việc dở), hoặc None khi phiên rảnh. Đồng bộ, không ``await``.

        Cùng điều kiện lõi dùng trước khi bắn heartbeat (``run_goals.py``: đang chạy, adapter còn giữ
        phiên, còn tin xếp hàng), cộng những thứ đường ``/new`` sẽ xoá hay ngắt."""
        if gateway._is_session_running(key):
            return "đang chạy lượt"
        adapter = gateway._delivery_adapter_for(source)
        if adapter is not None and key in (getattr(adapter, "_active_sessions", None) or {}):
            return "adapter còn giữ phiên"
        if gateway._queue_depth(key, adapter=adapter) > 0:
            return "còn tin xếp hàng"
        if getattr(entry, "resume_pending", False):
            return "chờ chạy tiếp sau khởi động lại"
        peek = getattr(gateway, "_peek_session_state", None)
        state = peek(key) if callable(peek) else None
        if state is not None and getattr(getattr(state, "persistent", None), "update_prompt_pending", False):
            return "còn prompt /update"
        session_id = getattr(entry, "session_id", None)
        checks = (
            ("delegation", "còn delegation chạy nền", lambda: self._probes.live_delegation(key, session_id)),
            ("process", "còn tiến trình nền", lambda: self._probes.active_process(key)),
            ("clarify", "còn câu hỏi clarify chờ trả lời", lambda: self._probes.pending_clarify(key)),
            ("slash_confirm", "còn lệnh chờ xác nhận", lambda: self._probes.pending_slash_confirm(key)),
            ("approval", "còn lệnh nguy hiểm chờ duyệt", lambda: self._probes.pending_approval(key)),
        )
        for name, label, probe in checks:
            try:
                if probe():
                    return label
            except Exception as exc:
                self._warn_once(f"probe:{name}", "%s: không kiểm được %s (%s: %s); hoãn làm mới cho an toàn",
                                PLUGIN_NAME, name, type(exc).__name__, exc)
                return f"không kiểm được {name}"
        return None

    async def _handle(self, event: Any, gateway: Any, store: Any) -> None:
        settings = self.settings()
        if not settings.active or trigger_skip_reason(event, gateway) is not None:
            return
        source = getattr(event, "source", None)
        if source is None:
            return
        if store is None:
            store = getattr(gateway, "session_store", None)
        missing = missing_api(gateway, store)
        if missing:
            self._warn_once(
                "api", "%s: không hoạt động — thiếu %s (cần plugins.isolation: in_process và bản Hermes đã "
                "kiểm 0.22.2); tin vẫn đi tiếp", PLUGIN_NAME, ", ".join(missing))
            return
        gateway_loop = getattr(gateway, "_gateway_loop", None)
        if gateway_loop is not None and gateway_loop is not asyncio.get_running_loop():
            self._warn_once("loop", "%s: hook không chạy trên event loop của gateway; bỏ qua", PLUGIN_NAME)
            return
        key = gateway._session_key_for_source(source)
        if not isinstance(key, str) or not key:
            return
        entry = store.lookup_by_session_key(key)
        if entry is None or not self._decide(settings, entry, source).reset:
            return
        retry_at = self._retry_after.get(key)
        if retry_at is not None and self._clock() < retry_at:
            self._log.debug("%s: đang chờ thử lại tới %s key=%s", PLUGIN_NAME, _iso(retry_at), key)
            return
        async with self._lock_for(key):
            # Tin khác cùng phiên có thể vừa làm mới trong lúc chờ khóa: xét lại trên mục hiện tại.
            entry = store.lookup_by_session_key(key)
            if entry is None:
                return
            decision = self._decide(settings, entry, source)
            if not decision.reset:
                return
            if not gateway._is_user_authorized_for_source(source):
                return
            # Từ đây tới phần đồng bộ đầu của ``_handle_reset_command`` (vô hiệu lượt, nhả slot) không có
            # ``await``: không lượt nào chen vào giữa lúc kiểm "rảnh" và lúc làm mới.
            busy = self.busy_reason(gateway, key, entry, source)
            if busy is not None:
                self._note_once("defer", key, decision, "%s: để sau (%s) — tin rảnh kế tiếp sẽ làm mới key=%s",
                                PLUGIN_NAME, busy, key)
                return
            if settings.mode == MODE_OBSERVE:
                if self._note_once(
                        "observe", key, decision, "%s: observe — sẽ %s nếu mode=daily: platform=%s kind=%s "
                        "key=%s session=%s created=%s boundary=%s", PLUGIN_NAME, settings.reason,
                        _platform(source), decision.kind, key, getattr(entry, "session_id", None),
                        _iso(decision.created_at), _iso(decision.boundary)):
                    await self._record("observe", settings, decision, source, key,
                                       getattr(entry, "session_id", None), None)
                return
            await self._reset(gateway, store, event, source, key, entry, decision, settings)

    # ------------------------------------------------------------------ làm mới

    async def _reset(
        self, gateway: Any, store: Any, event: Any, source: Any, key: str, entry: Any,
        decision: Decision, settings: Settings,
    ) -> None:
        old_sid = getattr(entry, "session_id", None)
        error: Optional[BaseException] = None
        try:
            await gateway._handle_reset_command(as_new_command(event))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = exc
        # So id trước/sau cả khi có lỗi: lỗi có thể xảy ra sau khi lõi đã đổi phiên.
        current = store.lookup_by_session_key(key)
        new_sid = getattr(current, "session_id", None)
        if not new_sid or new_sid == old_sid:
            retry_at = self._clock() + RESET_RETRY_BACKOFF
            self._remember_retry(key, retry_at)
            self._log.warning(
                "%s: làm mới thất bại key=%s session=%s (%s); thử lại sau %s", PLUGIN_NAME, key, old_sid,
                _error_text(error) or "phiên không đổi", _iso(retry_at), exc_info=error)
            await self._record("reset_failed", settings, decision, source, key, old_sid, None, error)
            return
        self._retry_after.pop(key, None)
        marker = {
            "reason": settings.reason, "boundary": _iso(decision.boundary),
            "previous_session_id": old_sid, "at": _iso(self._clock()),
        }
        setter = getattr(store, "set_session_metadata", None)
        if callable(setter):
            try:
                await asyncio.to_thread(setter, key, METADATA_KEY, marker)
            except Exception as exc:
                self._log.warning("%s: không ghi được dấu vào mục định tuyến %s: %s", PLUGIN_NAME, key, exc)
        if error is not None:
            self._log.warning("%s: đã đổi phiên key=%s old=%s new=%s nhưng đường /new báo lỗi sau đó: %s",
                              PLUGIN_NAME, key, old_sid, new_sid, _error_text(error), exc_info=error)
        self._log.info(
            "%s: %s profile=%s platform=%s kind=%s key=%s old=%s new=%s created=%s boundary=%s",
            PLUGIN_NAME, settings.reason, self.profile or "?", _platform(source), decision.kind, key,
            old_sid, new_sid, _iso(decision.created_at), _iso(decision.boundary),
        )
        await self._record("reset", settings, decision, source, key, old_sid, new_sid, error)

    async def _record(
        self, action: str, settings: Settings, decision: Decision, source: Any, key: str,
        old_sid: Optional[str], new_sid: Optional[str], error: Optional[BaseException] = None,
    ) -> None:
        if self._audit is None:
            return
        item = {
            "at": _iso(self._clock()), "action": action, "reason": settings.reason,
            "profile": self.profile, "platform": _platform(source), "kind": decision.kind,
            "session_key": key, "old_session_id": old_sid, "new_session_id": new_sid,
            "created_at": _iso(decision.created_at), "boundary": _iso(decision.boundary),
        }
        if error is not None:
            item["error"] = _error_text(error)
        try:
            await asyncio.to_thread(self._audit.append, item)
        except Exception as exc:
            self._log.warning("%s: không ghi được sổ plugin-data: %s", PLUGIN_NAME, exc)

    # ------------------------------------------------------------------ tiện ích

    def _remember_retry(self, key: str, retry_at: datetime) -> None:
        if len(self._retry_after) >= _MAX_TRACKED_KEYS:
            now = self._clock()
            for stale in [k for k, when in self._retry_after.items() if when <= now]:
                del self._retry_after[stale]
        self._retry_after[key] = retry_at

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            if len(self._locks) >= _MAX_TRACKED_KEYS:
                for stale in [k for k, held in self._locks.items() if not held.locked()]:
                    del self._locks[stale]
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _note_once(self, kind: str, key: str, decision: Decision, message: str, *args: Any) -> bool:
        """Log ``message`` một lần cho mỗi (loại, phiên, mốc); True khi vừa log."""
        marker = _iso(decision.boundary) or ""
        if self._noted.get((kind, key)) == marker:
            return False
        if len(self._noted) >= _MAX_TRACKED_KEYS:
            self._noted.clear()
        self._noted[(kind, key)] = marker
        self._log.info(message, *args)
        return True

    def _warn_once(self, tag: str, message: str, *args: Any) -> bool:
        if tag in self._warned:
            return False
        self._warned.add(tag)
        self._log.warning(message, *args)
        return True


def _platform(source: Any) -> str:
    platform = getattr(source, "platform", None)
    return str(getattr(platform, "value", platform) or "")


def build(ctx: Any) -> DailySessionReset:
    """Tạo bộ xử lý từ ``PluginContext``: cấu hình đọc bằng ``ctx.get_config`` (khóa
    ``plugins.entries.ihome-session-reset.settings.*`` trong config.yaml của hồ sơ), sổ ghi vào
    ``ctx.state.data_dir`` (``<HERMES_HOME>/plugin-data/<namespace>/resets.jsonl``)."""

    def load_settings() -> dict[str, Any]:
        return {key: ctx.get_config(key) for key in SETTING_KEYS}

    try:
        profile = str(ctx.profile_name or "")
    except Exception:
        profile = ""
    return DailySessionReset(load_settings, audit=AuditLog(lambda: ctx.state.data_dir), profile=profile)


def register(ctx: Any) -> DailySessionReset:
    """Điểm vào plugin Hermes."""
    handler = build(ctx)
    ctx.register_hook(HOOK_NAME, handler.pre_gateway_dispatch)
    log.info("%s: đã đăng ký hook %s (hồ sơ %s, tiến trình %s)", PLUGIN_NAME, HOOK_NAME, handler.profile or "?",
             "gateway" if is_gateway_process() else "khác")
    return handler
