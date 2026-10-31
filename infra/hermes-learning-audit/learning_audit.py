#!/usr/bin/env python3
"""Kiểm học tập Hermes trên host VPS — CHỈ ĐỌC hồ sơ.

Quét mọi hồ sơ Hermes (skill local, bộ nhớ MEMORY.md/USER.md, sổ curator, state.db):

  a. tên tool CRM chết (không thuộc danh mục connector — lấy bằng cách `node` import catalog-names.mjs; thiếu
     module thì báo "không kiểm được tên", không đoán), skill local trùng tên skill chuẩn (đè bản chuẩn), và
     bài học về GHI dữ liệu CRM ⇒ ĐỀ XUẤT chờ duyệt (sở thích/cách nói chuyện/việc ngoài CRM thì tự áp dụng — chỉ đếm,
     không chép nội dung);
  b. số lần "bó tay" 24 giờ qua trên hồ sơ người dùng thật (kèm phiên, giờ, câu người dùng ngay trước — đã che, cắt ngắn).

Đầu ra trong `outDir`:
  - private/ (0700, chỉ user của job): báo cáo đủ `reports/learning-audit-<UTC>.json`, `latest.json`, `latest.txt`, `state.json`;
  - outbox/ (0750, nhóm ihome-hermes): `learning-outbox-<UTC>.json` CHỈ chứa đề xuất (đã che) cho job nạp CRM.
Stdout/journal chỉ một dòng JSON đếm số.

Dữ liệu hồ sơ do Hermes ghi ⇒ không tin: mọi chuỗi được làm sạch (surrogate lẻ, NUL, ký tự điều khiển), che bí mật và thông
tin cá nhân hiển nhiên, cắt ngắn TRƯỚC khi rời hồ sơ; một mục hỏng chỉ thành phát hiện, không làm hỏng cả lần chạy.
Không ghi gì vào thư mục hồ sơ: SQLite mở `mode=ro`, file chỉ đọc. Chỉ dùng thư viện chuẩn Python 3.10+.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

SCHEMA_VERSION = 1
VN_TZ = timezone(timedelta(hours=7))

DEFAULTS: dict[str, Any] = {
    # Host: /var/lib/ihome-hermes-profiles/owner/.hermes được mount vào container tại /home/hermes/.hermes.
    'profilesRoot': '/var/lib/ihome-hermes-profiles/owner/.hermes/profiles',
    'officialSkillsDir': '/var/lib/ihome-hermes-profiles/owner/.hermes/ihome-official-skills/current',
    'catalogModule': '/opt/ihome-hermes/current/infra/hermes-broker/catalog-names.mjs',
    'node': '/opt/ihome-hermes/node/bin/node',
    'catalogTimeoutSeconds': 30,
    # owner = người dùng thật; tkt/tkh/tkj nghiệm thu; abc1/abeager3 thử cũ.
    'realProfiles': ['owner'],
    # Phiên từ kênh người dùng thật (nguồn CLI thử nghiệm như `full50`, `verify-*` bị loại khỏi đếm "bó tay").
    'realSources': ['zalo_personal', 'zalo', 'telegram', 'discord', 'whatsapp', 'whatsapp_cloud', 'signal', 'slack',
                    'matrix', 'mattermost', 'email', 'sms', 'weixin', 'wecom', 'wecom_callback', 'feishu', 'dingtalk',
                    'bluebubbles', 'qqbot', 'yuanbao', 'relay'],
    'outDir': '/var/lib/ihome-hermes-learning-audit',
    'stateFile': '/var/lib/ihome-hermes-learning-audit/private/state.json',
    'windowHours': 24,
    'firstRunLookbackHours': 72,
    'keepReports': 30,
}
CONFIG_TYPES: dict[str, Any] = {
    'profilesRoot': str, 'officialSkillsDir': str, 'catalogModule': str, 'node': str, 'outDir': str, 'stateFile': str,
    'catalogTimeoutSeconds': (int, float), 'windowHours': (int, float), 'firstRunLookbackHours': (int, float),
    'keepReports': int, 'realProfiles': list, 'realSources': list,
}

MAX_TITLE = 200
MAX_CONTENT = 3500          # SQL nhận tới 4000 ký tự
MAX_SNIPPET = 220
MAX_USER_SNIPPET = 160
MAX_REFUSAL_ITEMS = 50
MAX_SEEN_LEDGER = 2000
MAX_SOURCE_BYTES = 2048     # dạng chữ jsonb; SQL nhận tới 4096
SQL_SOURCE_BYTES = 4096
MAX_NAME = 64               # một tên tool/mã thao tác trong lý do, phát hiện
MAX_NAMES = 10
MAX_DETECTED_AGE = timedelta(days=365)  # SQL nhận detectedAt trong [−400 ngày, +1 ngày]
MAX_DIFF_CELLS = 25_000_000
KINDS = ('skill_crm_write', 'memory_crm_write')
SKIP_SKILL_DIRS = {'.archive', '.hub', '.curator_backups', '.locks', 'node_modules', '__pycache__', '.git'}

# Tên tool CRM xuất hiện dạng trần `crm_task_create` hoặc dạng MCP `mcp__ihomecrm__crm_task_create`.
TOOL_RE = re.compile(r'(?<![A-Za-z0-9_])(?:mcp__[a-z0-9-]+__)?(crm_[a-z0-9]+(?:_[a-z0-9]+)*)(?![A-Za-z0-9_])')
# Mã thao tác của khung crm_action_* (trang.thao_tác), vd. `task.create`, `invoice.collect`.
ACTION_PAGES = ('expense', 'invoice', 'contract', 'task', 'probe', 'learning')
ACTION_RE = re.compile(r'(?<![A-Za-z0-9_.])((?:' + '|'.join(ACTION_PAGES) + r')\.[a-z][a-z0-9_]*)(?![A-Za-z0-9_])')

# Dấu hiệu bài học về GHI dữ liệu CRM (so trên chữ đã bỏ dấu, chữ thường).
# Tool ghi: một khúc của tên tool (crm_task_create, crm_room_pass_upsert) là động từ ghi — tách theo "_", không dùng regex lồng
# (tên dài bất thường không làm regex chạy bậc hai).
WRITE_VERBS = frozenset('create update upsert send cancel delete approve collect record lock assign close reopen write edit '
                        'set run schedule forget configure restore adjust confirm note'.split())
CRM_CONTEXT_RE = re.compile(r'\b(crm|phieu|hoa don|hop dong|cong viec|viec|phong|coc|thu chi|khach|toa|lich gui|'
                            r'invoice|contract|expense|task|room|deposit|tenant|lease|receipt|voucher)\b')
WRITE_VERB_RE = re.compile(r'\b(tao|ghi|sua|xoa|huy|duyet|thu tien|chi tien|khoa|giu phong|cap nhat|gui|chot|'
                           r'lap (?:phieu|hoa don|hop dong|viec)|thanh ly|tra phong|bao coc|dat coc|giao viec|danh dau|'
                           r'create|write|update|delete|cancel|approve|record|post|send|lock|assign|edit|save|submit|'
                           r'mark|settle|confirm)\b')

# Mẫu câu "bó tay" (trên chữ đã bỏ dấu). Mỗi mẫu một mã để thống kê.
REFUSAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('khong_kha_dung', re.compile(r'\b(?:khong|chua)\s+(?:con\s+)?kha\s+dung\b')),
    ('chua_co_trong_crm', re.compile(r'\b(?:chua|khong)\s+(?:co|ho\s+tro)\s+(?:san\s+)?(?:trong|tren)\s+(?:crm|he\s+thong)\b')),
    ('thieu_cong_cu', re.compile(r'\b(?:chua|khong)\s+(?:co|tim\s+thay|duoc\s+cap)\s+(?:cong\s+cu|tool|thao\s+tac|chuc\s+nang|quyen)\b')),
    ('khong_cho_phep', re.compile(r'\b(?:crm|he\s+thong|cong\s+cu|tool|ung\s+dung|phan\s+mem)\b[^.!?\n]{0,40}?'
                                  r'\b(?:khong|chua)\s+(?:cho\s+phep|ho\s+tro)\b')),
    ('khong_the_lam', re.compile(r'\b(?:em|minh|toi|bot)\s+(?:hien\s+|tam\s+thoi\s+|van\s+)?(?:khong|chua)\s+(?:the|duoc\s+phep)\s+[a-z]')),
    ('khong_lam_duoc', re.compile(r'\b(?:khong|chua)\s+(?:lam|thuc\s+hien|tao|ghi|sua|xoa|huy|khoa|gui)\s+duoc\b')),
    ('ngoai_kha_nang', re.compile(r'\b(?:ngoai|vuot)\s+(?:kha\s+nang|pham\s+vi)\b')),
    ('en_unavailable', re.compile(r'\b(?:not\s+available|unavailable|not\s+supported|not\s+permitted)\b')),
    ('en_cannot', re.compile(r"\b(?:i|we)\s+(?:cannot|can't|can not|am\s+unable\s+to|am\s+not\s+able\s+to)\b")),
]

# ---------------------------------------------------------------- làm sạch + che (trước khi dữ liệu rời hồ sơ)

_SURROGATES = re.compile('[\ud800-\udfff]')
_CONTROL_TEXT = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')   # giữ \t \n \r (nội dung nhiều dòng)
_CONTROL_ALL = re.compile(r'[\x00-\x1f\x7f]')
REDACTED = '[đã che]'

# Che bí mật và thông tin cá nhân hiển nhiên. Mọi lượng từ đều có trần (không chạy bậc hai trên chuỗi dài bất thường).
REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----'
                r'|[A-Za-z0-9+/=\s]{0,8000})'), '[khoá riêng đã che]'),
    (re.compile(r'(?i)\b((?:proxy-)?authorization)([ \t]*[:=][ \t]*)[^\n]{1,4096}'), r'\1\2' + REDACTED),
    (re.compile(r'(?i)\b(bearer)([ \t]+)[A-Za-z0-9._~+/=-]{8,4096}'), r'\1\2' + REDACTED),
    (re.compile(r'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,8192}\.[A-Za-z0-9_-]{6,8192}\.[A-Za-z0-9_-]{6,8192}'), '[JWT đã che]'),
    (re.compile(r'(?<![A-Za-z0-9])(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,512}'), '[khoá đã che]'),
    (re.compile(r'(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|sbp_[A-Za-z0-9]{20,255}|'
                r'sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,255}|xox[abprs]-[A-Za-z0-9-]{10,255}|AKIA[0-9A-Z]{16}|'
                r'AIza[0-9A-Za-z_-]{30,255})'), '[khoá đã che]'),
    (re.compile(r'(?i)\b(api[_-]?key|client[_-]?secret|secret|password|passwd|pwd|mat[ _-]?khau|mật[ _-]?khẩu|'
                r'access[_-]?token|refresh[_-]?token|token|access[_-]?key|private[_-]?key)'
                r'([ \t]*[:=][ \t]*)(["\']?)(?!\[)[^\s"\'<>]{4,512}'), r'\1\2\3' + REDACTED),
    (re.compile(r'(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}'), '[email đã che]'),
    (re.compile(r'(?i)\b(cccd|cmnd|cmt|căn cước|can cuoc|công dân|cong dan|hộ chiếu|ho chieu|passport)([^\d\n]{0,20})\d{8,12}(?!\d)'),
     r'\1\2[số giấy tờ đã che]'),
    (re.compile(r'(?i)\b(stk|số tk|so tk|số tài khoản|so tai khoan|tài khoản số|tai khoan so|account(?: number| no\.?)?)'
                r'([^\d\n]{0,20})\d[\d .-]{4,28}\d'), r'\1\2[số tài khoản đã che]'),
    (re.compile(r'(?<!\d)\d{12}(?!\d)'), '[số giấy tờ đã che]'),
    (re.compile(r'(?<![\w.,/+])(?:\+84|84|0)(?:[ .-]?\d){8,10}(?!\d)'), '[SĐT đã che]'),
]


def redact(text: str) -> str:
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def clean_text(value: Any, limit: int, multiline: bool = True, hide: bool = True) -> str:
    """Chuỗi an toàn để ghi báo cáo/gửi CRM: surrogate lẻ ⇒ U+FFFD, bỏ NUL/ký tự điều khiển, che bí mật/thông tin cá nhân
    (`hide`), rồi cắt ≤ `limit` ký tự. Không phải chuỗi/số ⇒ rỗng."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ''
    text = _SURROGATES.sub('�', str(value))
    if multiline:
        text = _CONTROL_TEXT.sub(' ', text.replace('\r\n', '\n').replace('\r', '\n'))
    else:
        text = ' '.join(_CONTROL_ALL.sub(' ', text).split())
    if hide:
        text = redact(text)
    text = text.strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + '…'


def clip(text: Any, limit: int) -> str:
    return clean_text(text, limit, multiline=True)


def one_line(text: Any, limit: int, hide: bool = True) -> str:
    return clean_text(text, limit, multiline=False, hide=hide)


def pg_json_bytes(value: Any) -> int:
    """Số byte dạng chữ jsonb của PostgreSQL (", " và ": " giữa phần tử) — đúng thứ CHECK của kho đề xuất đo."""
    return len(json.dumps(value, ensure_ascii=False, separators=(', ', ': ')).encode('utf-8', 'surrogatepass'))


def _clean_json(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if -(2 ** 53) < value < 2 ** 53 else None
    if isinstance(value, (str, float)):
        return one_line(value, 200)
    if isinstance(value, (list, tuple)):
        return [_clean_json(item, depth + 1) for item in list(value)[:MAX_NAMES]]
    if isinstance(value, dict):
        return {one_line(k, 40, hide=False): _clean_json(v, depth + 1) for k, v in list(value.items())[:16] if isinstance(k, str)}
    return None


def bounded_source(source: dict[str, Any]) -> dict[str, Any]:
    """Nguồn của đề xuất: chuỗi một dòng đã che ≤ 200 ký tự, ≤ 2 KiB dạng chữ jsonb; vượt ⇒ chỉ giữ khoá nhận diện."""
    out = _clean_json(source)
    if pg_json_bytes(out) > MAX_SOURCE_BYTES:
        keep = ('type', 'profile', 'ledgerId', 'file', 'entrySha256', 'at')
        out = {key: out[key] for key in keep if key in out}
        out['truncated'] = True
    return out


def valid_proposal(item: dict[str, Any], now: datetime) -> bool:
    """Đúng các quy tắc của SQL (hermes_store_learning_ingest_v1 + CHECK bảng): đề xuất lệch khuôn không được rời job."""
    title, content, source = item.get('title'), item.get('content'), item.get('source')
    detected = parse_ts(item.get('detectedAt'))
    return (isinstance(item.get('dedupeKey'), str) and re.fullmatch(r'[0-9a-f]{64}', item['dedupeKey']) is not None
            and item.get('kind') in KINDS
            and isinstance(title, str) and 1 <= len(title) <= 200 and bool(re.search(r'\S', title))
            and not _CONTROL_ALL.search(title) and not _SURROGATES.search(title)
            and isinstance(content, str) and 1 <= len(content) <= 4000 and bool(re.search(r'\S', content))
            and not _CONTROL_TEXT.search(content) and not _SURROGATES.search(content)
            and isinstance(source, dict) and pg_json_bytes(source) <= SQL_SOURCE_BYTES
            and not _SURROGATES.search(json.dumps(source, ensure_ascii=False)) and '\\u0000' not in json.dumps(source)
            and detected is not None and now - timedelta(days=399) <= detected <= now + timedelta(hours=23))


# ---------------------------------------------------------------- tiện ích chung

def fold(text: str) -> str:
    """Chữ thường, bỏ dấu tiếng Việt (đ→d) để so mẫu ổn định."""
    text = unicodedata.normalize('NFD', text.lower()).replace('đ', 'd')
    return ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_ts(value: Any) -> Optional[datetime]:
    """Mốc ISO-8601 ⇒ datetime UTC. Sai khuôn, quá dài, hoặc tràn khi đổi múi giờ (vd. năm 9999 lệch −14:00) ⇒ None."""
    if not isinstance(value, str) or not value or len(value) > 64:
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def vn(dt: datetime) -> str:
    return dt.astimezone(VN_TZ).strftime('%d/%m %H:%M')


def clamp(dt: datetime, low: datetime, high: datetime) -> datetime:
    return min(max(dt, low), high)


MAX_READ_BYTES = 4 * 1024 * 1024
# Tách riêng để test giả lập symlink được cả trên máy không có quyền tạo symlink (Windows).
_lstat = os.lstat


def canonical_root(path: Path) -> Path:
    """Gốc đã phân giải MỘT LẦN lúc bắt đầu (từ chối gốc là symlink). Mọi kiểm "nằm trong gốc" so với gốc ghim này, nên
    Hermes tráo thư mục hồ sơ thành symlink giữa chừng cũng không kéo được việc đọc ra ngoài."""
    if _is_link(path):
        raise OSError(f'gốc là symlink: {path}')
    return Path(os.path.realpath(path))


def _is_link(path: Path) -> bool:
    try:
        return stat.S_ISLNK(_lstat(path).st_mode)
    except OSError:
        return False


def _is_dir_no_follow(path: Path) -> bool:
    try:
        return stat.S_ISDIR(_lstat(path).st_mode)
    except OSError:
        return False


def _inside(root: Path, real: str) -> bool:
    try:
        return os.path.commonpath([os.path.normcase(str(root)), os.path.normcase(real)]) == os.path.normcase(str(root))
    except ValueError:
        return False


def open_inside(path: Path, root: Path, limit: int) -> Optional[int]:
    """Mở chỉ đọc một FILE THƯỜNG nằm TRONG `root` (gốc đã ghim). Job chạy với CAP_DAC_READ_SEARCH (đọc được mọi file
    trong sandbox) trong khi hồ sơ do Hermes ghi được ⇒ từ chối symlink (O_NOFOLLOW), file đặc biệt, file quá lớn, đường ra
    ngoài gốc; sau khi mở còn so dev/ino và (Linux) đường thật của fd qua /proc — thư mục giữa đường bị tráo cũng bị bắt."""
    before = _lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        return None
    if not _inside(root, os.path.realpath(path)):
        return None
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        held = os.fstat(fd)
        proc = f'/proc/self/fd/{fd}'
        if (held.st_dev, held.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(held.st_mode) \
                or held.st_size > limit or (os.path.exists(proc) and not _inside(root, os.readlink(proc))):
            os.close(fd)
            return None
        return fd
    except BaseException:
        os.close(fd)
        raise


def safe_read(path: Path, root: Path, limit: int = MAX_READ_BYTES) -> Optional[str]:
    """Nội dung văn bản của file qua `open_inside`; None nếu bị từ chối hoặc không đọc được."""
    try:
        fd = open_inside(path, root, limit)
        if fd is None:
            return None
        with os.fdopen(fd, 'rb') as handle:
            data = handle.read(limit + 1)
        # Như đọc chế độ văn bản: CRLF ⇒ LF (mục bộ nhớ ngăn bằng "\n§\n"). UTF-8 hỏng ⇒ U+FFFD (không có surrogate).
        return None if len(data) > limit else data.decode('utf-8', errors='replace').replace('\r\n', '\n')
    except (OSError, ValueError):
        return None


def safe_path(root: Path, relative: str) -> Optional[Path]:
    """Ghép đường tương đối lấy từ dữ liệu hồ sơ (vd. sổ curator): không tuyệt đối, không `..`, không `\\`, không ký tự lạ."""
    parts = relative.split('/')
    if not relative or len(relative) > 1024 or relative.startswith('/') or '\\' in relative or _CONTROL_ALL.search(relative) \
            or _SURROGATES.search(relative) or any(p in ('', '.', '..') for p in parts):
        return None
    return root.joinpath(*parts)


# ---------------------------------------------------------------- danh mục tên hợp lệ (connector)

CATALOG_JS = r'''
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
let capEff = null;
try { capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? null; } catch {}
const mod = await import(pathToFileURL(process.argv[1]).href);
if (typeof mod.catalogToolNames !== 'function' || typeof mod.catalogActionIds !== 'function') {
  throw new Error('catalog-names.mjs thiếu catalogToolNames()/catalogActionIds()');
}
const tools = await mod.catalogToolNames();
const actions = await mod.catalogActionIds();
process.stdout.write(JSON.stringify({ capEff, tools: [...tools], actions: [...actions] }));
'''


def _ambient_clear() -> Optional[Callable[[], None]]:
    """preexec_fn cho tiến trình node: xoá tập năng lực ambient (CAP_DAC_READ_SEARCH của unit) trước exec ⇒ mã của bản
    phát hành chạy KHÔNG có quyền đọc mọi file. Ngoài Linux (máy chạy test) không có năng lực để xoá ⇒ None."""
    if not sys.platform.startswith('linux'):
        return None
    import ctypes  # chỉ Linux; nạp trước fork để hàm chạy trong tiến trình con chỉ gọi prctl
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int

    def clear() -> None:
        if prctl(47, 4, 0, 0, 0) != 0:  # PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL
            raise OSError(ctypes.get_errno(), 'prctl(PR_CAP_AMBIENT_CLEAR_ALL)')
    return clear


def _node_env() -> dict[str, str]:
    if sys.platform.startswith('linux'):
        return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    return {k: v for k, v in os.environ.items() if k not in ('NODE_OPTIONS', 'NODE_PATH')}


def load_catalog(cfg: dict[str, Any]) -> dict[str, Any]:
    module = Path(cfg['catalogModule'])
    base = {'module': str(module), 'tools': [], 'actions': []}
    try:
        if not module.is_file():
            return {**base, 'status': 'unavailable', 'reason': 'thiếu module catalog-names.mjs trên host'}
        node = cfg['node'] if Path(cfg['node']).is_file() else 'node'
        try:
            drop = _ambient_clear()
        except (OSError, AttributeError):
            return {**base, 'status': 'unavailable', 'reason': 'không hạ được đặc quyền cho tiến trình node'}
        done = subprocess.run([node, '--input-type=module', '-e', CATALOG_JS, str(module)], capture_output=True,
                              timeout=float(cfg['catalogTimeoutSeconds']), cwd=str(module.parent), env=_node_env(),
                              preexec_fn=drop)
    except (OSError, subprocess.SubprocessError) as error:
        return {**base, 'status': 'unavailable', 'reason': f'không chạy được node ({type(error).__name__})'}
    return parse_catalog_output(base, done.returncode, done.stdout, done.stderr)


def parse_catalog_output(base: dict[str, Any], returncode: int, stdout: bytes, stderr: bytes) -> dict[str, Any]:
    if returncode != 0:
        lines = stderr.decode('utf-8', 'replace').strip().splitlines()
        return {**base, 'status': 'unavailable', 'reason': f'node thoát mã {returncode}: {one_line(lines[-1] if lines else "", 200)}'}
    try:
        data = json.loads(stdout.decode('utf-8', 'replace'))
        tools = sorted({strip_mcp(one_line(name, 160, hide=False)) for name in data['tools'] if isinstance(name, str) and name})
        actions = sorted({one_line(name, 160, hide=False) for name in data['actions'] if isinstance(name, str) and name})
        cap = data.get('capEff')
    except (ValueError, KeyError, TypeError, AttributeError):
        return {**base, 'status': 'unavailable', 'reason': 'đầu ra catalog-names.mjs lệch khuôn'}
    if isinstance(cap, str) and re.fullmatch(r'[0-9a-fA-F]{1,16}', cap) and int(cap, 16) != 0:
        return {**base, 'status': 'unavailable', 'reason': 'tiến trình node còn đặc quyền (CapEff khác 0) — không dùng danh mục'}
    if not tools:
        return {**base, 'status': 'unavailable', 'reason': 'danh mục tool rỗng'}
    return {**base, 'status': 'ok', 'tools': tools, 'actions': actions}


def strip_mcp(name: str) -> str:
    match = re.fullmatch(r'mcp__[a-z0-9-]+__(.+)', name)
    return match.group(1) if match else name


# ---------------------------------------------------------------- skill

def parse_frontmatter(text: str) -> dict[str, str]:
    """Khoá cấp một của frontmatter YAML đơn giản (không cần PyYAML)."""
    if not text.startswith('---'):
        return {}
    end = text.find('\n---', 3)
    if end < 0:
        return {}
    out: dict[str, str] = {}
    for line in text[3:end].splitlines():
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$', line)
        if match:
            out[match.group(1)] = match.group(2).strip().strip('"\'')
    return out


def iter_skill_files(root: Path) -> Iterable[Path]:
    """SKILL.md dưới `root` (gốc đã kiểm không phải symlink); thư mục con là symlink không được theo."""
    if not _is_dir_no_follow(root):
        return
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_SKILL_DIRS and not d.startswith('.'))
        for name in sorted(files):
            if name == 'SKILL.md':
                yield Path(current) / name


def skill_package_texts(skill_md: Path, read: Callable[[Path], Optional[str]]) -> list[tuple[Path, str]]:
    """SKILL.md + các .md đi kèm trong cùng gói skill (references/…), đọc qua `read` (đọc an toàn, tự ghi nhận file bị từ chối)."""
    out: list[tuple[Path, str]] = []
    for current, dirs, files in os.walk(skill_md.parent, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_SKILL_DIRS and not d.startswith('.'))
        for name in sorted(files):
            if name.endswith('.md'):
                text = read(Path(current) / name)
                if text is not None:
                    out.append((Path(current) / name, text))
    return out


def skill_names(skill_md: Path, text: str) -> set[str]:
    names = {skill_md.parent.name}
    declared = parse_frontmatter(text).get('name')
    if declared:
        names.add(declared)
    return names


def load_official(cfg: dict[str, Any]) -> dict[str, Any]:
    configured = Path(cfg['officialSkillsDir'])
    try:
        if not configured.is_dir():
            return {'status': 'missing', 'dir': str(configured), 'skills': []}
        root = Path(os.path.realpath(configured))  # `current` là symlink tới bản phát hành: chỉ đọc file bên trong bản đó
        names: set[str] = set()
        for skill_md in iter_skill_files(root):
            text = safe_read(skill_md, root)
            if text is not None:
                names |= {one_line(name, 160, hide=False) for name in skill_names(skill_md, text)}
        return {'status': 'ok', 'dir': str(configured), 'skills': sorted(names)}
    except Exception as error:  # noqa: BLE001 — một bước hỏng không làm hỏng cả lần kiểm
        return {'status': 'error', 'dir': str(configured), 'skills': [], 'reason': type(error).__name__}


# ---------------------------------------------------------------- phân loại

def _names(items: Iterable[str]) -> list[str]:
    out = []
    for name in sorted(set(items))[:MAX_NAMES]:
        out.append(name if len(name) <= MAX_NAME else name[: MAX_NAME - 1] + '…')
    return out


def write_tools(folded: str) -> list[str]:
    return [m.group(1) for m in TOOL_RE.finditer(folded) if any(part in WRITE_VERBS for part in m.group(1).split('_')[1:])]


def crm_write_reasons(text: str) -> list[str]:
    """Lý do coi đoạn văn là bài học về GHI dữ liệu CRM (rỗng = không phải). Tên trong lý do bị cắt (≤ 64 ký tự, ≤ 5 tên)."""
    folded = fold(text)
    reasons: list[str] = []
    if 'crm_action_run' in folded or 'confirmtoken' in folded:
        reasons.append('nhắc crm_action_run / confirmToken')
    actions = _names(ACTION_RE.findall(folded))[:5]
    if actions:
        reasons.append('mã thao tác ' + ', '.join(actions))
    tools = _names(write_tools(folded))[:5]
    if tools:
        reasons.append('tool ghi ' + ', '.join(tools))
    if not reasons and CRM_CONTEXT_RE.search(folded) and WRITE_VERB_RE.search(folded):
        reasons.append('ý định ghi trong ngữ cảnh CRM')
    return reasons


def dead_names(text: str, catalog: dict[str, Any]) -> tuple[list[str], list[str]]:
    if catalog['status'] != 'ok':
        return [], []
    tools = set(catalog['tools'])
    actions = set(catalog['actions'])
    dead_tools = _names({m.group(1) for m in TOOL_RE.finditer(text)} - tools)
    dead_actions = _names(set(ACTION_RE.findall(text)) - actions) if actions else []
    return dead_tools, dead_actions


SEGMENT_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"“(`*\-])|\n+')


def segments(text: str) -> list[str]:
    return [s.strip() for s in SEGMENT_SPLIT.split(text) if s and s.strip()]


def added_segments(before: Optional[str], after: Optional[str]) -> list[str]:
    """Các câu/dòng có trong bản sau mà không có trong bản trước (chèn hoặc thay)."""
    if after is None:
        return []
    new = segments(after)
    if before is None:
        return new
    old = segments(before)
    if len(old) * len(new) > MAX_DIFF_CELLS:
        # File lớn bất thường: so tập (tuyến tính) thay cho so dãy (bậc hai) — thận trọng, có thể nêu thừa câu lặp.
        known = set(old)
        return [s for s in new if s not in known]
    out: list[str] = []
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag in ('insert', 'replace'):
            out.extend(new[j1:j2])
    return out


# ---------------------------------------------------------------- trạng thái job (ngoài hồ sơ)

def _str_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def load_state(path: Optional[Path]) -> dict[str, Any]:
    """Trạng thái lần trước; hỏng/lệch khuôn từng phần thì bỏ đúng phần đó (coi như lần đầu cho hồ sơ đó)."""
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get('schemaVersion') != SCHEMA_VERSION:
        return {}
    profiles: dict[str, Any] = {}
    for name, prior in (data.get('profiles') or {}).items() if isinstance(data.get('profiles'), dict) else []:
        if not isinstance(name, str) or not isinstance(prior, dict):
            continue
        hashes = prior.get('skillHashes')
        profiles[name] = {'ledgerSeen': _str_list(prior.get('ledgerSeen')), 'memoryHashes': _str_list(prior.get('memoryHashes')),
                          'skillHashes': {k: v for k, v in hashes.items() if isinstance(k, str) and isinstance(v, str)}
                          if isinstance(hashes, dict) else {}}
    last = data.get('lastRunAt')
    return {'schemaVersion': SCHEMA_VERSION, 'lastRunAt': last if isinstance(last, str) else None, 'profiles': profiles}


def ensure_dir(path: Path, mode: int) -> Path:
    """Thư mục đầu ra của job: tạo nếu thiếu, không nhận symlink, đặt đúng quyền (private 0700, outbox 0750)."""
    path.mkdir(parents=True, exist_ok=True)
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise OSError(f'không phải thư mục thường: {path}')
    os.chmod(path, mode)
    return path


def write_atomic(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.name}.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def json_bytes(value: Any, indent: Optional[int] = None) -> bytes:
    """JSON thuần ASCII: không bao giờ lỗi mã hoá khi ghi (surrogate lọt lưới vẫn thành chuỗi thoát hợp lệ)."""
    return (json.dumps(value, ensure_ascii=True, indent=indent) + '\n').encode('ascii')


# ---------------------------------------------------------------- một hồ sơ

class ProfileAudit:
    def __init__(self, name: str, root: Path, profiles_root: Path, cfg: dict[str, Any], catalog: dict[str, Any],
                 official: dict[str, Any], prior: dict[str, Any], now: datetime):
        # Gốc hồ sơ ghim một lần (không phải symlink, nằm trong gốc hồ sơ đã ghim); mọi file chỉ được đọc khi nằm trong gốc này.
        self.root = canonical_root(root)
        if not _inside(profiles_root, str(self.root)):
            raise OSError('hồ sơ nằm ngoài thư mục hồ sơ')
        self.name, self.cfg, self.catalog, self.official, self.prior, self.now = name, cfg, catalog, official, prior, now
        self.real = name in cfg['realProfiles']
        self.findings: list[dict[str, Any]] = []
        self.proposals: list[dict[str, Any]] = []
        self.auto_applied: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.next_state: dict[str, Any] = {}
        self.counts: dict[str, int] = {}
        self._changed_files: set[str] = set()
        self._refused: set[str] = set()

    # -- tiện ích
    def finding(self, kind: str, severity: str, detail: str, **extra: Any) -> None:
        """Phát hiện: mọi chuỗi (đường file, tên skill, tên tool lấy từ hồ sơ) đã làm sạch, che và cắt."""
        item: dict[str, Any] = {'kind': kind, 'severity': severity, 'detail': one_line(detail, 400)}
        for key, value in extra.items():
            if isinstance(value, (list, tuple)):
                item[key] = [one_line(v, 160) for v in list(value)[:20]]
            elif isinstance(value, bool) or value is None:
                item[key] = value
            else:
                item[key] = one_line(value, 300)
        self.findings.append(item)

    def error(self, text: str) -> None:
        self.errors.append(one_line(text, 300))

    def read(self, path: Path, limit: int = MAX_READ_BYTES) -> Optional[str]:
        """Đọc an toàn trong hồ sơ. File CÓ mà bị từ chối (symlink, file đặc biệt, quá lớn, ra ngoài hồ sơ) ⇒ phát hiện mức
        cao: không để Hermes né kiểm bằng cách biến bộ nhớ/skill thành symlink."""
        text = safe_read(path, self.root, limit)
        if text is None and os.path.lexists(path):
            self.refuse(self.rel(path), 'không đọc an toàn được (symlink/file đặc biệt/quá lớn/ra ngoài hồ sơ)')
        return text

    def refuse(self, rel: str, why: str) -> None:
        if rel not in self._refused:
            self._refused.add(rel)
            self.finding('unsafe_profile_file', 'high', f'{rel}: {why} — đã bỏ qua, cần xem tay', file=rel)

    def subdir(self, *parts: str) -> Optional[Path]:
        """Thư mục con của hồ sơ (skills, memories, .curator_backups/blobs): không có ⇒ None; là symlink/không phải thư mục ⇒
        phát hiện mức cao và None (không đọc gì bên trong)."""
        path = self.root.joinpath(*parts)
        try:
            info = _lstat(path)
        except OSError:
            return None
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            self.refuse('/'.join(parts), 'thư mục là symlink hoặc không phải thư mục')
            return None
        return path

    def proposal(self, kind: str, title: str, content: str, source: dict[str, Any], detected_at: datetime,
                 source_ref: str) -> None:
        content = clip(content, MAX_CONTENT)
        normalized = ' '.join(content.split())
        if not normalized:
            return
        key = sha256_hex(f'{self.name}|{kind}|{source_ref}|{normalized}')
        if any(p['dedupeKey'] == key for p in self.proposals):
            return
        # Tiêu đề một dòng (nội dung bộ nhớ/skill có thể nhiều dòng): CHECK của SQL và bộ nạp từ chối ký tự xuống dòng.
        heading = one_line(title, MAX_TITLE) or one_line(normalized, MAX_TITLE)
        # Mốc phát hiện trong cửa sổ SQL nhận: không ở tương lai, không quá cũ.
        detected = clamp(detected_at, self.now - MAX_DETECTED_AGE, self.now)
        item = {'dedupeKey': key, 'kind': kind, 'title': heading, 'content': content,
                'source': bounded_source({'profile': self.name, **source}), 'detectedAt': iso(detected)}
        if not valid_proposal(item, self.now):
            self.finding('proposal_dropped', 'high', 'đề xuất lệch khuôn kho CRM — không gửi, cần xem tay', dedupeKey=key)
            return
        self.proposals.append(item)

    def rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return path.as_posix()

    # -- a. skill local + bộ nhớ
    def scan_skills(self) -> None:
        skills_root = self.subdir('skills')
        hashes: dict[str, str] = {}
        local = 0
        official_names = set(self.official['skills'])
        prior_hashes = self.prior.get('skillHashes', {}) if self.prior else {}
        for skill_md in iter_skill_files(skills_root) if skills_root is not None else []:
            local += 1
            try:
                self._scan_skill(skill_md, hashes, official_names)
            except Exception as error:  # noqa: BLE001 — một skill hỏng chỉ thành phát hiện
                self.finding('skill_scan_error', 'medium', f'{self.rel(skill_md)}: không kiểm được ({type(error).__name__})',
                             file=self.rel(skill_md))
        self.counts['localSkills'] = local
        if prior_hashes:
            changed = sorted(k for k, v in hashes.items() if prior_hashes.get(k) != v)
            self.counts['skillFilesChanged'] = len(changed)
            self._changed_files = set(changed)
        self.next_state['skillHashes'] = hashes

    def _scan_skill(self, skill_md: Path, hashes: dict[str, str], official_names: set[str]) -> None:
        texts = skill_package_texts(skill_md, self.read)
        main = next((t for p, t in texts if p == skill_md), '')
        names = skill_names(skill_md, main)
        rel = self.rel(skill_md)
        label = parse_frontmatter(main).get('name') or skill_md.parent.name
        for path, text in texts:
            hashes[self.rel(path)] = sha256_hex(text)
            dead_tools, dead_actions = dead_names(text, self.catalog)
            if dead_tools:
                self.finding('dead_tool_name', 'high', f'{self.rel(path)}: tên tool không còn trong danh mục CRM',
                             file=self.rel(path), skill=label, names=dead_tools)
            if dead_actions:
                self.finding('dead_action_id', 'high', f'{self.rel(path)}: mã thao tác không còn trong danh mục',
                             file=self.rel(path), skill=label, names=dead_actions)
        shadow = sorted(names & official_names)
        if shadow:
            self.finding('shadows_official_skill', 'high',
                         f'{rel}: skill local trùng tên skill chuẩn ⇒ Hermes nạp bản local, bỏ bản chuẩn',
                         file=rel, skill=label, names=shadow)
        elif self.official['status'] == 'ok' and TOOL_RE.search(main):
            self.finding('local_crm_skill', 'medium',
                         f'{rel}: skill local nhắc tool CRM ngoài bộ skill chuẩn (có thể lệch hướng dẫn chuẩn)',
                         file=rel, skill=label)

    def scan_memory(self) -> None:
        seen_before = set(self.prior.get('memoryHashes', [])) if self.prior else set()
        first_run = not self.prior
        current: list[str] = []
        entries = 0
        memories = self.subdir('memories')
        for file_name in ('MEMORY.md', 'USER.md') if memories is not None else ():
            text = self.read(memories / file_name)
            if text is None:
                continue
            for entry in (e.strip() for e in text.split('\n§\n')):
                if not entry:
                    continue
                entries += 1
                digest = sha256_hex(entry)
                current.append(digest)
                try:
                    self._memory_entry(file_name, entry, digest, digest in seen_before, first_run)
                except Exception as error:  # noqa: BLE001
                    self.finding('memory_entry_error', 'medium',
                                 f'memories/{file_name}: một mục bộ nhớ không kiểm được ({type(error).__name__})',
                                 file=f'memories/{file_name}', entrySha256=digest)
        self.counts['memoryEntries'] = entries
        self.next_state['memoryHashes'] = sorted(set(current))

    def _memory_entry(self, file_name: str, entry: str, digest: str, seen: bool, first_run: bool) -> None:
        dead_tools, dead_actions = dead_names(entry, self.catalog)
        if dead_tools or dead_actions:
            self.finding('dead_tool_name' if dead_tools else 'dead_action_id', 'high',
                         f'memories/{file_name}: mục bộ nhớ nhắc tên không còn trong danh mục',
                         file=f'memories/{file_name}', names=dead_tools + dead_actions)
        if seen:
            return
        reasons = crm_write_reasons(entry)
        source = {'type': 'memory', 'file': f'memories/{file_name}', 'entrySha256': digest, 'firstRun': first_run}
        if reasons:
            self.proposal('memory_crm_write', f'Bộ nhớ {file_name}: {one_line(entry, 120)}', entry,
                          {**source, 'reasons': reasons}, self.now, f'memory:{file_name}:{digest}')
        else:
            # Tự áp dụng: chỉ ghi nhận có mục mới (băm), KHÔNG chép nội dung bộ nhớ của người dùng ra báo cáo.
            self.auto_applied.append({'kind': 'memory_preference', 'source': source})

    def scan_ledger(self) -> None:
        skills_root = self.subdir('skills')
        text = self.read(skills_root / '.curator_ledger.jsonl', limit=32 * 1024 * 1024) if skills_root is not None else None
        prior_seen = list(self.prior.get('ledgerSeen', [])) if self.prior else []
        seen = set(prior_seen)
        if self.prior:
            last_run = parse_ts(self.prior.get('lastRunAt')) or (self.now - timedelta(hours=float(self.cfg['firstRunLookbackHours'])))
            floor = min(last_run, self.now) - timedelta(days=7)
        else:
            floor = self.now - timedelta(hours=float(self.cfg['firstRunLookbackHours']))
        lines = text.splitlines() if text is not None else []
        bad = 0
        fresh = 0
        order = list(prior_seen)
        covered: set[str] = set()
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except (ValueError, RecursionError):
                bad += 1
                continue
            if not isinstance(entry, dict):
                bad += 1
                continue
            entry_id = one_line(entry.get('id'), 80, hide=False) or sha256_hex(line)[:12]
            if entry_id in seen:
                continue
            # Ghi "đã thấy" TRƯỚC khi xử lý: mục hỏng không bị xử lý lại mãi, trạng thái vẫn tiến.
            seen.add(entry_id)
            order.append(entry_id)
            ts = parse_ts(entry.get('ts'))
            if ts is None or ts < floor:
                continue
            fresh += 1
            try:
                self._ledger_entry(entry, entry_id, clamp(ts, floor, self.now), covered)
            except Exception as error:  # noqa: BLE001 — một mục sổ hỏng chỉ thành phát hiện
                self.finding('ledger_entry_error', 'medium',
                             f'sổ curator mục {entry_id}: không xử lý được ({type(error).__name__}) — bỏ qua, cần xem tay',
                             ledgerId=entry_id)
        if bad:
            self.error(f'{bad} dòng sổ curator không đọc được')
        uncovered = sorted(f for f in self._changed_files if f not in covered)
        if uncovered:
            self.finding('skill_changed_without_ledger', 'medium',
                         'skill đổi từ lần chạy trước mà sổ curator không ghi nhận', files=uncovered)
        self.counts['ledgerEntries'] = len(lines)
        self.counts['ledgerNew'] = fresh
        self.next_state['ledgerSeen'] = order[-MAX_SEEN_LEDGER:]

    def _blob(self, digest: Any) -> Optional[str]:
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            return None
        blobs = self.subdir('.curator_backups', 'blobs')
        return self.read(blobs / digest) if blobs is not None else None

    def _ledger_entry(self, entry: dict[str, Any], entry_id: str, ts: datetime, covered: set[str]) -> None:
        actor = one_line(entry.get('actor'), 40, hide=False)
        action = one_line(entry.get('action'), 40, hide=False)
        skill = one_line(entry.get('skill'), 120)
        evidence = entry.get('evidence') if isinstance(entry.get('evidence'), dict) else {}
        session_id = one_line(evidence.get('session_id'), 120, hide=False) or None
        source = {'type': 'curator_ledger', 'ledgerId': entry_id, 'actor': actor, 'action': action, 'skill': skill,
                  'sessionId': session_id, 'at': iso(ts)}
        if actor == 'user':
            return  # người dùng tự sửa skill: không phải "học".
        if action not in ('create', 'patch'):
            self.auto_applied.append({'kind': 'skill_lifecycle', 'source': bounded_source(source)})
            return

        skills_root = self.subdir('skills')
        if skills_root is None:
            return
        rejected: list[str] = []

        def by_file(items: Any) -> dict[str, Any]:
            out: dict[str, Any] = {}
            for item in items if isinstance(items, list) else []:
                if not (isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'].endswith('.md')):
                    continue
                # Đường lấy từ sổ (Hermes ghi được): phải nằm dưới skills/, không `..`, không tuyệt đối, không ký tự lạ —
                # mục lạ bị bỏ thay vì đọc ngoài hồ sơ, và được báo (không mất im lặng).
                rel = item['path'].split('/skills/', 1)[1] if '/skills/' in item['path'] else ''
                if rel and safe_path(skills_root, rel) is not None:
                    out[rel] = item.get('sha256')
                else:
                    rejected.append(item['path'])
            return out

        before, after = by_file(entry.get('before')), by_file(entry.get('after'))
        if rejected:
            self.finding('ledger_path_rejected', 'medium',
                         f'sổ curator mục {entry_id}: {len(rejected)} đường file không nằm dưới skills/ hoặc có `..` — bỏ qua, cần xem tay',
                         ledgerId=entry_id, paths=sorted(set(rejected))[:10])
        added: list[str] = []
        diff_missing = False
        for rel, digest in sorted(after.items()):
            covered.add(f'skills/{rel}')
            new_text = self._blob(digest)
            if new_text is None:
                # Blob đã bị dọn: so bằng nội dung hiện tại (có thể gồm cả thay đổi sau đó) — ghi rõ trong nguồn.
                diff_missing = True
                current = safe_path(skills_root, rel)
                new_text = self.read(current) if current is not None else None
            if rel in before:
                old_text = self._blob(before[rel])
                if old_text is None:
                    # Không dựng được bản trước: coi cả file là "thêm" (thận trọng — để chủ xem).
                    diff_missing = True
                    added.extend(segments(new_text or ''))
                    continue
                added.extend(added_segments(old_text, new_text))
            else:
                added.extend(added_segments(None, new_text))
        text = '\n'.join(dict.fromkeys(s for s in added if s))
        if not text:
            return
        source['diffUnavailable'] = diff_missing
        reasons = crm_write_reasons(text)
        crm_skill = 'crm' in fold(skill) or bool(TOOL_RE.search(text))
        verb = 'tạo' if action == 'create' else 'sửa'
        if reasons:
            # Chỉ lấy các câu thật sự nói về ghi CRM để chủ đọc nhanh; thiếu thì giữ cả đoạn thêm.
            focused = [s for s in added if crm_write_reasons(s)] or added
            self.proposal('skill_crm_write', f'Skill {skill}: {actor} {verb} lúc {vn(ts)} — bài học ghi CRM',
                          '\n'.join(dict.fromkeys(focused)), {**source, 'reasons': reasons, 'crmSkill': crm_skill},
                          ts, f'ledger:{entry_id}')
        else:
            self.auto_applied.append({'kind': 'skill_preference', 'source': bounded_source(source)})

    # -- b. "bó tay"
    def scan_refusals(self) -> Optional[dict[str, Any]]:
        if not self.real:
            return None
        db_path = self.root / 'state.db'
        if not os.path.lexists(db_path):
            return {'status': 'missing', 'count': 0, 'byPattern': {}, 'items': []}
        if not regular_inside(db_path, self.root):
            self.error('state.db không phải file thường trong hồ sơ (symlink/đường lạ) — bỏ qua')
            return {'status': 'error', 'count': 0, 'byPattern': {}, 'items': []}
        since = self.now - timedelta(hours=float(self.cfg['windowHours']))
        try:
            rows, users = read_refusal_rows(db_path, since.timestamp(), self.now.timestamp(), self.cfg['realSources'], self.root)
        except (sqlite3.Error, OSError) as error:
            self.error(f'state.db không đọc được: {type(error).__name__}')
            return {'status': 'error', 'count': 0, 'byPattern': {}, 'items': []}
        by_pattern: dict[str, int] = {}
        items: list[dict[str, Any]] = []
        sessions: set[str] = set()
        broken = 0
        for session_id, source, ts, content in rows:
            try:
                folded = fold(content)
                hits = [code for code, rx in REFUSAL_PATTERNS if rx.search(folded)]
                if not hits:
                    continue
                when = datetime.fromtimestamp(ts, tz=timezone.utc)
                previous = users.get((session_id, ts))
                item = {'sessionId': one_line(session_id, 120, hide=False), 'source': one_line(source, 40, hide=False),
                        'at': iso(when), 'atVn': vn(when), 'patterns': hits, 'assistant': snippet(content, hits),
                        'previousUser': clip(previous or '', MAX_USER_SNIPPET) or None}
            except (ValueError, OverflowError, OSError, TypeError):
                broken += 1
                continue
            for code in hits:
                by_pattern[code] = by_pattern.get(code, 0) + 1
            sessions.add(item['sessionId'])
            items.append(item)
        if broken:
            self.error(f'{broken} tin nhắn trong state.db lệch khuôn — bỏ qua')
        items.sort(key=lambda item: item['at'], reverse=True)
        return {'status': 'ok', 'windowFrom': iso(since), 'count': len(items), 'sessions': len(sessions),
                'byPattern': dict(sorted(by_pattern.items())), 'items': items[:MAX_REFUSAL_ITEMS]}

    def run(self) -> dict[str, Any]:
        for step in (self.scan_skills, self.scan_memory, self.scan_ledger):
            try:
                step()
            except Exception as error:  # noqa: BLE001 — một bước hỏng không làm hỏng các bước còn lại
                self.error(f'{step.__name__}: {type(error).__name__}')
        refusals = None
        try:
            refusals = self.scan_refusals()
        except Exception as error:  # noqa: BLE001
            self.error(f'scan_refusals: {type(error).__name__}')
        return {'profile': self.name, 'real': self.real, 'counts': self.counts, 'findings': self.findings,
                'proposals': self.proposals, 'autoApplied': self.auto_applied, 'refusals': refusals, 'errors': self.errors}


def snippet(content: str, hits: list[str]) -> str:
    """Đoạn quanh câu bó tay đầu tiên (giữ chữ gốc có dấu). Che CẢ tin trước rồi mới cắt đoạn: bí mật nằm vắt qua mép đoạn
    không lọt ra dưới dạng mẩu không còn nhận ra được."""
    text = clean_text(content, 10 ** 9)
    folded = fold(text)
    start = 0
    for code, rx in REFUSAL_PATTERNS:
        if code in hits:
            match = rx.search(folded)
            if match:
                start = match.start()
                break
    # fold() giữ nguyên số ký tự với chữ Việt dựng sẵn (NFC) nên chỉ số dùng được cho chuỗi gốc.
    if len(folded) != len(text):
        start = 0
    left = max(0, start - 80)
    return ('…' if left else '') + clean_text(text[left:left + MAX_SNIPPET], MAX_SNIPPET, hide=False)


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect('file:' + db_path.resolve().as_posix() + '?mode=ro', uri=True, timeout=10)
    conn.execute('PRAGMA query_only=ON')
    # UTF-8 hỏng trong tin nhắn ⇒ U+FFFD thay vì lỗi làm hỏng cả lần đọc.
    conn.text_factory = lambda data: data.decode('utf-8', 'replace')
    return conn


def regular_inside(path: Path, root: Path) -> bool:
    try:
        info = _lstat(path)
        return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and _inside(root, os.path.realpath(path))
    except (OSError, ValueError):
        return False


MAX_DB_BYTES = 2 * 1024 * 1024 * 1024


def _copy_inside(path: Path, root: Path, target: Path) -> bool:
    """Chép file qua fd đã kiểm bằng `open_inside` (không đi theo symlink, không ra ngoài gốc kể cả khi bị tráo giữa chừng)."""
    fd = open_inside(path, root, MAX_DB_BYTES)
    if fd is None:
        return False
    with os.fdopen(fd, 'rb') as source, open(target, 'wb') as sink:
        shutil.copyfileobj(source, sink, 1024 * 1024)
    return True


def read_refusal_rows(db_path: Path, since: float, until: float, sources: list[str], root: Optional[Path] = None):
    """Đọc state.db bằng kết nối chỉ đọc. Nếu không mở được tại chỗ (vd. -shm chỉ đọc trong sandbox với bản SQLite cũ) thì
    đọc BẢN SAO (state.db + -wal, chép qua fd đã kiểm) trong thư mục tạm riêng — không ghi gì vào hồ sơ."""
    root = root or canonical_root(db_path.parent)
    try:
        conn = _connect_ro(db_path)
        try:
            rows = _query_refusals(conn, since, until, sources)
        finally:
            conn.close()
        # SQLite mở theo đường: kiểm lại sau khi đọc (file/gốc bị tráo giữa chừng ⇒ bỏ kết quả, đọc qua bản sao).
        if regular_inside(db_path, root):
            return rows
    except sqlite3.OperationalError:
        pass
    with tempfile.TemporaryDirectory(prefix='hermes-learning-audit-') as tmp:
        copy = Path(tmp) / 'state.db'
        if not _copy_inside(db_path, root, copy):
            raise sqlite3.OperationalError('state.db không phải file thường trong hồ sơ')
        wal = db_path.with_name(db_path.name + '-wal')
        if os.path.lexists(wal):
            _copy_inside(wal, root, Path(tmp) / 'state.db-wal')
        conn = _connect_ro(copy)
        try:
            return _query_refusals(conn, since, until, sources)
        finally:
            conn.close()


def _query_refusals(conn: sqlite3.Connection, since: float, until: float, sources: list[str]):
    cols = {row[1] for row in conn.execute('PRAGMA table_info(messages)')}
    active = ' AND COALESCE(m.active,1)=1' if 'active' in cols else ''
    placeholders = ','.join('?' for _ in sources) or "''"
    rows = conn.execute(
        'SELECT m.session_id, s.source, m.timestamp, m.content FROM messages m JOIN sessions s ON s.id=m.session_id '
        f"WHERE m.role='assistant' AND m.timestamp>=? AND m.timestamp<=? AND m.content IS NOT NULL AND m.content<>''{active} "
        f'AND s.source IN ({placeholders}) ORDER BY m.timestamp',
        (since, until, *sources)).fetchall()
    out: list[tuple[str, str, float, str]] = []
    users: dict[tuple[str, float], str] = {}
    for session_id, source, ts, content in rows:
        if not isinstance(ts, (int, float)) or not isinstance(content, str):
            continue  # tin lệch khuôn: bỏ
        session = session_id if isinstance(session_id, str) else str(session_id)
        out.append((session, source if isinstance(source, str) else '', float(ts), content))
        found = conn.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='user' AND timestamp<=? AND content IS NOT NULL "
            'ORDER BY timestamp DESC, id DESC LIMIT 1', (session_id, ts)).fetchone()
        if found and isinstance(found[0], str):
            users[(session, float(ts))] = found[0]
    return out, users


# ---------------------------------------------------------------- tổng hợp

def list_profiles(root: Path) -> list[Path]:
    """Hồ sơ dưới gốc đã ghim (không theo symlink). Mục là symlink vẫn được liệt kê để báo cáo nêu (không đọc bên trong)."""
    out = []
    try:
        with os.scandir(root) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return []
    for entry in entries:
        if entry.name.startswith('.'):
            continue
        base = Path(entry.path)
        if entry.is_symlink() or _is_link(base):
            out.append(base)
        elif entry.is_dir(follow_symlinks=False) and any(os.path.lexists(base / name) for name in ('skills', 'memories', 'state.db')):
            out.append(base)
    return out


def summarize(report: dict[str, Any]) -> str:
    gen = parse_ts(report['generatedAt']) or datetime.now(timezone.utc)
    lines = [f'Kiểm học tập Hermes — {gen.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M")} giờ VN '
             f'(cửa sổ "bó tay" {report["window"]["hours"]} giờ)']
    if report.get('profilesRootError'):
        lines.append(f'• LỖI: thư mục hồ sơ không kiểm được ({report["profilesRootError"]}) — không kiểm hồ sơ nào')
    cat = report['catalog']
    lines.append('• Danh mục tên CRM: ' + (f'đủ ({len(cat["tools"])} tool, {len(cat["actions"])} thao tác)' if cat['status'] == 'ok'
                                         else f'KHÔNG KIỂM ĐƯỢC TÊN — {cat["reason"]}'))
    off = report['official']
    lines.append('• Bộ skill chuẩn: ' + (f'{len(off["skills"])} skill' if off['status'] == 'ok'
                                        else 'chưa có trên host — không kiểm được trùng tên'))
    for prof in report['profiles']:
        tag = 'người dùng thật' if prof['real'] else 'nghiệm thu/thử'
        lines.append(f'• Hồ sơ {prof["profile"]} ({tag}):')
        kinds: dict[str, list[dict[str, Any]]] = {}
        for f in prof['findings']:
            kinds.setdefault(f['kind'], []).append(f)
        dead = kinds.get('dead_tool_name', []) + kinds.get('dead_action_id', [])
        if cat['status'] == 'ok':
            names = sorted({n for f in dead for n in f.get('names', [])})
            lines.append(f'  - Tên tool/thao tác chết: {len(names)}' + (f' ({", ".join(names[:8])})' if names else ''))
        if off['status'] == 'ok':
            shadows = kinds.get('shadows_official_skill', [])
            lines.append(f'  - Skill local đè skill chuẩn: {len(shadows)}'
                         + (f' ({", ".join(sorted({s["skill"] for s in shadows}))})' if shadows else ''))
        unsafe = kinds.get('unsafe_profile_file', [])
        if unsafe:
            lines.append(f'  - CẢNH BÁO: {len(unsafe)} file không đọc an toàn (bị bỏ qua, cần xem tay): '
                         + ', '.join(sorted({str(f.get("file")) for f in unsafe})[:6]))
        for kind, label in (('ledger_path_rejected', 'mục sổ curator có đường file lạ'),
                            ('skill_changed_without_ledger', 'skill đổi không qua sổ curator'),
                            ('ledger_entry_error', 'mục sổ curator không xử lý được'),
                            ('memory_entry_error', 'mục bộ nhớ không kiểm được'),
                            ('skill_scan_error', 'skill không kiểm được'),
                            ('proposal_dropped', 'đề xuất lệch khuôn bị giữ lại')):
            if kinds.get(kind):
                lines.append(f'  - Cảnh báo: {len(kinds[kind])} {label}')
        lines.append(f'  - Đề xuất mới về ghi CRM (chờ duyệt): {len(prof["proposals"])}')
        for idx, p in enumerate(prof['proposals'][:10], 1):
            lines.append(f'      {idx}. {p["title"]}')
        lines.append(f'  - Tự áp dụng (sở thích/ngoài CRM, chỉ đếm): {len(prof["autoApplied"])}')
        ref = prof.get('refusals')
        if ref is not None:
            if ref['status'] == 'ok':
                pats = ', '.join(f'{k} {v}' for k, v in ref['byPattern'].items())
                lines.append(f'  - "Bó tay" {report["window"]["hours"]} giờ: {ref["count"]} lần'
                             + (f' / {ref["sessions"]} phiên ({pats})' if ref['count'] else ''))
                for item in ref['items'][:5]:
                    lines.append(f'      {item["atVn"]} [{item["sessionId"][-8:]}] «{clip(item["assistant"], 110)}»'
                                 + (f' ← hỏi: «{clip(item["previousUser"], 70)}»' if item['previousUser'] else ''))
            elif ref['status'] == 'missing':
                lines.append('  - "Bó tay": hồ sơ chưa có state.db')
            else:
                lines.append('  - "Bó tay": KHÔNG ĐỌC ĐƯỢC state.db')
        for err in prof['errors']:
            lines.append(f'  - LỖI: {err}')
    return '\n'.join(lines)


def build_config(args: argparse.Namespace) -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    if args.config:
        data = json.loads(Path(args.config).read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            raise ValueError('config phải là object JSON')
        unknown = set(data) - set(DEFAULTS)
        if unknown:
            raise ValueError('khoá config lạ: ' + ', '.join(sorted(unknown)))
        cfg.update(data)
    for key in ('profilesRoot', 'officialSkillsDir', 'catalogModule', 'node', 'stateFile', 'outDir'):
        value = getattr(args, key, None)
        if value:
            cfg[key] = value
    if args.real_profiles:
        cfg['realProfiles'] = [p for p in args.real_profiles.split(',') if p]
    if args.window_hours:
        cfg['windowHours'] = args.window_hours
    for key, kind in CONFIG_TYPES.items():
        value = cfg[key]
        if isinstance(value, bool) or not isinstance(value, kind) \
                or (isinstance(value, list) and not all(isinstance(item, str) for item in value)):
            raise ValueError(f'khoá config sai kiểu: {key}')
    return cfg


def error_profile(name: str, cfg: dict[str, Any], why: str) -> dict[str, Any]:
    return {'profile': one_line(name, 80, hide=False), 'real': name in cfg['realProfiles'], 'counts': {},
            'findings': [{'kind': 'unsafe_profile_file', 'severity': 'high', 'file': '.',
                          'detail': f'thư mục hồ sơ không kiểm được an toàn ({why})'}],
            'proposals': [], 'autoApplied': [], 'refusals': None, 'errors': ['thư mục hồ sơ không kiểm được an toàn']}


def run_audit(cfg: dict[str, Any], now: datetime,
              use_state: bool = True) -> tuple[dict[str, Any], dict[str, Any], Optional[dict[str, Any]]]:
    """⇒ (báo cáo đủ — private, outbox chỉ đề xuất — cho job nạp, trạng thái mới hoặc None khi không được ghi đè trạng thái)."""
    state_path = Path(cfg['stateFile']) if use_state else None
    state = load_state(state_path)
    catalog = load_catalog(cfg)
    official = load_official(cfg)
    profiles_out: list[dict[str, Any]] = []
    outbox_profiles: list[dict[str, Any]] = []
    prior_profiles: dict[str, Any] = state.get('profiles', {})
    next_profiles: dict[str, Any] = {}
    root_error: Optional[str] = None
    try:
        # Gốc hồ sơ ghim một lần: từ đây mọi hồ sơ phải nằm trong gốc đã phân giải này.
        profiles_root = canonical_root(Path(cfg['profilesRoot']))
        if not _is_dir_no_follow(profiles_root):
            raise OSError('không phải thư mục')
        roots = list_profiles(profiles_root)
    except OSError as error:
        root_error, roots, profiles_root = type(error).__name__, [], Path(cfg['profilesRoot'])
    for root in roots:
        name = root.name
        prior = dict(prior_profiles.get(name) or {})
        if prior:
            prior['lastRunAt'] = state.get('lastRunAt')
        try:
            audit = ProfileAudit(name, root, profiles_root, cfg, catalog, official, prior, now)
            result = audit.run()
        except Exception as error:  # noqa: BLE001 — thư mục hồ sơ bị tráo/hỏng: báo, giữ trạng thái cũ, lần sau kiểm lại
            profiles_out.append(error_profile(name, cfg, type(error).__name__))
            if prior_profiles.get(name):
                next_profiles[name] = prior_profiles[name]
            continue
        profiles_out.append(result)
        outbox_profiles.append({'profile': name, 'proposals': result['proposals']})
        next_profiles[name] = audit.next_state
    report: dict[str, Any] = {
        'schemaVersion': SCHEMA_VERSION, 'generatedAt': iso(now), 'firstRun': not state,
        'window': {'hours': cfg['windowHours'], 'from': iso(now - timedelta(hours=float(cfg['windowHours']))), 'to': iso(now)},
        'catalog': catalog, 'official': official, 'profiles': profiles_out,
        'totals': {
            'proposals': sum(len(p['proposals']) for p in profiles_out),
            'proposalsReal': sum(len(p['proposals']) for p in profiles_out if p['real']),
            'findingsHigh': sum(1 for p in profiles_out for f in p['findings'] if f['severity'] == 'high'),
            'refusalsReal': sum((p['refusals'] or {}).get('count', 0) for p in profiles_out if p['real']),
        },
    }
    if root_error:
        report['profilesRootError'] = root_error
    if catalog['status'] != 'ok':
        report['notice'] = 'không kiểm được tên tool: ' + catalog['reason']
    report['summaryVi'] = summarize(report)
    outbox = {'schemaVersion': SCHEMA_VERSION, 'kind': 'hermes-learning-outbox', 'generatedAt': iso(now),
              'profiles': outbox_profiles}
    # Gốc hồ sơ hỏng: giữ trạng thái cũ (ghi trạng thái rỗng sẽ làm lần sau coi như lần đầu và sót mục sổ).
    next_state = None if root_error else {'schemaVersion': SCHEMA_VERSION, 'lastRunAt': iso(now), 'profiles': next_profiles}
    return report, outbox, next_state


def write_outputs(cfg: dict[str, Any], report: dict[str, Any], outbox: dict[str, Any], next_state: Optional[dict[str, Any]],
                  now: datetime) -> None:
    """Báo cáo đủ vào private/ (0700, file 0600); outbox chỉ đề xuất (0750/0640, nhóm của job = ihome-hermes). Trạng thái
    ghi SAU CÙNG: lỗi ghi báo cáo/outbox thì trạng thái không tiến, lần sau gửi lại."""
    out = Path(cfg['outDir'])
    private = ensure_dir(out / 'private', 0o700)
    reports = ensure_dir(private / 'reports', 0o700)
    box = ensure_dir(out / 'outbox', 0o750)
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    body = json_bytes(report, indent=1)
    write_atomic(reports / f'learning-audit-{stamp}.json', body, 0o600)
    write_atomic(private / 'latest.json', body, 0o600)
    write_atomic(private / 'latest.txt', (report['summaryVi'] + '\n').encode('utf-8', 'replace'), 0o600)
    write_atomic(box / f'learning-outbox-{stamp}.json', json_bytes(outbox), 0o640)
    if next_state is not None:
        write_atomic(Path(cfg['stateFile']), json_bytes(next_state), 0o600)
    keep = int(cfg['keepReports'])
    for folder, pattern in ((reports, 'learning-audit-*.json'), (box, 'learning-outbox-*.json')):
        old = sorted(folder.glob(pattern))
        for stale in old[:-keep] if keep > 0 else []:
            try:
                stale.unlink()
            except OSError:
                pass


def counts_line(report: dict[str, Any]) -> dict[str, Any]:
    """Một dòng cho journal: chỉ đếm số, không nội dung đề xuất/bộ nhớ/tin nhắn."""
    return {'event': 'learning_audit', 'generatedAt': report['generatedAt'], 'catalog': report['catalog']['status'],
            'official': report['official']['status'], 'profiles': len(report['profiles']), **report['totals'],
            'errors': sum(len(p['errors']) for p in report['profiles']), 'profilesRootError': report.get('profilesRootError')}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description='Kiểm học tập Hermes (chỉ đọc hồ sơ).')
    parser.add_argument('--config', help='file JSON ghi đè cấu hình mặc định')
    parser.add_argument('--profiles-root', dest='profilesRoot')
    parser.add_argument('--official-skills', dest='officialSkillsDir')
    parser.add_argument('--catalog-module', dest='catalogModule')
    parser.add_argument('--node', dest='node')
    parser.add_argument('--state', dest='stateFile')
    parser.add_argument('--out-dir', dest='outDir')
    parser.add_argument('--real-profiles', help='danh sách hồ sơ người dùng thật, ngăn bằng dấu phẩy')
    parser.add_argument('--window-hours', type=float)
    parser.add_argument('--now', help='mốc giờ ISO (thử nghiệm)')
    parser.add_argument('--no-state', action='store_true', help='không đọc/ghi trạng thái (coi như lần đầu)')
    parser.add_argument('--stdout', action='store_true', help='in báo cáo JSON đủ ra stdout (thử tay), không ghi file')
    args = parser.parse_args(argv)
    try:
        cfg = build_config(args)
    except (OSError, ValueError) as error:
        print(json.dumps({'event': 'learning_audit_failed', 'code': 'config_invalid', 'detail': one_line(str(error), 200)},
                         ensure_ascii=True), file=sys.stderr)
        return 2
    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        print(json.dumps({'event': 'learning_audit_failed', 'code': 'now_invalid'}), file=sys.stderr)
        return 2
    try:
        report, outbox, next_state = run_audit(cfg, now, use_state=not args.no_state and not args.stdout)
        if args.stdout:
            sys.stdout.write(json_bytes(report, indent=1).decode('ascii'))
            return 0
        write_outputs(cfg, report, outbox, None if args.no_state else next_state, now)
    except Exception as error:  # noqa: BLE001 — lỗi hệ thống: mã ≠ 0 để systemd báo (OnFailure), không in nội dung
        print(json.dumps({'event': 'learning_audit_failed', 'code': type(error).__name__}, ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps(counts_line(report), ensure_ascii=True))
    return 1 if report.get('profilesRootError') else 0


if __name__ == '__main__':
    sys.exit(main())
