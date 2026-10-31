"""Nối chính sách làm mới phiên vào gateway Hermes qua hook ``pre_gateway_dispatch``.

Kiểu "lười": tin người dùng đầu tiên tới một phiên đã bắt đầu trước mốc (04:00 giờ Việt Nam) thì phiên
được làm mới ngay trước khi tin đó vào agent. Việc làm mới đi đúng đường ``/new`` của lõi
(``GatewayRunner._handle_reset_command``): kết thúc lượt cũ, dọn tài nguyên và bộ nhớ của agent cũ,
``on_session_finalize``, ``session:end``/``session:reset``, ``on_session_reset``, rồi
``SessionStore.reset_session``. Banner "phiên mới" của ``/new`` bị bỏ, người dùng không nhận thêm tin.

Hook nhận runner và session store thật, nên plugin chạy được khi ``plugins.isolation`` là
``in_process`` (mặc định). Các phương thức gạch dưới của runner là bề mặt nội bộ của Hermes 0.22.2
(``d923a5eb``): thiếu cái nào thì plugin chỉ log một lần rồi đứng ngoài, không chặn tin.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import logging
from datetime import datetime, timezone, tzinfo
from typing import Any, Callable, Mapping, Optional

from .policy import (
    MODE_OBSERVE, PLUGIN_NAME, SETTING_KEYS, Decision, Settings, decide, parse_settings,
)

log = logging.getLogger(__name__)

HOOK_NAME = "pre_gateway_dispatch"
METADATA_KEY = "ihome_session_reset"
AUDIT_KEY = "resets"
AUDIT_LIMIT = 100
_GATEWAY_API = (
    "_session_key_for_source", "_is_session_running", "_is_user_authorized_for_source",
    "_handle_reset_command",
)
_STORE_API = ("lookup_by_session_key",)
_MAX_TRACKED_KEYS = 512


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


def is_user_message(event: Any) -> bool:
    """Tin người dùng bình thường: không phải sự kiện nội bộ, không phải lệnh ``/...`` (``/new``,
    ``/stop``... đi thẳng vào lõi), không phải sự kiện chủ động của plugin."""
    if event is None or getattr(event, "internal", False):
        return False
    if getattr(event, "allow_gateway_control", True) is False:
        return False
    is_command = getattr(event, "is_command", None)
    if callable(is_command):
        try:
            return not is_command()
        except Exception:
            pass
    text = getattr(event, "text", "") or ""
    return not str(text).lstrip().startswith("/")


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


def _append_audit(state: Any, item: Mapping[str, Any]) -> None:
    items = state.get(AUDIT_KEY, [])
    if not isinstance(items, list):
        items = []
    items.append(dict(item))
    state.set(AUDIT_KEY, items[-AUDIT_LIMIT:])


class DailySessionReset:
    """Trạng thái của plugin trong một tiến trình gateway (khóa theo session key, nhật ký một lần)."""

    def __init__(
        self, settings_loader: Callable[[], Optional[Mapping[str, Any]]], *, audit: Any = None,
        profile: str = "", clock: Optional[Callable[[], datetime]] = None,
        naive_tz: Optional[tzinfo] = None, zone_loader: Optional[Callable[[str], tzinfo]] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._settings_loader = settings_loader
        self._audit = audit
        self.profile = profile
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._naive_tz = naive_tz
        self._zone_loader = zone_loader
        self._log = logger or log
        self._locks: dict[str, asyncio.Lock] = {}
        self._noted: dict[tuple[str, str], str] = {}
        self._warned: set[str] = set()
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

    async def _handle(self, event: Any, gateway: Any, store: Any) -> None:
        settings = self.settings()
        if not settings.active or not is_user_message(event):
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
            # ``await``: không lượt nào chen vào giữa lúc kiểm "đang chạy" và lúc làm mới.
            if gateway._is_session_running(key):
                self._note_once(
                    "running", key, decision, "%s: để sau — phiên đang chạy lượt dở, tin rảnh kế tiếp sẽ làm "
                    "mới key=%s", PLUGIN_NAME, key)
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
        await gateway._handle_reset_command(as_new_command(event))
        new_entry = store.lookup_by_session_key(key)
        new_sid = getattr(new_entry, "session_id", None)
        if not new_sid or new_sid == old_sid:
            self._log.warning("%s: đã gọi đường /new nhưng phiên không đổi key=%s session=%s",
                              PLUGIN_NAME, key, old_sid)
            return
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
        self._log.info(
            "%s: %s profile=%s platform=%s kind=%s key=%s old=%s new=%s created=%s boundary=%s",
            PLUGIN_NAME, settings.reason, self.profile or "?", _platform(source), decision.kind, key,
            old_sid, new_sid, _iso(decision.created_at), _iso(decision.boundary),
        )
        await self._record("reset", settings, decision, source, key, old_sid, new_sid)

    async def _record(
        self, action: str, settings: Settings, decision: Decision, source: Any, key: str,
        old_sid: Optional[str], new_sid: Optional[str],
    ) -> None:
        if self._audit is None:
            return
        item = {
            "at": _iso(self._clock()), "action": action, "reason": settings.reason,
            "profile": self.profile, "platform": _platform(source), "kind": decision.kind,
            "session_key": key, "old_session_id": old_sid, "new_session_id": new_sid,
            "created_at": _iso(decision.created_at), "boundary": _iso(decision.boundary),
        }
        try:
            await asyncio.to_thread(_append_audit, self._audit, item)
        except Exception as exc:
            self._log.warning("%s: không ghi được sổ plugin-data: %s", PLUGIN_NAME, exc)

    # ------------------------------------------------------------------ tiện ích

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
    ``plugins.entries.ihome-session-reset.settings.*`` trong config.yaml của hồ sơ), sổ ghi bằng
    ``ctx.state`` (``<HERMES_HOME>/plugin-data/<namespace>/state.json``)."""

    def load_settings() -> dict[str, Any]:
        return {key: ctx.get_config(key) for key in SETTING_KEYS}

    try:
        audit = ctx.state
    except Exception:
        audit = None
    try:
        profile = str(ctx.profile_name or "")
    except Exception:
        profile = ""
    return DailySessionReset(load_settings, audit=audit, profile=profile)


def register(ctx: Any) -> DailySessionReset:
    """Điểm vào plugin Hermes."""
    handler = build(ctx)
    ctx.register_hook(HOOK_NAME, handler.pre_gateway_dispatch)
    log.info("%s: đã đăng ký hook %s (hồ sơ %s)", PLUGIN_NAME, HOOK_NAME, handler.profile or "?")
    return handler
