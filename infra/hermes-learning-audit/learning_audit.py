#!/usr/bin/env python3
"""Kiểm học tập Hermes trên host VPS — CHỈ ĐỌC hồ sơ.

Quét mọi hồ sơ Hermes (skill local, bộ nhớ MEMORY.md/USER.md, sổ curator, state.db) rồi xuất báo cáo JSON +
tóm tắt tiếng Việt:

  a. tên tool CRM chết (không thuộc danh mục connector — lấy bằng cách `node` import catalog-names.mjs; thiếu
     module thì báo "không kiểm được tên", không đoán), skill local trùng tên skill chuẩn (đè bản chuẩn), và
     bài học về GHI dữ liệu CRM ⇒ ĐỀ XUẤT chờ duyệt (sở thích/cách nói chuyện/việc ngoài CRM thì tự áp dụng);
  b. số lần "bó tay" 24 giờ qua trên hồ sơ người dùng thật (kèm phiên, giờ, câu người dùng ngay trước, cắt ngắn).

Không ghi gì vào thư mục hồ sơ: SQLite mở `mode=ro`, file chỉ đọc. Trạng thái giữa các lần chạy (đã thấy mục sổ
nào, bộ nhớ nào) nằm ở file riêng của job (`stateFile`). Chỉ dùng thư viện chuẩn Python 3.10+.
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
from typing import Any, Iterable, Optional

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
    'stateFile': '/var/lib/ihome-hermes-learning-audit/state.json',
    'outDir': '/var/lib/ihome-hermes-learning-audit',
    'windowHours': 24,
    'firstRunLookbackHours': 72,
    'keepReports': 30,
}

MAX_TITLE = 200
MAX_CONTENT = 3500
MAX_SNIPPET = 220
MAX_USER_SNIPPET = 160
MAX_REFUSAL_ITEMS = 50
MAX_SEEN_LEDGER = 2000
SKIP_SKILL_DIRS = {'.archive', '.hub', '.curator_backups', '.locks', 'node_modules', '__pycache__', '.git'}

# Tên tool CRM xuất hiện dạng trần `crm_task_create` hoặc dạng MCP `mcp__ihomecrm__crm_task_create`.
TOOL_RE = re.compile(r'(?<![A-Za-z0-9_])(?:mcp__[a-z0-9-]+__)?(crm_[a-z0-9]+(?:_[a-z0-9]+)*)(?![A-Za-z0-9_])')
# Mã thao tác của khung crm_action_* (trang.thao_tác), vd. `task.create`, `invoice.collect`.
ACTION_PAGES = ('expense', 'invoice', 'contract', 'task', 'probe', 'learning')
ACTION_RE = re.compile(r'(?<![A-Za-z0-9_.])((?:' + '|'.join(ACTION_PAGES) + r')\.[a-z][a-z0-9_]*)(?![A-Za-z0-9_])')

# Dấu hiệu bài học về GHI dữ liệu CRM (so trên chữ đã bỏ dấu, chữ thường).
# Động từ ghi phải là trọn một khúc của tên tool (crm_task_create, crm_room_pass_upsert), không phải chuỗi con.
WRITE_TOOL_RE = re.compile(r'\bcrm_(?:[a-z0-9]+_)*(?:create|update|upsert|send|cancel|delete|approve|collect|record|lock|'
                           r'assign|close|reopen|write|edit|set|run|schedule|forget|configure|restore|adjust|confirm|note)'
                           r'(?:_[a-z0-9]+)*\b')
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


def fold(text: str) -> str:
    """Chữ thường, bỏ dấu tiếng Việt (đ→d) để so mẫu ổn định."""
    text = unicodedata.normalize('NFD', text.lower()).replace('đ', 'd')
    return ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def clip(text: str, limit: int) -> str:
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', ' ', text).strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + '…'


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_ts(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def vn(dt: datetime) -> str:
    return dt.astimezone(VN_TZ).strftime('%d/%m %H:%M')


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


def _inside(root: Path, real: str) -> bool:
    try:
        return os.path.commonpath([os.path.normcase(str(root)), os.path.normcase(real)]) == os.path.normcase(str(root))
    except ValueError:
        return False


def open_inside(path: Path, root: Path, limit: int) -> Optional[int]:
    """Mở chỉ đọc một FILE THƯỜNG nằm TRONG `root` (gốc đã ghim). Job chạy với CAP_DAC_READ_SEARCH (đọc được mọi file
    trên host) trong khi hồ sơ do Hermes ghi được ⇒ từ chối symlink (O_NOFOLLOW), file đặc biệt, file quá lớn, đường ra
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
        # Như đọc chế độ văn bản: CRLF ⇒ LF (mục bộ nhớ ngăn bằng "\n§\n").
        return None if len(data) > limit else data.decode('utf-8', errors='replace').replace('\r\n', '\n')
    except (OSError, ValueError):
        return None


def safe_path(root: Path, relative: str) -> Optional[Path]:
    """Ghép đường tương đối lấy từ dữ liệu hồ sơ (vd. sổ curator): không tuyệt đối, không `..`, không `\\`."""
    parts = relative.split('/')
    if not relative or relative.startswith('/') or '\\' in relative or '\0' in relative or any(p in ('', '.', '..') for p in parts):
        return None
    return root.joinpath(*parts)


# ---------------------------------------------------------------- danh mục tên hợp lệ (connector)

CATALOG_JS = r'''
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
if (typeof mod.catalogToolNames !== 'function' || typeof mod.catalogActionIds !== 'function') {
  throw new Error('catalog-names.mjs thiếu catalogToolNames()/catalogActionIds()');
}
const tools = await mod.catalogToolNames();
const actions = await mod.catalogActionIds();
process.stdout.write(JSON.stringify({ tools: [...tools], actions: [...actions] }));
'''


def load_catalog(cfg: dict[str, Any]) -> dict[str, Any]:
    module = Path(cfg['catalogModule'])
    base = {'module': str(module), 'tools': [], 'actions': []}
    if not module.is_file():
        return {**base, 'status': 'unavailable', 'reason': 'thiếu module catalog-names.mjs trên host'}
    node = cfg['node'] if Path(cfg['node']).is_file() else 'node'
    try:
        done = subprocess.run([node, '--input-type=module', '-e', CATALOG_JS, str(module)], capture_output=True,
                              text=True, timeout=float(cfg['catalogTimeoutSeconds']), cwd=str(module.parent))
    except (OSError, subprocess.TimeoutExpired) as error:
        return {**base, 'status': 'unavailable', 'reason': f'không chạy được node ({type(error).__name__})'}
    if done.returncode != 0:
        last = (done.stderr or '').strip().splitlines()[-1:] or ['']
        return {**base, 'status': 'unavailable', 'reason': f'node thoát mã {done.returncode}: {clip(last[0], 200)}'}
    try:
        data = json.loads(done.stdout)
        tools = sorted({strip_mcp(str(name)) for name in data['tools'] if isinstance(name, str) and name})
        actions = sorted({str(name) for name in data['actions'] if isinstance(name, str) and name})
    except (ValueError, KeyError, TypeError):
        return {**base, 'status': 'unavailable', 'reason': 'đầu ra catalog-names.mjs lệch khuôn'}
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
    if not root.is_dir():
        return
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_SKILL_DIRS and not d.startswith('.'))
        for name in sorted(files):
            if name == 'SKILL.md':
                yield Path(current) / name


def skill_package_texts(skill_md: Path, read) -> list[tuple[Path, str]]:
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
    if not configured.is_dir():
        return {'status': 'missing', 'dir': str(configured), 'skills': []}
    root = Path(os.path.realpath(configured))  # `current` là symlink tới bản phát hành: chỉ đọc file bên trong bản đó
    names: set[str] = set()
    for skill_md in iter_skill_files(root):
        text = safe_read(skill_md, root)
        if text is not None:
            names |= skill_names(skill_md, text)
    return {'status': 'ok', 'dir': str(configured), 'skills': sorted(names)}


# ---------------------------------------------------------------- phân loại

def crm_write_reasons(text: str) -> list[str]:
    """Lý do coi đoạn văn là bài học về GHI dữ liệu CRM (rỗng = không phải)."""
    folded = fold(text)
    reasons: list[str] = []
    if 'crm_action_run' in folded or 'confirmtoken' in folded:
        reasons.append('nhắc crm_action_run / confirmToken')
    actions = sorted(set(ACTION_RE.findall(folded)))
    if actions:
        reasons.append('mã thao tác ' + ', '.join(actions[:5]))
    tools = sorted({m.group(0) for m in WRITE_TOOL_RE.finditer(folded)})
    if tools:
        reasons.append('tool ghi ' + ', '.join(tools[:5]))
    if not reasons and CRM_CONTEXT_RE.search(folded) and WRITE_VERB_RE.search(folded):
        reasons.append('ý định ghi trong ngữ cảnh CRM')
    return reasons


def dead_names(text: str, catalog: dict[str, Any]) -> tuple[list[str], list[str]]:
    if catalog['status'] != 'ok':
        return [], []
    tools = set(catalog['tools'])
    actions = set(catalog['actions'])
    dead_tools = sorted({m.group(1) for m in TOOL_RE.finditer(text)} - tools)
    dead_actions = sorted(set(ACTION_RE.findall(text)) - actions) if actions else []
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
    out: list[str] = []
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag in ('insert', 'replace'):
            out.extend(new[j1:j2])
    return out


# ---------------------------------------------------------------- trạng thái job (ngoài hồ sơ)

def load_state(path: Optional[Path]) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get('schemaVersion') == SCHEMA_VERSION else {}


def write_atomic(path: Path, text: str, mode: int = 0o640) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.name}.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- một hồ sơ

class ProfileAudit:
    def __init__(self, name: str, root: Path, cfg: dict[str, Any], catalog: dict[str, Any], official: dict[str, Any],
                 prior: dict[str, Any], now: datetime):
        # Gốc hồ sơ ghim một lần (không phải symlink); mọi file chỉ được đọc khi nằm trong gốc này.
        self.name, self.root, self.cfg, self.catalog, self.official, self.prior, self.now = (
            name, canonical_root(root), cfg, catalog, official, prior, now)
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
        self.findings.append({'kind': kind, 'severity': severity, 'detail': detail, **extra})

    def read(self, path: Path, limit: int = MAX_READ_BYTES) -> Optional[str]:
        """Đọc an toàn trong hồ sơ. File CÓ mà bị từ chối (symlink, file đặc biệt, quá lớn, ra ngoài hồ sơ) ⇒ phát hiện mức
        cao: không để Hermes né kiểm bằng cách biến bộ nhớ/skill thành symlink."""
        text = safe_read(path, self.root, limit)
        if text is None and os.path.lexists(path):
            rel = self.rel(path)
            if rel not in self._refused:
                self._refused.add(rel)
                self.finding('unsafe_profile_file', 'high',
                             f'{rel}: không đọc an toàn được (symlink/file đặc biệt/quá lớn/ra ngoài hồ sơ) — đã bỏ qua, cần xem tay',
                             file=rel)
        return text

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
        one_line = clip(' '.join(title.split()), MAX_TITLE) or clip(normalized, MAX_TITLE)
        self.proposals.append({'dedupeKey': key, 'kind': kind, 'title': one_line, 'content': content,
                               'source': {'profile': self.name, **source}, 'detectedAt': iso(detected_at)})

    def rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return path.as_posix()

    # -- a. skill local + bộ nhớ
    def scan_skills(self) -> None:
        skills_root = self.root / 'skills'
        hashes: dict[str, str] = {}
        local = 0
        official_names = set(self.official['skills'])
        prior_hashes = self.prior.get('skillHashes', {}) if self.prior else {}
        for skill_md in iter_skill_files(skills_root):
            texts = skill_package_texts(skill_md, self.read)
            main = next((t for p, t in texts if p == skill_md), '')
            names = skill_names(skill_md, main)
            local += 1
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
        self.counts['localSkills'] = local
        if prior_hashes:
            changed = sorted(k for k, v in hashes.items() if prior_hashes.get(k) != v)
            self.counts['skillFilesChanged'] = len(changed)
            self._changed_files = set(changed)
        self.next_state['skillHashes'] = hashes

    def scan_memory(self) -> None:
        seen_before = set(self.prior.get('memoryHashes', [])) if self.prior else set()
        first_run = not self.prior
        current: list[str] = []
        entries = 0
        for file_name in ('MEMORY.md', 'USER.md'):
            path = self.root / 'memories' / file_name
            text = self.read(path)
            if text is None:
                continue
            for entry in (e.strip() for e in text.split('\n§\n')):
                if not entry:
                    continue
                entries += 1
                digest = sha256_hex(entry)
                current.append(digest)
                dead_tools, dead_actions = dead_names(entry, self.catalog)
                if dead_tools or dead_actions:
                    self.finding('dead_tool_name' if dead_tools else 'dead_action_id', 'high',
                                 f'memories/{file_name}: mục bộ nhớ nhắc tên không còn trong danh mục',
                                 file=f'memories/{file_name}', names=dead_tools + dead_actions)
                if digest in seen_before:
                    continue
                reasons = crm_write_reasons(entry)
                source = {'type': 'memory', 'file': f'memories/{file_name}', 'entrySha256': digest,
                          'firstRun': first_run}
                if reasons:
                    self.proposal('memory_crm_write', f'Bộ nhớ {file_name}: {clip(entry, 120)}', entry,
                                  {**source, 'reasons': reasons}, self.now, f'memory:{file_name}:{digest}')
                else:
                    self.auto_applied.append({'kind': 'memory_preference', 'title': clip(entry, 120), 'source': source})
        self.counts['memoryEntries'] = entries
        self.next_state['memoryHashes'] = sorted(set(current))

    def scan_ledger(self) -> None:
        path = self.root / 'skills' / '.curator_ledger.jsonl'
        text = self.read(path, limit=32 * 1024 * 1024)
        prior_seen = list(self.prior.get('ledgerSeen', [])) if self.prior else []
        seen = set(prior_seen)
        if self.prior:
            last_run = parse_ts(self.prior.get('lastRunAt')) or (self.now - timedelta(hours=self.cfg['firstRunLookbackHours']))
            floor = last_run - timedelta(days=7)
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
            except ValueError:
                bad += 1
                continue
            if not isinstance(entry, dict):
                bad += 1
                continue
            entry_id = str(entry.get('id') or sha256_hex(line)[:12])
            ts = parse_ts(entry.get('ts'))
            if entry_id in seen:
                continue
            seen.add(entry_id)
            order.append(entry_id)
            if ts is None or ts < floor:
                continue
            fresh += 1
            self._ledger_entry(entry, entry_id, ts, covered)
        if bad:
            self.errors.append(f'{bad} dòng sổ curator không đọc được')
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
        return self.read(self.root / '.curator_backups' / 'blobs' / digest)

    def _ledger_entry(self, entry: dict[str, Any], entry_id: str, ts: datetime, covered: set[str]) -> None:
        actor = str(entry.get('actor') or '')
        action = str(entry.get('action') or '')
        skill = str(entry.get('skill') or '')
        evidence = entry.get('evidence') if isinstance(entry.get('evidence'), dict) else {}
        session_id = evidence.get('session_id') if isinstance(evidence.get('session_id'), str) else None
        source = {'type': 'curator_ledger', 'ledgerId': entry_id, 'actor': actor, 'action': action, 'skill': skill,
                  'sessionId': session_id, 'at': iso(ts)}
        if actor == 'user':
            return  # người dùng tự sửa skill: không phải "học".
        if action not in ('create', 'patch'):
            self.auto_applied.append({'kind': 'skill_lifecycle', 'title': f'{skill}: {action} bởi {actor}', 'source': source})
            return

        skills_root = self.root / 'skills'

        rejected: list[str] = []

        def by_file(items: Any) -> dict[str, Any]:
            out: dict[str, Any] = {}
            for item in items if isinstance(items, list) else []:
                if not (isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'].endswith('.md')):
                    continue
                # Đường lấy từ sổ (Hermes ghi được): phải nằm dưới skills/, không `..`, không tuyệt đối — mục lạ bị bỏ
                # thay vì đọc ngoài hồ sơ, và được báo (không mất im lặng).
                rel = item['path'].split('/skills/', 1)[1] if '/skills/' in item['path'] else ''
                if rel and safe_path(skills_root, rel) is not None:
                    out[rel] = item.get('sha256')
                else:
                    rejected.append(clip(item['path'], 160))
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
            self.auto_applied.append({'kind': 'skill_preference', 'title': f'Skill {skill}: {actor} {verb} lúc {vn(ts)}',
                                      'source': source})

    # -- b. "bó tay"
    def scan_refusals(self) -> Optional[dict[str, Any]]:
        if not self.real:
            return None
        db_path = self.root / 'state.db'
        if not os.path.lexists(db_path):
            return {'status': 'missing', 'count': 0, 'byPattern': {}, 'items': []}
        if not regular_inside(db_path, self.root):
            self.errors.append('state.db không phải file thường trong hồ sơ (symlink/đường lạ) — bỏ qua')
            return {'status': 'error', 'count': 0, 'byPattern': {}, 'items': []}
        since = self.now - timedelta(hours=float(self.cfg['windowHours']))
        try:
            rows, users = read_refusal_rows(db_path, since.timestamp(), self.now.timestamp(), self.cfg['realSources'], self.root)
        except (sqlite3.Error, OSError) as error:
            self.errors.append(f'state.db không đọc được: {type(error).__name__}')
            return {'status': 'error', 'count': 0, 'byPattern': {}, 'items': []}
        by_pattern: dict[str, int] = {}
        items: list[dict[str, Any]] = []
        sessions: set[str] = set()
        for session_id, source, ts, content in rows:
            folded = fold(content)
            hits = [code for code, rx in REFUSAL_PATTERNS if rx.search(folded)]
            if not hits:
                continue
            for code in hits:
                by_pattern[code] = by_pattern.get(code, 0) + 1
            sessions.add(session_id)
            previous = users.get((session_id, ts))
            when = datetime.fromtimestamp(ts, tz=timezone.utc)
            items.append({'sessionId': session_id, 'source': source, 'at': iso(when), 'atVn': vn(when),
                          'patterns': hits, 'assistant': snippet(content, hits), 'previousUser': clip(previous or '', MAX_USER_SNIPPET) or None})
        items.sort(key=lambda item: item['at'], reverse=True)
        return {'status': 'ok', 'windowFrom': iso(since), 'count': len(items), 'sessions': len(sessions),
                'byPattern': dict(sorted(by_pattern.items())), 'items': items[:MAX_REFUSAL_ITEMS]}

    def run(self) -> dict[str, Any]:
        for step in (self.scan_skills, self.scan_memory, self.scan_ledger):
            try:
                step()
            except OSError as error:
                self.errors.append(f'{step.__name__}: {type(error).__name__}')
        refusals = None
        try:
            refusals = self.scan_refusals()
        except OSError as error:
            self.errors.append(f'scan_refusals: {type(error).__name__}')
        return {'profile': self.name, 'real': self.real, 'counts': self.counts, 'findings': self.findings,
                'proposals': self.proposals, 'autoApplied': self.auto_applied, 'refusals': refusals, 'errors': self.errors}


def snippet(content: str, hits: list[str]) -> str:
    """Đoạn quanh câu bó tay đầu tiên (giữ chữ gốc có dấu)."""
    folded = fold(content)
    start = 0
    for code, rx in REFUSAL_PATTERNS:
        if code in hits:
            match = rx.search(folded)
            if match:
                start = match.start()
                break
    # fold() giữ nguyên số ký tự với chữ Việt dựng sẵn (NFC) nên chỉ số dùng được cho chuỗi gốc.
    if len(folded) != len(content):
        start = 0
    left = max(0, start - 80)
    piece = content[left:left + MAX_SNIPPET]
    return ('…' if left else '') + clip(piece, MAX_SNIPPET)


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect('file:' + db_path.resolve().as_posix() + '?mode=ro', uri=True, timeout=10)
    conn.execute('PRAGMA query_only=ON')
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
    """Đọc state.db bằng kết nối chỉ đọc. Nếu không mở được tại chỗ (vd. systemd ReadOnlyPaths làm -shm không ghi được ở
    bản SQLite cũ) thì đọc BẢN SAO (state.db + -wal, chép qua fd đã kiểm) trong thư mục tạm riêng — không ghi gì vào hồ sơ."""
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
    users: dict[tuple[str, float], str] = {}
    for session_id, _source, ts, _content in rows:
        found = conn.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='user' AND timestamp<=? AND content IS NOT NULL "
            'ORDER BY timestamp DESC, id DESC LIMIT 1', (session_id, ts)).fetchone()
        if found and isinstance(found[0], str):
            users[(session_id, ts)] = found[0]
    return [(str(a), str(b), float(c), str(d)) for a, b, c, d in rows], users


# ---------------------------------------------------------------- tổng hợp

def list_profiles(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    out = []
    for entry in sorted(root.iterdir()):
        if entry.is_dir() and not entry.name.startswith('.') and not entry.is_symlink() and (
                (entry / 'skills').is_dir() or (entry / 'memories').is_dir() or (entry / 'state.db').is_file()):
            out.append(entry)
    return out


def summarize(report: dict[str, Any]) -> str:
    gen = parse_ts(report['generatedAt']) or datetime.now(timezone.utc)
    lines = [f'Kiểm học tập Hermes — {gen.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M")} giờ VN '
             f'(cửa sổ "bó tay" {report["window"]["hours"]} giờ)']
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
                            ('skill_changed_without_ledger', 'skill đổi không qua sổ curator')):
            if kinds.get(kind):
                lines.append(f'  - Cảnh báo: {len(kinds[kind])} {label}')
        lines.append(f'  - Đề xuất mới về ghi CRM (chờ duyệt): {len(prof["proposals"])}')
        for idx, p in enumerate(prof['proposals'][:10], 1):
            lines.append(f'      {idx}. {p["title"]}')
        lines.append(f'  - Tự áp dụng (sở thích/ngoài CRM): {len(prof["autoApplied"])}')
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
    return cfg


def run_audit(cfg: dict[str, Any], now: datetime, use_state: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    state_path = Path(cfg['stateFile']) if use_state else None
    state = load_state(state_path)
    catalog = load_catalog(cfg)
    official = load_official(cfg)
    profiles_out = []
    next_profiles: dict[str, Any] = {}
    for root in list_profiles(Path(cfg['profilesRoot'])):
        prior = dict(state.get('profiles', {}).get(root.name, {}))
        if prior:
            prior['lastRunAt'] = state.get('lastRunAt')
        try:
            audit = ProfileAudit(root.name, root, cfg, catalog, official, prior, now)
        except OSError as error:  # thư mục hồ sơ bị tráo thành symlink giữa lúc liệt kê và lúc kiểm
            profiles_out.append({'profile': root.name, 'real': root.name in cfg['realProfiles'], 'counts': {},
                                 'findings': [{'kind': 'unsafe_profile_file', 'severity': 'high', 'file': '.',
                                               'detail': f'thư mục hồ sơ không kiểm được an toàn ({type(error).__name__})'}],
                                 'proposals': [], 'autoApplied': [], 'refusals': None,
                                 'errors': ['thư mục hồ sơ không kiểm được an toàn']})
            if state.get('profiles', {}).get(root.name):
                next_profiles[root.name] = state['profiles'][root.name]  # giữ trạng thái cũ, lần sau kiểm lại
            continue
        profiles_out.append(audit.run())
        next_profiles[root.name] = audit.next_state
    report = {
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
    if catalog['status'] != 'ok':
        report['notice'] = 'không kiểm được tên tool: ' + catalog['reason']
    report['summaryVi'] = summarize(report)
    next_state = {'schemaVersion': SCHEMA_VERSION, 'lastRunAt': iso(now), 'profiles': next_profiles}
    return report, next_state


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
    parser.add_argument('--stdout', action='store_true', help='in báo cáo JSON ra stdout, không ghi file')
    args = parser.parse_args(argv)
    try:
        cfg = build_config(args)
    except (OSError, ValueError) as error:
        print(f'learning-audit: cấu hình lỗi: {error}', file=sys.stderr)
        return 2
    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        print('learning-audit: --now không đúng ISO-8601', file=sys.stderr)
        return 2
    report, next_state = run_audit(cfg, now, use_state=not args.no_state and not args.stdout)
    if args.stdout:
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
        return 0
    out = Path(cfg['outDir'])
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    body = json.dumps(report, ensure_ascii=False, indent=1) + '\n'
    write_atomic(out / 'reports' / f'learning-audit-{stamp}.json', body)
    write_atomic(out / 'latest.json', body)
    write_atomic(out / 'latest.txt', report['summaryVi'] + '\n')
    if not args.no_state:
        write_atomic(Path(cfg['stateFile']), json.dumps(next_state, ensure_ascii=False) + '\n', 0o600)
    keep = int(cfg['keepReports'])
    old = sorted((out / 'reports').glob('learning-audit-*.json'))
    for stale in old[:-keep] if keep > 0 else []:
        try:
            stale.unlink()
        except OSError:
            pass
    print(report['summaryVi'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
