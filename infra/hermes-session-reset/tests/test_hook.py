"""Hook ``pre_gateway_dispatch`` với runner/session store giả.

Giả lập chỉ phần GatewayRunner mà plugin gọi (Hermes 0.22.2): ``_session_key_for_source``,
``_is_session_running``, ``_is_user_authorized_for_source``, ``_handle_reset_command`` (xoay mục định
tuyến như ``/new``) và ``SessionStore.lookup_by_session_key``/``set_session_metadata``. Hành vi thật của
đường ``/new`` (finalize, xả bộ nhớ, end_reason trong state.db) chỉ kiểm được khi chạy gateway thật.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import logging
import unittest
from datetime import datetime, timedelta, timezone
from typing import Optional

from support import PLUGIN_DIR, hook, plugin, policy

UTC = timezone.utc
VN = timezone(timedelta(hours=7), "Asia/Ho_Chi_Minh")
LOGGER = "test.ihome_session_reset"


def vn(year, month, day, hour, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=VN)


def no_tzdata(name):
    raise LookupError(name)


@dataclasses.dataclass
class Source:
    platform: str = "zalo_personal"
    chat_id: str = "uid-chu"
    chat_type: str = "dm"
    user_id: str = "uid-chu"


@dataclasses.dataclass
class Event:
    """Phần ``gateway.platforms.event.MessageEvent`` liên quan: lệnh và tham số lệnh."""

    text: str
    source: Optional[Source] = None
    internal: bool = False
    allow_gateway_control: bool = True
    message_id: str = "m-1"

    def is_command(self) -> bool:
        return self.allow_gateway_control and (self.text or "").lstrip().startswith("/")

    def get_command_args(self) -> str:
        if not self.is_command():
            return self.text  # như lõi: tin thường trả nguyên văn
        parts = self.text.lstrip().split(maxsplit=1)
        return parts[1] if len(parts) > 1 else ""


@dataclasses.dataclass
class Entry:
    session_key: str
    session_id: str
    created_at: datetime
    chat_type: str = "dm"


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class FakeStore:
    def __init__(self) -> None:
        self.entries: dict[str, Entry] = {}
        self.metadata: dict[tuple[str, str], dict] = {}

    def lookup_by_session_key(self, key):
        return self.entries.get(key)

    def set_session_metadata(self, key, name, value):
        self.metadata[(key, name)] = value
        return True


class FakeGateway:
    def __init__(self, store: FakeStore, clock: Clock) -> None:
        self.session_store = store
        self.clock = clock
        self.running: set[str] = set()
        self.authorized = True
        self.reset_events: list[Event] = []
        self.fail_reset = False
        self._seq = 0

    def _session_key_for_source(self, source):
        return f"agent:owner:{source.platform}:{source.chat_type}:{source.chat_id}"

    def _is_session_running(self, key):
        return key in self.running

    def _is_user_authorized_for_source(self, source):
        return self.authorized

    async def _handle_reset_command(self, event):
        """Như ``/new`` của lõi: phiên mới bắt đầu lúc này; trả banner (plugin phải bỏ)."""
        self.reset_events.append(event)
        if self.fail_reset:
            raise RuntimeError("cleanup exploded")
        key = self._session_key_for_source(event.source)
        old = self.session_store.entries.get(key)
        await asyncio.sleep(0)  # lõi await dọn agent cũ: nhường loop như thật
        self._seq += 1
        self.session_store.entries[key] = Entry(
            key, f"s-new-{self._seq}", self.clock(), old.chat_type if old else event.source.chat_type)
        return "✨ New session started"


class FakeState:
    """``ctx.state``: get/set JSON."""

    def __init__(self) -> None:
        self.data: dict = {}

    def get(self, key, default=None):
        return json.loads(json.dumps(self.data.get(key, default)))

    def set(self, key, value):
        self.data[key] = json.loads(json.dumps(value))


class HookTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.clock = Clock(vn(2026, 10, 31, 8, 0))
        self.store = FakeStore()
        self.gateway = FakeGateway(self.store, self.clock)
        self.state = FakeState()
        self.config: dict = {}
        self.handler = hook.DailySessionReset(
            lambda: self.config, audit=self.state, profile="owner", clock=self.clock,
            zone_loader=no_tzdata, logger=logging.getLogger(LOGGER),
        )

    def add_session(self, source: Source, session_id: str, created_at: datetime) -> str:
        key = self.gateway._session_key_for_source(source)
        self.store.entries[key] = Entry(key, session_id, created_at, source.chat_type)
        return key

    async def send(self, text: str, source: Source, **event_fields):
        event = Event(text, source, **event_fields)
        return await self.handler.pre_gateway_dispatch(
            event=event, gateway=self.gateway, session_store=self.store, telemetry_schema_version=1)


class DailyResetTest(HookTestCase):
    async def test_first_message_after_boundary_takes_the_new_path(self):
        src = Source()
        key = self.add_session(src, "s-17-10", vn(2026, 10, 17, 9))
        result = await self.send("chào buổi sáng", src)
        self.assertIsNone(result)  # tin đi tiếp như thường, không skip/rewrite
        self.assertEqual(len(self.gateway.reset_events), 1)
        reset_event = self.gateway.reset_events[0]
        self.assertEqual(reset_event.text, "/new")
        self.assertIs(reset_event.source, src)
        self.assertEqual(reset_event.get_command_args(), "")  # không lấy tin làm tiêu đề phiên mới
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")
        marker = self.store.metadata[(key, "ihome_session_reset")]
        self.assertEqual(marker["reason"], "daily_reset_0400")
        self.assertEqual(marker["previous_session_id"], "s-17-10")
        self.assertEqual(marker["boundary"], vn(2026, 10, 31, 4).isoformat())
        [record] = self.state.data["resets"]
        self.assertEqual(record["action"], "reset")
        self.assertEqual((record["old_session_id"], record["new_session_id"]), ("s-17-10", "s-new-1"))
        self.assertEqual((record["platform"], record["kind"], record["profile"]), ("zalo_personal", "dm", "owner"))

    async def test_later_messages_same_day_keep_the_new_session(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("tin 1", src)
        self.clock.now = vn(2026, 10, 31, 23, 59)
        await self.send("tin 2", src)
        self.clock.now = vn(2026, 11, 1, 3, 59)
        await self.send("tin 3", src)
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.clock.now = vn(2026, 11, 1, 4, 0)
        await self.send("tin 4", src)
        self.assertEqual(len(self.gateway.reset_events), 2)

    async def test_0359_message_keeps_the_session(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.clock.now = vn(2026, 10, 31, 3, 59, 59)
        await self.send("còn thức", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.clock.now = vn(2026, 10, 31, 4, 0, 0)
        await self.send("đã 4 giờ", src)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_container_utc_naive_created_at(self):
        # Mục định tuyến thật ghi datetime.now() không múi; container hermes-owner chạy UTC.
        handler = hook.DailySessionReset(
            lambda: {}, clock=self.clock, naive_tz=UTC, zone_loader=no_tzdata, logger=logging.getLogger(LOGGER))
        src = Source()
        key = self.gateway._session_key_for_source(src)
        self.store.entries[key] = Entry(key, "s-utc", datetime(2026, 10, 30, 22, 0))  # 05:00 VN 31/10
        await handler.pre_gateway_dispatch(event=Event("hi", src), gateway=self.gateway, session_store=self.store)
        self.assertEqual(self.gateway.reset_events, [])
        self.store.entries[key] = Entry(key, "s-utc", datetime(2026, 10, 30, 20, 59))  # 03:59 VN 31/10
        await handler.pre_gateway_dispatch(event=Event("hi", src), gateway=self.gateway, session_store=self.store)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_group_chat_resets_like_dm(self):
        group = Source(chat_id="nhom-sale", chat_type="group", user_id="uid-a")
        key = self.add_session(group, "s-group", vn(2026, 10, 30, 10))
        await self.send("anh em ơi", group)
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.assertEqual(self.state.data["resets"][0]["kind"], "group")
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")

    async def test_applies_to_dm_only_leaves_groups(self):
        self.config = {"applies_to": ["dm"]}
        group = Source(chat_id="nhom", chat_type="group")
        dm = Source()
        self.add_session(group, "s-group", vn(2026, 10, 30, 10))
        self.add_session(dm, "s-dm", vn(2026, 10, 30, 10))
        await self.send("nhóm", group)
        self.assertEqual(self.gateway.reset_events, [])
        await self.send("riêng", dm)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_no_session_yet_is_left_to_core(self):
        await self.send("tin đầu tiên", Source(chat_id="nguoi-moi"))
        self.assertEqual(self.gateway.reset_events, [])


class NewCommandTest(HookTestCase):
    async def test_slash_new_is_never_intercepted(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        for text in ("/new", "  /new", "/reset", "/new Tiêu đề", "/stop"):
            with self.subTest(text=text):
                self.assertIsNone(await self.send(text, src))
        self.assertEqual(self.gateway.reset_events, [])

    async def test_slash_new_still_works_and_no_double_reset(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("/new", src)
        # Lõi tự xử lý /new như mọi khi (giả lập): phiên mới bắt đầu sau mốc.
        await self.gateway._handle_reset_command(Event("/new", src))
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")
        await self.send("tiếp tục", src)
        self.assertEqual(len(self.gateway.reset_events), 1)  # chỉ lần /new của người dùng

    async def test_slash_new_before_boundary_also_untouched(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.clock.now = vn(2026, 10, 31, 2, 0)
        await self.send("/new", src)
        await self.send("hello", src)
        self.assertEqual(self.gateway.reset_events, [])


class GuardTest(HookTestCase):
    async def test_running_turn_is_not_touched_then_next_idle_message_resets(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.running.add(key)
        with self.assertLogs(LOGGER, logging.INFO) as logs:
            await self.send("tin trong lúc bot đang trả lời", src)
            await self.send("tin nữa", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.assertEqual(sum("đang chạy lượt dở" in line for line in logs.output), 1)
        self.gateway.running.discard(key)
        await self.send("bot trả lời xong rồi", src)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_unauthorized_sender_does_not_rotate(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.authorized = False
        await self.send("lạ", src)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_internal_and_plugin_events_do_not_rotate(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("tiến trình nền xong", src, internal=True)
        await self.send("tin plugin chủ động", src, allow_gateway_control=False)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_two_messages_at_once_reset_only_once(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await asyncio.gather(self.send("tin A", src), self.send("tin B", src), self.send("tin C", src))
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")

    async def test_missing_gateway_api_is_inert_and_warns_once(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        placeholder = object()  # như plugins.isolation: host — hook chỉ nhận placeholder
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            for _ in range(3):
                result = await self.handler.pre_gateway_dispatch(
                    event=Event("hi", src), gateway=placeholder, session_store=placeholder)
                self.assertIsNone(result)
        self.assertEqual(len([line for line in logs.output if "không hoạt động" in line]), 1)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_foreign_event_loop_is_refused(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway._gateway_loop = object()
        with self.assertLogs(LOGGER, logging.WARNING):
            await self.send("hi", src)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_failure_inside_reset_never_blocks_the_message(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.fail_reset = True
        with self.assertLogs(LOGGER, logging.WARNING):
            self.assertIsNone(await self.send("hi", src))
        self.assertEqual(self.state.data.get("resets"), None)

    async def test_session_store_falls_back_to_gateway_attribute(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.handler.pre_gateway_dispatch(event=Event("hi", src), gateway=self.gateway)
        self.assertEqual(len(self.gateway.reset_events), 1)


class ConfigTest(HookTestCase):
    async def test_off_disables_and_switching_back_needs_no_restart(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        for off in ("off", False):
            self.config = {"mode": off}
            await self.send("hi", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.config = {"mode": "daily"}
        await self.send("hi", src)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_observe_logs_and_records_once_without_resetting(self):
        self.config = {"mode": "observe"}
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        with self.assertLogs(LOGGER, logging.INFO) as logs:
            await self.send("hi", src)
            await self.send("hi lần 2", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.assertEqual(self.store.entries[key].session_id, "s-old")
        self.assertEqual(sum("observe" in line and "daily_reset_0400" in line for line in logs.output), 1)
        [record] = self.state.data["resets"]
        self.assertEqual((record["action"], record["old_session_id"], record["new_session_id"]),
                         ("observe", "s-old", None))

    async def test_custom_time_per_profile(self):
        self.config = {"at": "06:30", "timezone": "Asia/Ho_Chi_Minh"}
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.clock.now = vn(2026, 10, 31, 6, 29)
        await self.send("hi", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.clock.now = vn(2026, 10, 31, 6, 30)
        await self.send("hi", src)
        self.assertEqual(self.state.data["resets"][0]["reason"], "daily_reset_0630")

    async def test_bad_value_warns_once_per_change(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.config = {"at": "25:00"}
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            await self.send("a", src)
            self.store.entries[self.gateway._session_key_for_source(src)].created_at = vn(2026, 10, 30, 22)
            await self.send("b", src)
        self.assertEqual(len([line for line in logs.output if "25:00" in line]), 1)

    async def test_audit_keeps_last_100(self):
        self.state.data["resets"] = [{"n": i} for i in range(100)]
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("hi", src)
        self.assertEqual(len(self.state.data["resets"]), 100)
        self.assertEqual(self.state.data["resets"][-1]["action"], "reset")


class RegisterTest(unittest.IsolatedAsyncioTestCase):
    async def test_register_wires_one_async_gateway_hook_reading_profile_settings(self):
        class Ctx:
            profile_name = "tkt"

            def __init__(self) -> None:
                self.hooks = []
                self.state = FakeState()
                self.asked = []

            def register_hook(self, name, callback):
                self.hooks.append((name, callback))

            def get_config(self, key, default=None):
                self.asked.append(key)
                return {"mode": "daily", "at": "04:00"}.get(key, default)

        ctx = Ctx()
        handler = plugin.register(ctx)
        [(name, callback)] = ctx.hooks
        self.assertEqual(name, "pre_gateway_dispatch")
        self.assertTrue(inspect.iscoroutinefunction(callback))
        self.assertTrue(any(p.kind is p.VAR_KEYWORD for p in inspect.signature(callback).parameters.values()))
        self.assertEqual(handler.profile, "tkt")
        store = FakeStore()
        clock = Clock(datetime.now(UTC))
        gateway = FakeGateway(store, clock)
        src = Source()
        key = gateway._session_key_for_source(src)
        store.entries[key] = Entry(key, "s-old", datetime.now(UTC) - timedelta(days=2))
        await callback(event=Event("hi", src), gateway=gateway, session_store=store)
        self.assertEqual(len(gateway.reset_events), 1)
        self.assertEqual(set(ctx.asked), set(policy.SETTING_KEYS))
        self.assertEqual(ctx.state.data["resets"][0]["profile"], "tkt")


class ManifestTest(unittest.TestCase):
    def test_manifest_matches_code_defaults(self):
        # plugin.yaml viết dạng JSON (tập con hợp lệ của YAML) để test stdlib đọc được.
        manifest = json.loads((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], policy.PLUGIN_NAME)
        self.assertEqual(manifest["provides_hooks"], [hook.HOOK_NAME])
        schema = manifest["config_schema"]
        self.assertEqual(tuple(schema), policy.SETTING_KEYS)
        self.assertEqual(schema["mode"]["default"], policy.DEFAULT_MODE)
        self.assertEqual(tuple(schema["mode"]["choices"]), policy.MODES)
        self.assertEqual(schema["at"]["default"], policy.DEFAULT_AT)
        self.assertEqual(schema["timezone"]["default"], policy.DEFAULT_TIMEZONE)
        self.assertEqual(tuple(schema["applies_to"]["default"]), policy.DEFAULT_APPLIES_TO)
        defaults = {key: spec["default"] for key, spec in schema.items()}
        self.assertEqual(policy.parse_settings(defaults, zone_loader=no_tzdata).warnings, ())


if __name__ == "__main__":
    unittest.main()
