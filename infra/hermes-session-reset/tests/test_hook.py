"""Hook ``pre_gateway_dispatch`` với runner/session store giả.

Giả lập chỉ phần GatewayRunner mà plugin gọi (Hermes 0.22.2): ``_session_key_for_source``,
``_is_session_running``, ``_is_user_authorized_for_source``, ``_delivery_adapter_for`` (adapter có
``_active_sessions``/``_pending_messages``), ``_queue_depth``, ``_peek_session_state``,
``_is_goal_continuation_event``, ``_handle_reset_command`` (xoay mục định tuyến như ``/new``) và
``SessionStore.lookup_by_session_key``/``set_session_metadata``; các module công cụ (delegation, tiến
trình nền, prompt chờ) qua ``probes`` giả. Hành vi thật của đường ``/new`` (finalize, xả bộ nhớ,
end_reason trong state.db) chỉ kiểm được khi chạy gateway thật.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import logging
import sys
import tempfile
import threading
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest import mock

from support import PLUGIN_DIR, hook, plugin, policy

UTC = timezone.utc
VN = timezone(timedelta(hours=7), "Asia/Ho_Chi_Minh")
LOGGER = "test.ihome_session_reset"
GOAL_TEXT = "[Continuing toward your standing goal]\nGoal: dọn sổ thu chi"


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
    """Phần ``gateway.platforms.event.MessageEvent`` liên quan: lệnh, tham số lệnh, ``message_id``."""

    text: str
    source: Optional[Source] = None
    internal: bool = False
    allow_gateway_control: bool = True
    message_id: Optional[str] = "m-1"

    def is_command(self) -> bool:
        return self.allow_gateway_control and (self.text or "").lstrip().startswith("/")

    def get_command(self) -> Optional[str]:
        if not self.is_command():
            return None
        raw = self.text.lstrip().split(maxsplit=1)[0][1:].lower().split("@", 1)[0]
        return None if "/" in raw else raw

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
    resume_pending: bool = False


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


class FakeAdapter:
    """Phần ``BasePlatformAdapter`` liên quan: guard, task chủ phiên, slot tin xếp hàng."""

    def __init__(self) -> None:
        self._active_sessions: dict = {}
        self._session_tasks: dict = {}
        self._pending_messages: dict = {}


class FakeGateway:
    def __init__(self, store: FakeStore, clock: Clock) -> None:
        self.session_store = store
        self.clock = clock
        self.adapter = FakeAdapter()
        self.overflow: dict[str, list] = {}
        self.states: dict[str, SimpleNamespace] = {}
        self.running: set[str] = set()
        self.authorized = True
        self.reset_events: list[Event] = []
        self.fail_reset: Optional[str] = None  # "before" | "after" | "noop"
        self._seq = 0

    def _session_key_for_source(self, source):
        return f"agent:owner:{source.platform}:{source.chat_type}:{source.chat_id}"

    def _is_session_running(self, key):
        return key in self.running

    def _is_user_authorized_for_source(self, source):
        return self.authorized

    def _delivery_adapter_for(self, source):
        return self.adapter

    def _queue_depth(self, key, *, adapter=None):  # như run_busy.py: overflow + slot
        depth = len(self.overflow.get(key) or ())
        if adapter is not None and key in adapter._pending_messages:
            depth += 1
        return depth

    def _peek_session_state(self, key):
        return self.states.get(key)

    @staticmethod
    def _is_goal_continuation_event(event_or_text):
        text = getattr(event_or_text, "text", event_or_text) or ""
        return str(text).startswith("[Continuing toward your standing goal]\nGoal:")

    async def _handle_reset_command(self, event):
        """Như ``/new`` của lõi: phiên mới bắt đầu lúc này; trả banner (plugin phải bỏ)."""
        self.reset_events.append(event)
        if self.fail_reset == "before":
            raise RuntimeError("cleanup exploded")
        if self.fail_reset == "noop":
            return "nothing happened"
        key = self._session_key_for_source(event.source)
        old = self.session_store.entries.get(key)
        await asyncio.sleep(0)  # lõi await dọn agent cũ: nhường loop như thật
        self._seq += 1
        self.session_store.entries[key] = Entry(
            key, f"s-new-{self._seq}", self.clock(), old.chat_type if old else event.source.chat_type)
        if self.fail_reset == "after":
            raise RuntimeError("finalize hook exploded")
        return "✨ New session started"


class FakeProbes:
    def __init__(self) -> None:
        self.flags: dict[str, bool] = {}
        self.broken: set[str] = set()

    def _check(self, name):
        if name in self.broken:
            raise ImportError(f"no module for {name}")
        return self.flags.get(name, False)

    def live_delegation(self, session_key, session_id):
        return self._check("delegation")

    def active_process(self, session_key, max_age_seconds):
        self.process_max_age = max_age_seconds
        return self._check("process")

    def pending_clarify(self, session_key):
        return self._check("clarify")

    def pending_slash_confirm(self, session_key):
        return self._check("slash_confirm")

    def pending_approval(self, session_key):
        return self._check("approval")


class HookTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.audit_dir = Path(self._tmp.name) / "plugin-data"
        self.clock = Clock(vn(2026, 10, 31, 8, 0))
        self.store = FakeStore()
        self.gateway = FakeGateway(self.store, self.clock)
        self.probes = FakeProbes()
        self.config: dict = {}
        self.handler = hook.DailySessionReset(
            lambda: self.config, audit=hook.AuditLog(lambda: self.audit_dir), profile="owner", clock=self.clock,
            zone_loader=no_tzdata, probes=self.probes, logger=logging.getLogger(LOGGER),
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def add_session(self, source: Source, session_id: str, created_at: datetime, **fields) -> str:
        key = self.gateway._session_key_for_source(source)
        self.store.entries[key] = Entry(key, session_id, created_at, source.chat_type, **fields)
        return key

    def audit(self) -> list[dict]:
        path = self.audit_dir / hook.AUDIT_FILE
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    async def send(self, text: str, source: Source, *, via_adapter: bool = True, **event_fields):
        event = Event(text, source, **event_fields)
        return await self.send_event(event, via_adapter=via_adapter)

    async def call_hook(self, event):
        return await self.handler.pre_gateway_dispatch(
            event=event, gateway=self.gateway, session_store=self.store, telemetry_schema_version=1)

    async def send_event(self, event, *, via_adapter: bool = True):
        """Như ``base.py::handle_message`` → ``_start_session_processing``: đặt guard rồi mới tạo task
        gọi handler; task đó là ``_session_tasks[key]``. Hook vì vậy chạy khi guard của CHÍNH tin này
        đang có. ``via_adapter=False`` gọi hook thẳng (lối inline/khác adapter)."""
        if not via_adapter or event.source is None:
            return await self.call_hook(event)
        adapter = self.gateway.adapter
        key = self.gateway._session_key_for_source(event.source)
        assert key not in adapter._active_sessions, "adapter thật sẽ xếp hàng tin này, không gọi handler"
        guard = asyncio.Event()
        adapter._active_sessions[key] = guard
        task = asyncio.create_task(self.call_hook(event))
        adapter._session_tasks[key] = task
        try:
            return await task
        finally:
            if adapter._session_tasks.get(key) is task:
                adapter._session_tasks.pop(key, None)
            if adapter._active_sessions.get(key) is guard:
                adapter._active_sessions.pop(key, None)


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
        [record] = self.audit()
        self.assertEqual(record["action"], "reset")
        self.assertEqual((record["old_session_id"], record["new_session_id"]), ("s-17-10", "s-new-1"))
        self.assertEqual((record["platform"], record["kind"], record["profile"]), ("zalo_personal", "dm", "owner"))
        self.assertNotIn("error", record)

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
            lambda: {}, clock=self.clock, naive_tz=UTC, zone_loader=no_tzdata, probes=self.probes,
            logger=logging.getLogger(LOGGER))
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
        self.assertEqual(self.audit()[0]["kind"], "group")
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


class SyntheticEventTest(HookTestCase):
    """Mục 1: sự kiện lõi tự sinh không được coi là tin người dùng."""

    async def test_retry_resend_without_message_id_does_not_rotate(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        # /retry gửi lại câu hỏi bằng MessageEvent mới không có message_id (slash_commands_session.py).
        await self.send("câu hỏi tối qua", src, message_id=None)
        await self.send("câu hỏi tối qua", src, message_id="")
        self.assertEqual(self.gateway.reset_events, [])

    async def test_heartbeat_event_does_not_rotate(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        event = Event("nhắc việc định kỳ", src)
        event._heartbeat_session_id = "s-old"
        await self.send_event(event)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_goal_continuation_does_not_rotate(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send(GOAL_TEXT, src)
        # Runner không có _is_goal_continuation_event: plugin dò tiền tố như lõi.
        self.gateway._is_goal_continuation_event = None
        await self.send(GOAL_TEXT, src)
        self.assertEqual(self.gateway.reset_events, [])

    async def test_real_message_after_synthetic_events_still_rotates(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("lặp lại", src, message_id=None)
        await self.send("tin thật", src)
        self.assertEqual(len(self.gateway.reset_events), 1)


class AdapterGuardTest(HookTestCase):
    """R1: guard ``_active_sessions``/``_session_tasks`` do adapter đặt cho CHÍNH tin đang chạy hook
    (``base.py::_start_session_processing``) không được tính là "phiên bận"."""

    async def test_own_guard_does_not_block_daily_reset_across_two_days(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        observed = []

        async def observe_inside_handler(event):
            # Trong lúc hook chạy, adapter đang giữ guard và task chủ phiên là task hiện tại.
            observed.append((key in self.gateway.adapter._active_sessions,
                             self.gateway.adapter._session_tasks.get(key) is asyncio.current_task()))
            return await self.handler.pre_gateway_dispatch(event=event, gateway=self.gateway, session_store=self.store)

        self.call_hook = observe_inside_handler
        moments = [vn(2026, 10, 31, 8), vn(2026, 10, 31, 12), vn(2026, 10, 31, 23),
                   vn(2026, 11, 1, 7), vn(2026, 11, 1, 9)]
        for index, moment in enumerate(moments):
            self.clock.now = moment
            await self.send(f"tin {index}", src)
        self.assertEqual(observed, [(True, True)] * 5)
        self.assertEqual(len(self.gateway.reset_events), 2)  # sáng 31/10 và sáng 1/11
        self.assertEqual([r["action"] for r in self.audit()], ["reset", "reset"])

    async def test_own_guard_does_not_block_observe(self):
        self.config = {"mode": "observe"}
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("hi", src)
        self.assertEqual([r["action"] for r in self.audit()], ["observe"])
        self.assertEqual(self.gateway.reset_events, [])

    async def test_drained_follow_up_still_resets(self):
        """Như ``_process_message_background``: tin trong slot được lấy ra rồi mới giao cho task xả hàng."""
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        queued = Event("tin xếp hàng từ tối qua", src)
        self.gateway.adapter._pending_messages[key] = queued
        drained = self.gateway.adapter._pending_messages.pop(key)
        await self.send_event(drained)
        self.assertEqual(len(self.gateway.reset_events), 1)


class DeferTest(HookTestCase):
    """Mục 2: phiên còn việc dở thì để tin rảnh kế tiếp."""

    async def assert_deferred_then_reset(self, key, src, clear, *, via_adapter=True):
        with self.assertLogs(LOGGER, logging.INFO) as logs:
            await self.send("tin 1", src, via_adapter=via_adapter)
            await self.send("tin 2", src, via_adapter=via_adapter)
        self.assertEqual(self.gateway.reset_events, [])
        self.assertEqual(sum("để sau" in line for line in logs.output), 1)
        deferred = [r for r in self.audit() if r["action"] == "deferred" and r["session_key"] == key]
        self.assertEqual(len(deferred), 1)  # mỗi mốc một mục, kèm lý do
        self.assertTrue(deferred[0]["detail"])
        clear()
        await self.send("tin 3", src, via_adapter=via_adapter)
        self.assertEqual(len(self.gateway.reset_events), 1)

    async def test_running_turn(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.running.add(key)
        await self.assert_deferred_then_reset(key, src, lambda: self.gateway.running.discard(key))

    async def test_another_live_task_holding_the_session_defers(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        other = asyncio.create_task(asyncio.sleep(60))  # task khác đang là chủ phiên ở adapter
        self.gateway.adapter._session_tasks[key] = other
        self.addAsyncCleanup(self._cancel, other)

        def clear():
            self.gateway.adapter._session_tasks.pop(key, None)

        await self.assert_deferred_then_reset(key, src, clear, via_adapter=False)

    async def test_finished_owner_task_does_not_block(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        finished = asyncio.create_task(asyncio.sleep(0))
        await finished
        self.gateway.adapter._session_tasks[key] = finished
        await self.send("hi", src, via_adapter=False)
        self.assertEqual(len(self.gateway.reset_events), 1)

    @staticmethod
    async def _cancel(task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def test_queued_message_in_slot(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.adapter._pending_messages[key] = Event("tin xếp hàng", src)
        await self.assert_deferred_then_reset(key, src, lambda: self.gateway.adapter._pending_messages.clear())

    async def test_queued_messages_in_overflow(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.overflow[key] = [Event("tin mồ côi", src)]
        await self.assert_deferred_then_reset(key, src, lambda: self.gateway.overflow.clear())

    async def test_resume_pending_after_restart(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22), resume_pending=True)

        def clear():
            self.store.entries[key].resume_pending = False

        await self.assert_deferred_then_reset(key, src, clear)

    async def test_pending_update_prompt(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.states[key] = SimpleNamespace(persistent=SimpleNamespace(update_prompt_pending=True))
        await self.assert_deferred_then_reset(key, src, lambda: self.gateway.states.clear())

    async def test_delegations_processes_and_pending_prompts(self):
        for name in ("delegation", "process", "clarify", "slash_confirm", "approval"):
            with self.subTest(name=name):
                self.gateway.reset_events.clear()
                self.handler._noted.clear()
                src = Source(chat_id=f"chat-{name}")
                key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
                self.probes.flags[name] = True
                await self.assert_deferred_then_reset(key, src, lambda: self.probes.flags.clear())

    async def test_session_busy_across_two_boundaries_records_one_deferred_per_boundary(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.running.add(key)
        for moment in (vn(2026, 10, 31, 8), vn(2026, 10, 31, 9), vn(2026, 11, 1, 8), vn(2026, 11, 1, 9)):
            self.clock.now = moment
            await self.send("hi", src)
        records = [r for r in self.audit() if r["action"] == "deferred"]
        self.assertEqual([r["boundary"] for r in records],
                         [vn(2026, 10, 31, 4).isoformat(), vn(2026, 11, 1, 4).isoformat()])
        self.assertEqual({r["detail"] for r in records}, {"đang chạy lượt"})
        self.assertEqual(self.gateway.reset_events, [])

    async def test_probe_that_cannot_run_defers_and_warns_once(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.probes.broken.add("process")
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            await self.send("a", src)
            await self.send("b", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.assertEqual(sum("không kiểm được process" in line for line in logs.output), 1)

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
        # Adapter gốc xếp hàng tin thứ hai; hai lần gọi hook đồng thời chỉ có ở lối gọi khác adapter.
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await asyncio.gather(*(self.send(text, src, via_adapter=False) for text in ("tin A", "tin B", "tin C")))
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")

    async def test_long_running_process_age_limit_is_passed_to_hermes(self):
        """R2: tiến trình nền chạy lâu không chặn làm mới mãi (max_active_age, mặc định 4 giờ)."""
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        await self.send("hi", src)
        self.assertEqual(self.probes.process_max_age, 4 * 3600.0)
        other = Source(chat_id="khac")
        self.add_session(other, "s-old-2", vn(2026, 10, 30, 22))
        self.config = {"process_max_age_hours": 1.5}
        await self.send("hi", other)
        self.assertEqual(self.probes.process_max_age, 1.5 * 3600.0)


class CommandTest(HookTestCase):
    """Mục 9: chỉ lệnh điều khiển phiên được bỏ qua; lệnh có nội dung vẫn xét làm mới."""

    async def test_session_control_commands_are_never_intercepted(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        for text in ("/new", "  /new", "/reset", "/new Tiêu đề", "/retry", "/undo", "/status", "/stop",
                     "/compact", "/approve", "/resume tối qua", "/goal", "/goal status", "/goal PAUSE",
                     "/loop stop", "/proactive status", "/queue", "/queue list", "/q rm 2", "/heartbeat status",
                     "/hb pause"):
            with self.subTest(text=text):
                self.assertIsNone(await self.send(text, src))
        self.assertEqual(self.gateway.reset_events, [])

    async def test_content_commands_start_in_the_new_session(self):
        # R4: /goal, /loop, /queue, /heartbeat có tham số khởi tạo việc mới là lệnh có nội dung.
        for text in ("/plan việc hôm nay", "/ihome-crm-thu-chi chi 50k", "/model cx/gpt-6-luna",
                     "/goal làm báo cáo tuần", "/goal -- dọn sổ", "/loop 30m kiểm hàng tồn",
                     "/proactive 1h nhắc chốt sổ", "/queue thêm việc", "/q gửi hoá đơn",
                     "/heartbeat every 1h nhắc", "/hb every 2h kiểm"):
            with self.subTest(text=text):
                self.gateway.reset_events.clear()
                src = Source(chat_id=text.split()[0])
                self.add_session(src, "s-old", vn(2026, 10, 30, 22))
                await self.send(text, src)
                self.assertEqual(len(self.gateway.reset_events), 1)

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


class FailureTest(HookTestCase):
    """Mục 6: làm mới lỗi thì lùi lại theo session key, log từng lần, so id cả khi có ngoại lệ."""

    async def test_failure_backs_off_instead_of_retrying_every_message(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.fail_reset = "before"
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            for index in range(5):
                self.assertIsNone(await self.send(f"tin {index}", src))
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.assertEqual(sum("làm mới thất bại" in line for line in logs.output), 1)
        [record] = self.audit()
        self.assertEqual(record["action"], "reset_failed")
        self.assertIn("RuntimeError: cleanup exploded", record["error"])
        self.clock.now += hook.RESET_RETRY_BACKOFF + timedelta(seconds=1)
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            await self.send("sau khi chờ", src)
        self.assertEqual(len(self.gateway.reset_events), 2)
        self.assertEqual(sum("làm mới thất bại" in line for line in logs.output), 1)  # log từng lần lỗi
        self.gateway.fail_reset = None
        self.clock.now += hook.RESET_RETRY_BACKOFF + timedelta(seconds=1)
        await self.send("đã sửa", src)
        self.assertEqual(len(self.gateway.reset_events), 3)
        self.assertEqual(self.audit()[-1]["action"], "reset")

    async def test_error_after_rotation_is_still_recorded_as_reset(self):
        src = Source()
        key = self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.fail_reset = "after"
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            self.assertIsNone(await self.send("hi", src))
        self.assertTrue(any("đã đổi phiên" in line for line in logs.output))
        self.assertEqual(self.store.entries[key].session_id, "s-new-1")
        [record] = self.audit()
        self.assertEqual((record["action"], record["new_session_id"]), ("reset", "s-new-1"))
        self.assertIn("finalize hook exploded", record["error"])
        self.assertIn((key, "ihome_session_reset"), self.store.metadata)
        await self.send("tin sau", src)
        self.assertEqual(len(self.gateway.reset_events), 1)  # phiên mới, không làm lại

    async def test_core_returning_without_rotating_is_a_failure(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.gateway.fail_reset = "noop"
        with self.assertLogs(LOGGER, logging.WARNING):
            await self.send("hi", src)
        await self.send("hi lần 2", src)
        self.assertEqual(len(self.gateway.reset_events), 1)
        self.assertEqual(self.audit()[0]["action"], "reset_failed")

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
        [record] = self.audit()
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
        self.assertEqual(self.audit()[0]["reason"], "daily_reset_0630")

    async def test_numeric_at_turns_the_plugin_off_with_one_warning(self):
        src = Source()
        self.add_session(src, "s-old", vn(2026, 10, 30, 22))
        self.config = {"at": 430}
        with self.assertLogs(LOGGER, logging.WARNING) as logs:
            await self.send("a", src)
            await self.send("b", src)
        self.assertEqual(self.gateway.reset_events, [])
        self.assertEqual(len([line for line in logs.output if "430" in line]), 1)


class HermesProbesTest(unittest.TestCase):
    """Bản thật của ``probes`` gọi module công cụ Hermes đúng chữ ký mà ``ops.sh probe`` grep (module giả
    trong ``sys.modules``; không có Hermes)."""

    def setUp(self) -> None:
        self.calls: list = []
        calls = self.calls

        def module(name, **attrs):
            mod = types.ModuleType(name)
            for attr, value in attrs.items():
                setattr(mod, attr, value)
            return mod

        registry = SimpleNamespace(has_active_for_session=lambda key, **kw: calls.append(("process", key, kw)) or True)
        modules = {
            "tools": module("tools"),
            "tools.async_delegation": module(
                "tools.async_delegation", has_live_for_session=lambda **kw: calls.append(("delegation", kw)) or True),
            "tools.process_registry": module("tools.process_registry", process_registry=registry),
            "tools.clarify_gateway": module(
                "tools.clarify_gateway", get_pending_for_session=lambda key, **kw: calls.append(("clarify", key, kw))),
            "tools.slash_confirm": module("tools.slash_confirm", get_pending=lambda key: calls.append(("confirm", key))),
            "tools.approval": module("tools.approval", has_blocking_approval=lambda key: calls.append(("approval", key))),
        }
        patcher = mock.patch.dict(sys.modules, modules)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_real_probes_pass_the_session_and_the_process_age_limit(self):
        probes = hook.HermesProbes()
        self.assertTrue(probes.live_delegation("k", "s-old"))
        self.assertTrue(probes.active_process("k", 5400.0))
        self.assertFalse(probes.pending_clarify("k"))
        self.assertFalse(probes.pending_slash_confirm("k"))
        self.assertFalse(probes.pending_approval("k"))
        self.assertEqual(self.calls, [
            ("delegation", {"session_key": "k", "parent_session_id": "s-old"}),
            ("process", "k", {"max_active_age": 5400.0}),  # R2: tiến trình quá tuổi không chặn mãi
            ("clarify", "k", {"include_choice_prompts": True}),
            ("confirm", "k"),
            ("approval", "k"),
        ])


class AuditLogTest(unittest.TestCase):
    """Mục 10: một khóa cho cả xoay vòng lẫn ghi, mỗi mục một lần write O_APPEND."""

    def test_concurrent_appends_keep_every_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit = hook.AuditLog(lambda: Path(tmp) / "plugin-data")
            threads = [threading.Thread(target=lambda n=n: [audit.append({"thread": n, "i": i}) for i in range(40)])
                       for n in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            lines = (Path(tmp) / "plugin-data" / hook.AUDIT_FILE).read_text(encoding="utf-8").splitlines()
            records = [json.loads(line) for line in lines]
            self.assertEqual(len(records), 320)
            self.assertEqual({(r["thread"], r["i"]) for r in records}, {(n, i) for n in range(8) for i in range(40)})

    def test_rotation_keeps_the_previous_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "plugin-data"
            audit = hook.AuditLog(lambda: directory, max_bytes=200)
            for i in range(10):
                audit.append({"i": i, "pad": "x" * 30})
            current = [json.loads(line) for line in (directory / hook.AUDIT_FILE).read_text(encoding="utf-8").splitlines()]
            previous = [json.loads(line) for line in (directory / f"{hook.AUDIT_FILE}.1").read_text(encoding="utf-8").splitlines()]
            self.assertLessEqual((directory / hook.AUDIT_FILE).stat().st_size, 200)
            self.assertEqual(current[-1]["i"], 9)
            self.assertEqual([r["i"] for r in previous + current], list(range(previous[0]["i"], 10)))


class RegisterTest(unittest.IsolatedAsyncioTestCase):
    async def test_register_wires_one_async_gateway_hook_reading_profile_settings(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)

        class Ctx:
            profile_name = "tkt"

            def __init__(self) -> None:
                self.hooks = []
                self.state = SimpleNamespace(data_dir=Path(tmp.name) / "plugin-data" / "agent-plugin-x")
                self.asked = []

            def register_hook(self, name, callback):
                self.hooks.append((name, callback))

            def get_config(self, key, default=None):
                self.asked.append(key)
                return {"mode": "daily", "at": "04:00"}.get(key, default)

        ctx = Ctx()
        with self.assertLogs(hook.log, logging.INFO) as logs:
            handler = plugin.register(ctx)
        self.assertTrue(any("đã đăng ký hook pre_gateway_dispatch (hồ sơ tkt, tiến trình khác)" in line
                            for line in logs.output))
        [(name, callback)] = ctx.hooks
        self.assertEqual(name, "pre_gateway_dispatch")
        self.assertTrue(inspect.iscoroutinefunction(callback))
        self.assertTrue(any(p.kind is p.VAR_KEYWORD for p in inspect.signature(callback).parameters.values()))
        self.assertEqual(handler.profile, "tkt")
        handler._probes = FakeProbes()
        store = FakeStore()
        clock = Clock(datetime.now(UTC))
        gateway = FakeGateway(store, clock)
        src = Source()
        key = gateway._session_key_for_source(src)
        store.entries[key] = Entry(key, "s-old", datetime.now(UTC) - timedelta(days=2))
        await callback(event=Event("hi", src), gateway=gateway, session_store=store)
        self.assertEqual(len(gateway.reset_events), 1)
        self.assertEqual(set(ctx.asked), set(policy.SETTING_KEYS))
        line = (ctx.state.data_dir / hook.AUDIT_FILE).read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(json.loads(line)["profile"], "tkt")

    def test_gateway_process_detection(self):
        self.assertTrue(hook.is_gateway_process(["hermes", "--profile", "owner", "gateway", "run"]))
        self.assertFalse(hook.is_gateway_process(["hermes", "--profile", "owner", "plugins", "enable", "x"]))
        self.assertFalse(hook.is_gateway_process(["hermes", "gateway", "status"]))
        self.assertFalse(hook.is_gateway_process(["hermes", "run", "gateway"]))


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
        self.assertEqual(float(schema["process_max_age_hours"]["default"]), policy.DEFAULT_PROCESS_MAX_AGE_HOURS)
        defaults = {key: spec["default"] for key, spec in schema.items()}
        self.assertEqual(policy.parse_settings(defaults, zone_loader=no_tzdata).warnings, ())


if __name__ == "__main__":
    unittest.main()
