"""Tính mốc làm mới phiên: cấu hình, mốc 03:59/04:00/04:01, phiên vắt nhiều ngày, container chạy UTC."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from support import policy

UTC = timezone.utc
VN = timezone(timedelta(hours=7), "Asia/Ho_Chi_Minh")


def no_tzdata(name):
    """Như Python trên Windows chưa cài gói tzdata: zoneinfo không nạp được tên nào."""
    raise LookupError(f"no tzdata for {name}")


def vn(year, month, day, hour, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=VN)


def settings(**raw):
    return policy.parse_settings(raw, zone_loader=no_tzdata)


class SettingsTest(unittest.TestCase):
    def test_missing_config_means_0400_vietnam_for_dm_and_group(self):
        for raw in (None, {}, {"mode": None, "at": None, "timezone": None, "applies_to": None,
                                "process_max_age_hours": None}):
            s = policy.parse_settings(raw, zone_loader=no_tzdata)
            self.assertEqual(s.mode, "daily")
            self.assertEqual((s.at_hour, s.at_minute), (4, 0))
            self.assertEqual(s.timezone_name, "Asia/Ho_Chi_Minh")
            self.assertEqual(s.tz.utcoffset(datetime(2026, 10, 31)), timedelta(hours=7))
            self.assertEqual(s.applies_to, frozenset({"dm", "group"}))
            self.assertEqual((s.process_max_age_hours, s.process_max_age_seconds), (4.0, 4 * 3600.0))
            self.assertEqual(s.warnings, ())
            self.assertTrue(s.active)
            self.assertEqual(s.reason, "daily_reset_0400")

    def test_at_accepts_only_hh_mm_strings(self):
        cases = {"04:00": (4, 0), "4:00": (4, 0), " 05:30 ": (5, 30), "23:59": (23, 59), "00:00": (0, 0)}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                s = settings(at=raw)
                self.assertEqual((s.at_hour, s.at_minute), expected)
                self.assertEqual(s.warnings, ())
                self.assertEqual(s.mode, "daily")
        self.assertEqual(settings(at="05:30").reason, "daily_reset_0530")

    def test_numbers_and_bad_text_turn_the_plugin_off_instead_of_guessing(self):
        # YAML 1.1: `at: 4:00` → 240 (cơ số 60), `at: 0430` → 280 (bát phân), `at: 430` → 430.
        for raw in (4, 0, 24, 240, 280, 330, 430, 1439, True, 4.5, ["04:00"],
                    "4", "0430", "25:00", "4:60", "4h", "x", "04:00:00", ""):
            with self.subTest(raw=raw):
                s = settings(at=raw)
                self.assertEqual(s.mode, "off")
                self.assertFalse(s.active)
                self.assertEqual(len(s.warnings), 1)
                self.assertIn("HH:MM", s.warnings[0])

    def test_mode_values_and_yaml_booleans(self):
        self.assertEqual(settings(mode="observe").mode, "observe")
        self.assertEqual(settings(mode=" DAILY ").mode, "daily")
        off = settings(mode="off")
        self.assertEqual(off.mode, "off")
        self.assertFalse(off.active)
        # YAML 1.1 và `hermes config set ... off` cho False; on/yes/true cho True.
        self.assertEqual(settings(mode=False).mode, "off")
        self.assertEqual(settings(mode=True).mode, "daily")

    def test_unknown_mode_turns_off_rather_than_resetting(self):
        s = settings(mode="obsevre")
        self.assertEqual(s.mode, "off")
        self.assertFalse(s.active)
        self.assertEqual(len(s.warnings), 1)

    def test_applies_to_variants(self):
        self.assertEqual(settings(applies_to=["dm"]).applies_to, frozenset({"dm"}))
        self.assertEqual(settings(applies_to="group").applies_to, frozenset({"group"}))
        self.assertEqual(settings(applies_to=["all"]).applies_to, frozenset({"dm", "group"}))
        self.assertEqual(settings(applies_to=[" DM ", "Group"]).applies_to, frozenset({"dm", "group"}))
        partial = settings(applies_to=["dm", "channel"])
        self.assertEqual(partial.applies_to, frozenset({"dm"}))
        self.assertEqual(len(partial.warnings), 1)
        empty = settings(applies_to=[])
        self.assertEqual(empty.applies_to, frozenset())
        self.assertFalse(empty.active)
        not_a_list = settings(applies_to=5)
        self.assertEqual(not_a_list.applies_to, frozenset({"dm", "group"}))
        self.assertEqual(len(not_a_list.warnings), 1)

    def test_process_max_age_hours(self):
        """R2: tiến trình nền cũ hơn số giờ này không còn hoãn làm mới; giá trị sai dùng mặc định 4 giờ."""
        for raw, hours in ((1, 1.0), (1.5, 1.5), (0.25, 0.25), (168, 168.0)):
            with self.subTest(raw=raw):
                s = settings(process_max_age_hours=raw)
                self.assertEqual((s.process_max_age_hours, s.process_max_age_seconds), (hours, hours * 3600.0))
                self.assertEqual(s.warnings, ())
        for raw in (0, -1, 168.5, 10_000, True, False, "4", float("nan"), float("inf"), [4]):
            with self.subTest(raw=raw):
                s = settings(process_max_age_hours=raw)
                self.assertEqual(s.process_max_age_hours, 4.0)
                self.assertEqual(len(s.warnings), 1)
                self.assertIn("process_max_age_hours", s.warnings[0])
                self.assertEqual(s.mode, "daily")  # không tắt plugin: mặc định vẫn an toàn

    def test_timezone_prefers_zoneinfo(self):
        sentinel = timezone(timedelta(hours=7), "from-zoneinfo")
        s = policy.parse_settings({"timezone": "Asia/Ho_Chi_Minh"}, zone_loader=lambda name: sentinel)
        self.assertIs(s.tz, sentinel)

    def test_timezone_without_tzdata_uses_fixed_offsets(self):
        cases = {"Asia/Ho_Chi_Minh": 7 * 60, "asia/saigon": 7 * 60, "+07:00": 7 * 60, "UTC+7": 7 * 60,
                 "-03:30": -(3 * 60 + 30), "UTC": 0}
        for name, minutes in cases.items():
            with self.subTest(name=name):
                s = settings(timezone=name)
                self.assertEqual(s.tz.utcoffset(datetime(2026, 10, 31)), timedelta(minutes=minutes))
                self.assertEqual(s.warnings, ())

    def test_bad_timezone_falls_back_to_vietnam_with_warning(self):
        for raw in ("Mars/Olympus", "+15:00", "", 7):
            with self.subTest(raw=raw):
                s = settings(timezone=raw)
                self.assertEqual(s.timezone_name, "Asia/Ho_Chi_Minh")
                self.assertEqual(s.tz.utcoffset(datetime(2026, 10, 31)), timedelta(hours=7))
                self.assertEqual(len(s.warnings), 1)

    def test_vietnam_offset_is_plus7_with_or_without_tzdata(self):
        # Loader thật: có tzdata thì zoneinfo, không có thì bảng cố định; hai nhánh phải cùng kết quả.
        s = policy.parse_settings({"timezone": "Asia/Ho_Chi_Minh"})
        for moment in (datetime(2026, 1, 15, 12), datetime(2026, 7, 15, 12)):
            self.assertEqual(s.tz.utcoffset(moment), timedelta(hours=7))


class BoundaryTest(unittest.TestCase):
    s = settings()

    def test_0359_still_belongs_to_previous_day(self):
        self.assertEqual(policy.latest_boundary(vn(2026, 10, 31, 3, 59, 59), self.s), vn(2026, 10, 30, 4))

    def test_0400_exactly_is_the_new_boundary(self):
        self.assertEqual(policy.latest_boundary(vn(2026, 10, 31, 4), self.s), vn(2026, 10, 31, 4))

    def test_0401(self):
        self.assertEqual(policy.latest_boundary(vn(2026, 10, 31, 4, 1), self.s), vn(2026, 10, 31, 4))

    def test_clock_in_utc_like_the_container(self):
        # 21:00Z = 04:00 giờ Việt Nam hôm sau: mốc theo giờ VN, không theo ngày UTC của container.
        self.assertEqual(policy.latest_boundary(datetime(2026, 10, 30, 21, 0, tzinfo=UTC), self.s),
                         vn(2026, 10, 31, 4))
        self.assertEqual(policy.latest_boundary(datetime(2026, 10, 30, 20, 59, 59, tzinfo=UTC), self.s),
                         vn(2026, 10, 30, 4))

    def test_month_and_year_rollover(self):
        self.assertEqual(policy.latest_boundary(vn(2027, 1, 1, 0, 30), self.s), vn(2026, 12, 31, 4))
        self.assertEqual(policy.latest_boundary(vn(2026, 11, 1, 3), self.s), vn(2026, 10, 31, 4))

    def test_custom_time_and_zone(self):
        tokyo = settings(at="00:30", timezone="+09:00")
        self.assertEqual(policy.latest_boundary(datetime(2026, 10, 30, 15, 30, tzinfo=UTC), tokyo),
                         datetime(2026, 10, 31, 0, 30, tzinfo=timezone(timedelta(hours=9))))

    def test_naive_now_is_rejected(self):
        with self.assertRaises(ValueError):
            policy.latest_boundary(datetime(2026, 10, 31, 4), self.s)


class DecideTest(unittest.TestCase):
    s = settings()

    def decide(self, created_at, now, chat_type="dm", s=None, naive_tz=None):
        return policy.decide(s or self.s, created_at=created_at, chat_type=chat_type, now=now, naive_tz=naive_tz)

    def test_0359_0400_0401_for_a_session_opened_last_night(self):
        opened = vn(2026, 10, 30, 23, 0)
        before = self.decide(opened, vn(2026, 10, 31, 3, 59))
        self.assertFalse(before.reset)
        self.assertEqual(before.why, "fresh")
        at = self.decide(opened, vn(2026, 10, 31, 4, 0))
        self.assertTrue(at.reset)
        self.assertEqual(at.why, "crossed_boundary")
        self.assertEqual(at.boundary, vn(2026, 10, 31, 4))
        self.assertTrue(self.decide(opened, vn(2026, 10, 31, 4, 1)).reset)

    def test_session_opened_after_boundary_lives_until_next_boundary(self):
        opened = vn(2026, 10, 31, 4, 1)
        self.assertFalse(self.decide(opened, vn(2026, 10, 31, 23, 59)).reset)
        self.assertFalse(self.decide(opened, vn(2026, 11, 1, 3, 59)).reset)
        self.assertTrue(self.decide(opened, vn(2026, 11, 1, 4, 0)).reset)

    def test_session_opened_exactly_at_boundary_is_fresh(self):
        self.assertFalse(self.decide(vn(2026, 10, 31, 4), vn(2026, 10, 31, 4)).reset)

    def test_multi_day_session_resets_once_not_once_per_missed_day(self):
        since_17th = vn(2026, 10, 17, 9, 0)
        first = self.decide(since_17th, vn(2026, 10, 31, 8, 0))
        self.assertTrue(first.reset)
        self.assertEqual(first.boundary, vn(2026, 10, 31, 4))
        # Phiên mới mở lúc làm mới (08:00) thì các tin sau trong ngày giữ nguyên.
        self.assertFalse(self.decide(vn(2026, 10, 31, 8, 0, 1), vn(2026, 10, 31, 9, 0)).reset)

    def test_container_utc_naive_timestamp_after_boundary_is_kept(self):
        # Hermes ghi created_at = datetime.now() không múi; container chạy UTC.
        # 22:00 (UTC, 30/10) = 05:00 giờ VN 31/10, tức SAU mốc 04:00 hôm đó.
        created = datetime(2026, 10, 30, 22, 0)
        now = datetime(2026, 10, 31, 1, 0, tzinfo=UTC)  # 08:00 giờ VN
        self.assertFalse(self.decide(created, now, naive_tz=UTC).reset)
        # Hiểu nhầm giờ không múi là giờ VN (22:00 VN 30/10) sẽ làm mới sai.
        self.assertTrue(self.decide(created, now, naive_tz=VN).reset)

    def test_container_utc_naive_timestamp_just_before_boundary(self):
        created = datetime(2026, 10, 30, 20, 59)  # 03:59 giờ VN 31/10
        self.assertFalse(self.decide(created, datetime(2026, 10, 30, 20, 59, 59, tzinfo=UTC), naive_tz=UTC).reset)
        self.assertTrue(self.decide(created, datetime(2026, 10, 30, 21, 0, tzinfo=UTC), naive_tz=UTC).reset)

    def test_naive_timestamp_defaults_to_process_local_rules(self):
        naive = datetime(2026, 10, 30, 22, 0)
        self.assertEqual(policy.to_aware(naive), naive.astimezone())
        aware = vn(2026, 10, 30, 22, 0)
        self.assertIs(policy.to_aware(aware), aware)

    def test_aware_timestamp_in_any_zone(self):
        three_am_vn_in_utc = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)
        self.assertTrue(self.decide(three_am_vn_in_utc, vn(2026, 10, 31, 4)).reset)

    def test_dm_and_group_chat_types(self):
        for chat_type, kind in {"dm": "dm", "private": "dm", "direct": "dm", "": "dm", None: "dm",
                                "group": "group", "channel": "group", "thread": "group"}.items():
            with self.subTest(chat_type=chat_type):
                self.assertEqual(policy.chat_kind(chat_type), kind)
                decision = self.decide(vn(2026, 10, 30, 23), vn(2026, 10, 31, 4, 1), chat_type=chat_type)
                self.assertTrue(decision.reset)
                self.assertEqual(decision.kind, kind)

    def test_applies_to_excludes_a_chat_kind(self):
        dm_only = settings(applies_to=["dm"])
        group = self.decide(vn(2026, 10, 30, 23), vn(2026, 10, 31, 5), chat_type="group", s=dm_only)
        self.assertFalse(group.reset)
        self.assertEqual(group.why, "kind_excluded")
        self.assertTrue(self.decide(vn(2026, 10, 30, 23), vn(2026, 10, 31, 5), s=dm_only).reset)

    def test_off_never_resets(self):
        decision = self.decide(vn(2026, 10, 1, 9), vn(2026, 10, 31, 5), s=settings(mode="off"))
        self.assertFalse(decision.reset)
        self.assertEqual(decision.why, "inactive")

    def test_observe_still_reports_what_daily_would_do(self):
        self.assertTrue(self.decide(vn(2026, 10, 1, 9), vn(2026, 10, 31, 5), s=settings(mode="observe")).reset)

    def test_unknown_start_is_left_alone(self):
        decision = self.decide(None, vn(2026, 10, 31, 5))
        self.assertFalse(decision.reset)
        self.assertEqual(decision.why, "unknown_start")


if __name__ == "__main__":
    unittest.main()
