"""Chính sách làm mới phiên theo một mốc giờ cố định mỗi ngày.

Thuần Python, không import Hermes: phần nối vào gateway ở ``hook.py``. Mọi phép tính giờ nằm ở đây
để test bằng unittest stdlib.

Quy tắc: một phiên được làm mới khi nó **bắt đầu trước mốc gần nhất** (vd. 04:00 giờ Việt Nam hôm nay,
hoặc hôm qua nếu chưa tới 04:00). So bằng ``created_at`` của mục định tuyến chứ không bằng
``updated_at``: lượt chạy vắt qua mốc chạm ``updated_at`` sau mốc, nếu so ``updated_at`` thì phiên đó
thoát mốc cả ngày.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Mapping, Optional

PLUGIN_NAME = "ihome-session-reset"

MODE_DAILY = "daily"
MODE_OBSERVE = "observe"
MODE_OFF = "off"
MODES = (MODE_DAILY, MODE_OBSERVE, MODE_OFF)

KIND_DM = "dm"
KIND_GROUP = "group"
KINDS = (KIND_DM, KIND_GROUP)

DEFAULT_MODE = MODE_DAILY
DEFAULT_AT = "04:00"
DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh"
DEFAULT_APPLIES_TO = KINDS

SETTING_KEYS = ("mode", "at", "timezone", "applies_to")

# Như ``_DM_CHAT_TYPES`` trong gateway/slash_commands_session.py (Hermes 0.22.2): rỗng/không rõ là DM.
# Mọi chat_type khác (group, channel, thread, ...) tính là nhóm.
DM_CHAT_TYPES = frozenset({"dm", "direct", "private", ""})

# Việt Nam không dùng giờ mùa hè từ 1975, nên UTC+7 cố định vẫn đúng khi máy thiếu tzdata
# (Python trên Windows chưa cài gói ``tzdata``, image tối giản).
_FIXED_OFFSET_MINUTES = {
    "asia/ho_chi_minh": 7 * 60,
    "asia/saigon": 7 * 60,
    "utc": 0,
    "etc/utc": 0,
    "gmt": 0,
}
_OFFSET_RE = re.compile(r"^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$", re.IGNORECASE)
_AT_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


def _zoneinfo_loader(name: str) -> tzinfo:
    from zoneinfo import ZoneInfo

    return ZoneInfo(name)


def parse_at(raw: Any) -> tuple[int, int]:
    """Giờ:phút của mốc, CHỈ từ chuỗi ``"HH:MM"`` (``"4:00"`` cũng được). Số nguyên bị từ chối: YAML
    1.1 đọc ``4:00`` không ngoặc kép thành 240 (cơ số 60), ``0430`` thành 280 (bát phân), ``430`` là
    430 — đoán lại giờ từ các số đó dễ sai, nên ``ValueError`` để plugin tắt và báo."""
    if raw is None:
        raw = DEFAULT_AT
    if isinstance(raw, str):
        match = _AT_RE.match(raw.strip())
        if match:
            hour, minute = int(match.group(1)), int(match.group(2))
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return hour, minute
    raise ValueError(f"at={raw!r} phải là chuỗi \"HH:MM\" (ghi trong ngoặc kép)")


def resolve_timezone(name: Any, zone_loader: Optional[Callable[[str], tzinfo]] = None) -> tzinfo:
    """Múi giờ theo tên IANA (zoneinfo); thiếu tzdata thì dùng bảng UTC cố định (Asia/Ho_Chi_Minh =
    UTC+7) hoặc dạng ``+07:00``/``UTC+7``. Sai thì ``ValueError``."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"timezone={name!r} phải là chuỗi khác rỗng")
    text = name.strip()
    try:
        return (zone_loader or _zoneinfo_loader)(text)
    except Exception:
        pass
    fixed = _FIXED_OFFSET_MINUTES.get(text.lower())
    if fixed is not None:
        return timezone(timedelta(minutes=fixed), text)
    match = _OFFSET_RE.match(text)
    if match:
        sign = -1 if match.group(1) == "-" else 1
        hours, minutes = int(match.group(2)), int(match.group(3) or 0)
        if hours <= 14 and minutes <= 59:
            return timezone(sign * timedelta(hours=hours, minutes=minutes), text)
    raise ValueError(f"timezone={name!r} không nhận ra (cần tên IANA như Asia/Ho_Chi_Minh hoặc +07:00)")


def _parse_mode(raw: Any, warnings: list[str]) -> str:
    if raw is None:
        return DEFAULT_MODE
    if isinstance(raw, bool):
        # YAML 1.1 và ``hermes config set`` biến off/no/false thành False, on/yes/true thành True.
        return MODE_DAILY if raw else MODE_OFF
    if isinstance(raw, str) and raw.strip().lower() in MODES:
        return raw.strip().lower()
    warnings.append(f"mode={raw!r} không hợp lệ (daily|observe|off); tạm tắt cho an toàn")
    return MODE_OFF


def _parse_applies_to(raw: Any, warnings: list[str]) -> frozenset[str]:
    if raw is None:
        return frozenset(DEFAULT_APPLIES_TO)
    items = [raw] if isinstance(raw, str) else raw
    if not isinstance(items, (list, tuple, set, frozenset)):
        warnings.append(f"applies_to={raw!r} phải là danh sách [dm, group]; dùng mặc định")
        return frozenset(DEFAULT_APPLIES_TO)
    kinds: set[str] = set()
    for item in items:
        value = item.strip().lower() if isinstance(item, str) else None
        if value in ("all", "both", "*"):
            kinds.update(KINDS)
        elif value in KINDS:
            kinds.add(value)
        else:
            warnings.append(f"applies_to bỏ qua mục {item!r} (chỉ nhận dm, group, all)")
    if not kinds:
        warnings.append("applies_to không còn loại chat nào: không làm mới phiên nào")
    return frozenset(kinds)


@dataclass(frozen=True)
class Settings:
    """Cấu hình đã kiểm của một hồ sơ (``plugins.entries.ihome-session-reset.settings``)."""

    mode: str = DEFAULT_MODE
    at_hour: int = 4
    at_minute: int = 0
    timezone_name: str = DEFAULT_TIMEZONE
    tz: tzinfo = field(default_factory=lambda: timezone(timedelta(hours=7), DEFAULT_TIMEZONE))
    applies_to: frozenset[str] = frozenset(DEFAULT_APPLIES_TO)
    warnings: tuple[str, ...] = ()

    @property
    def active(self) -> bool:
        """Có xét làm mới không (``observe`` vẫn xét để ghi nhật ký, chỉ không đổi phiên)."""
        return self.mode != MODE_OFF and bool(self.applies_to)

    @property
    def reason(self) -> str:
        """Mã lý do dễ tìm trong log/sổ, vd. ``daily_reset_0400``."""
        return f"daily_reset_{self.at_hour:02d}{self.at_minute:02d}"


def parse_settings(
    raw: Optional[Mapping[str, Any]], *, zone_loader: Optional[Callable[[str], tzinfo]] = None,
) -> Settings:
    """Đọc mapping thô từ config; giá trị sai được thay bằng mặc định (hoặc tắt với ``mode``) và
    ghi vào ``warnings`` để log, không ném lỗi."""
    raw = raw if isinstance(raw, Mapping) else {}
    warnings: list[str] = []
    mode = _parse_mode(raw.get("mode"), warnings)
    try:
        at_hour, at_minute = parse_at(raw.get("at"))
    except ValueError as exc:
        warnings.append(f"{exc}; plugin tạm tắt cho an toàn, không đoán giờ")
        at_hour, at_minute = parse_at(DEFAULT_AT)
        mode = MODE_OFF
    tz_raw = raw.get("timezone")
    tz_name = DEFAULT_TIMEZONE if tz_raw is None else tz_raw
    try:
        tz = resolve_timezone(tz_name, zone_loader)
    except ValueError as exc:
        warnings.append(f"{exc}; dùng mặc định {DEFAULT_TIMEZONE}")
        tz_name, tz = DEFAULT_TIMEZONE, resolve_timezone(DEFAULT_TIMEZONE, zone_loader)
    applies_to = _parse_applies_to(raw.get("applies_to"), warnings)
    return Settings(
        mode=mode, at_hour=at_hour, at_minute=at_minute, timezone_name=str(tz_name), tz=tz,
        applies_to=applies_to, warnings=tuple(warnings),
    )


def _wall_clock(day, settings: Settings) -> datetime:
    return datetime(day.year, day.month, day.day, settings.at_hour, settings.at_minute, tzinfo=settings.tz)


def latest_boundary(now: datetime, settings: Settings) -> datetime:
    """Mốc làm mới gần nhất ``<= now`` (có múi giờ). Đúng mốc tính là đã qua mốc."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now phải có múi giờ")
    local_day = now.astimezone(settings.tz).date()
    boundary = _wall_clock(local_day, settings)
    if boundary > now:
        boundary = _wall_clock(local_day - timedelta(days=1), settings)
    return boundary


def to_aware(value: datetime, naive_tz: Optional[tzinfo] = None) -> datetime:
    """Gắn múi giờ cho thời điểm Hermes ghi. ``SessionEntry.created_at`` là ``datetime.now()`` không
    múi, tức giờ tường của tiến trình gateway (container ``hermes-owner`` chạy UTC). ``naive_tz`` chỉ
    để test; mặc định dùng luật giờ địa phương của tiến trình."""
    if value.tzinfo is not None and value.utcoffset() is not None:
        return value
    if naive_tz is not None:
        return value.replace(tzinfo=naive_tz)
    return value.astimezone()


def chat_kind(chat_type: Any) -> str:
    """``dm`` hoặc ``group`` theo ``SessionSource.chat_type``."""
    return KIND_DM if str(chat_type or "").strip().lower() in DM_CHAT_TYPES else KIND_GROUP


@dataclass(frozen=True)
class Decision:
    """Kết quả xét một phiên: ``reset`` cùng lý do ngắn để log/test."""

    reset: bool
    why: str
    kind: str = ""
    boundary: Optional[datetime] = None
    created_at: Optional[datetime] = None


def decide(
    settings: Settings, *, created_at: Any, chat_type: Any, now: datetime,
    naive_tz: Optional[tzinfo] = None,
) -> Decision:
    """Phiên bắt đầu lúc ``created_at`` có phải làm mới ở thời điểm ``now`` không."""
    if not settings.active:
        return Decision(False, "inactive")
    kind = chat_kind(chat_type)
    if kind not in settings.applies_to:
        return Decision(False, "kind_excluded", kind)
    if not isinstance(created_at, datetime):
        return Decision(False, "unknown_start", kind)
    boundary = latest_boundary(now, settings)
    try:
        created = to_aware(created_at, naive_tz)
    except (OverflowError, OSError, ValueError):
        # Hermes cố ý cho mốc thời gian hỏng "trông cũ" (session_recovery.py); coi như trước mốc.
        return Decision(True, "unreadable_start", kind, boundary)
    if created >= boundary:
        return Decision(False, "fresh", kind, boundary, created)
    return Decision(True, "crossed_boundary", kind, boundary, created)
