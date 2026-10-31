"""Kiểm learning_audit.py bằng dữ liệu giả trong thư mục tạm (không đụng hồ sơ thật, không mạng)."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import tokenize
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import learning_audit as la  # noqa: E402

NOW = datetime(2026, 10, 31, 13, 40, tzinfo=timezone.utc)
NODE = shutil.which('node')
BS = chr(92)  # dấu \ dựng lúc chạy: dòng sổ curator thuần ASCII chứa chuỗi thoát \udc00, \u0000

CATALOG = """export function catalogToolNames() {
  return ['crm_action_run', 'crm_action_list', 'crm_action_status', 'crm_read_report', 'crm_new_request_id',
    'mcp__ihomecrm__crm_read_receivables'];
}
export async function catalogActionIds() { return ['task.create', 'expense.create']; }
"""

OLD_TASK_SKILL = """---
name: crm-task-management
description: Use when managing CRM tasks.
---

# CRM task management

1. Read tasks with crm_read_report before answering. Keep replies short.
"""
NEW_TASK_SKILL = OLD_TASK_SKILL.rstrip('\n') + (
    ' Rediscover crm_task_create and crm_task_input_options via tool_search before creating a task.\n')


def blob(profile: Path, text: str) -> str:
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    path = profile / '.curator_backups' / 'blobs' / digest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return digest


def ledger_line(profile: Path, entry_id: str, ts: datetime, action: str, skill: str, rel: str,
                before: str | None, after: str, actor: str = 'curator') -> str:
    container = f'/home/hermes/.hermes/profiles/{profile.name}/skills/{rel}'
    return json.dumps({
        'id': entry_id, 'ts': ts.isoformat(), 'actor': actor, 'action': action, 'skill': skill,
        'evidence': {'session_id': '20261031_081600_abcdef12', 'file_path': 'SKILL.md'},
        'before': [] if before is None else [{'path': container, 'sha256': blob(profile, before)}],
        'after': [{'path': container, 'sha256': blob(profile, after)}],
    })


def make_state_db(path: Path, rows: list[tuple[str, str, str, float, str]]) -> None:
    """rows: (session_id, source, role, timestamp, content). Chế độ journal mặc định (không -wal/-shm)."""
    conn = sqlite3.connect(path)
    conn.executescript("""
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL,
        end_reason TEXT, message_count INTEGER DEFAULT 0);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1);
    """)
    for session_id, source in sorted({(r[0], r[1]) for r in rows}):
        conn.execute('INSERT INTO sessions(id, source, started_at) VALUES (?,?,?)', (session_id, source, NOW.timestamp() - 90000))
    for session_id, _source, role, ts, content in rows:
        conn.execute('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?,?,?,?)', (session_id, role, content, ts))
    conn.commit()
    conn.close()


def snapshot(root: Path) -> dict[str, tuple[int, str]]:
    out = {}
    for current, _dirs, files in os.walk(root):
        for name in files:
            path = Path(current) / name
            out[path.relative_to(root).as_posix()] = (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
    return out


class Fixture:
    def __init__(self, base: Path, with_catalog: bool = True, with_official: bool = True):
        self.base = base
        self.profiles = base / 'profiles'
        self.owner = self.profiles / 'owner'
        self.tkt = self.profiles / 'tkt'
        self.official = base / 'ihome-official-skills' / 'current'
        self.catalog = base / 'release' / 'catalog-names.mjs'
        self.out = base / 'audit'
        self.state = base / 'audit' / 'private' / 'state.json'
        for prof in (self.owner, self.tkt):
            (prof / 'skills' / 'productivity').mkdir(parents=True)
            (prof / 'memories').mkdir(parents=True)
        (self.profiles / '.deleted').mkdir()
        if with_catalog:
            self.catalog.parent.mkdir(parents=True)
            self.catalog.write_text(CATALOG, encoding='utf-8')
        if with_official:
            skill = self.official / 'crm' / 'ihome-crm-tasks'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: ihome-crm-tasks\ndescription: chuẩn\n---\nDùng crm_action_run task.create.\n',
                                            encoding='utf-8')

    def skill(self, prof: Path, rel: str, text: str) -> Path:
        path = prof / 'skills' / rel / 'SKILL.md'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def config(self, **extra) -> dict:
        cfg = dict(la.DEFAULTS)
        cfg.update({'profilesRoot': str(self.profiles), 'officialSkillsDir': str(self.official),
                    'catalogModule': str(self.catalog), 'node': NODE or 'node', 'stateFile': str(self.state),
                    'outDir': str(self.out), 'realProfiles': ['owner']})
        cfg.update(extra)
        return cfg

    def argv(self, now: datetime, *extra: str) -> list[str]:
        cfg = self.config()
        return ['--profiles-root', cfg['profilesRoot'], '--official-skills', cfg['officialSkillsDir'],
                '--catalog-module', cfg['catalogModule'], '--node', cfg['node'], '--state', cfg['stateFile'],
                '--out-dir', cfg['outDir'], '--now', la.iso(now), *extra]

    def outboxes(self) -> list[dict]:
        return [json.loads(p.read_text(encoding='ascii')) for p in sorted((self.out / 'outbox').glob('learning-outbox-*.json'))]


def profile(report: dict, name: str) -> dict:
    return next(p for p in report['profiles'] if p['profile'] == name)


def run_main(argv: list[str]) -> tuple[int, str]:
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        rc = la.main(argv)
    return rc, printed.getvalue()


def fake_symlinks(targets: set[str]):
    """Giả lập symlink theo đường thật (Windows thường không cho tạo symlink)."""
    real = la._lstat

    def fake(path):
        info = real(path)
        if os.path.realpath(path) in targets:
            return os.stat_result((stat.S_IFLNK | 0o777, *tuple(info)[1:]))
        return info
    return mock.patch.object(la, '_lstat', fake)


class LearningAuditTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(NODE, 'node phải có trong PATH: thiếu runtime không phải là đạt')
        # Đường thật (Windows: %TEMP% có tên 8.3) — job ghim gốc hồ sơ đã phân giải.
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix='hermes-learning-audit-')))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.fx = Fixture(self.tmp)

    def test_dead_tool_names_shadowing_and_profile_listing(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        fx.skill(fx.owner, 'productivity/ihome-crm-tasks', '---\nname: ihome-crm-tasks\n---\nBản local cũ dùng mcp__ihomecrm__crm_read_receivables.\n')
        fx.skill(fx.owner, 'note-taking/diary', '---\nname: diary\n---\nGhi nhật ký cá nhân, không liên quan CRM.\n')
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertEqual(report['catalog']['status'], 'ok')
        self.assertEqual([p['profile'] for p in report['profiles']], ['owner', 'tkt'])
        owner = profile(report, 'owner')
        dead = [f for f in owner['findings'] if f['kind'] == 'dead_tool_name']
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]['names'], ['crm_task_create', 'crm_task_input_options'])
        self.assertEqual(dead[0]['skill'], 'crm-task-management')
        shadows = [f for f in owner['findings'] if f['kind'] == 'shadows_official_skill']
        self.assertEqual([(f['skill'], f['names']) for f in shadows], [('ihome-crm-tasks', ['ihome-crm-tasks'])])
        # Tên MCP có tiền tố được chuẩn hoá — không bị coi là chết.
        self.assertFalse(any('crm_read_receivables' in f.get('names', []) for f in owner['findings']))
        self.assertTrue(any(f['kind'] == 'local_crm_skill' and f['skill'] == 'crm-task-management' for f in owner['findings']))
        self.assertIn('Tên tool/thao tác chết: 2', report['summaryVi'])
        self.assertIn('Skill local đè skill chuẩn: 1 (ihome-crm-tasks)', report['summaryVi'])

    def test_missing_catalog_and_official_are_reported_not_guessed(self):
        fx = Fixture(self.tmp / 'second', with_catalog=False, with_official=False)
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertEqual(report['catalog']['status'], 'unavailable')
        self.assertIn('thiếu module', report['catalog']['reason'])
        self.assertEqual(report['official']['status'], 'missing')
        owner = profile(report, 'owner')
        self.assertFalse([f for f in owner['findings'] if f['kind'] in ('dead_tool_name', 'dead_action_id', 'shadows_official_skill')])
        self.assertIn('KHÔNG KIỂM ĐƯỢC TÊN', report['summaryVi'])
        self.assertIn('không kiểm được trùng tên', report['summaryVi'])
        self.assertIn('không kiểm được tên tool', report['notice'])

    def test_broken_catalog_module_is_unavailable(self):
        self.fx.catalog.write_text('export const nothing = 1;\n', encoding='utf-8')
        report, _, _ = la.run_audit(self.fx.config(), NOW, use_state=False)
        self.assertEqual(report['catalog']['status'], 'unavailable')
        self.assertIn('node thoát mã', report['catalog']['reason'])

    def test_catalog_node_runs_without_inherited_node_options_or_capabilities(self):
        # NODE_OPTIONS của môi trường không được lọt vào tiến trình node (nạp mã lạ trước danh mục).
        with mock.patch.dict(os.environ, {'NODE_OPTIONS': '--require ./khong-ton-tai.cjs'}):
            self.assertEqual(la.load_catalog(self.fx.config())['status'], 'ok')
        base = {'module': 'x', 'tools': [], 'actions': []}
        ok = json.dumps({'capEff': '0000000000000000', 'tools': ['crm_action_run'], 'actions': []}).encode()
        self.assertEqual(la.parse_catalog_output(base, 0, ok, b'')['status'], 'ok')
        # Còn CAP_DAC_READ_SEARCH (bit 2) ⇒ không tin danh mục, báo rõ.
        leaked = json.dumps({'capEff': '0000000000000004', 'tools': ['crm_action_run'], 'actions': []}).encode()
        result = la.parse_catalog_output(base, 0, leaked, b'')
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('CapEff', result['reason'])
        self.assertEqual(la.parse_catalog_output(base, 0, b'\xff{', b'')['status'], 'unavailable')

    def test_curator_ledger_crm_write_becomes_proposal_and_preference_auto_applies(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        fx.skill(fx.owner, 'productivity/tone', 'Trả lời ngắn, xưng em.\nDùng emoji vừa phải.\n')
        rel_task = 'productivity/crm-task-management/SKILL.md'
        lines = [
            ledger_line(fx.owner, 'aaa111bbb222', NOW - timedelta(hours=5), 'patch', 'crm-task-management', rel_task,
                        OLD_TASK_SKILL, NEW_TASK_SKILL),
            ledger_line(fx.owner, 'ccc333ddd444', NOW - timedelta(hours=4), 'patch', 'tone', 'productivity/tone/SKILL.md',
                        'Trả lời ngắn, xưng em.\n', 'Trả lời ngắn, xưng em.\nDùng emoji vừa phải.\n'),
            ledger_line(fx.owner, 'eee555fff666', NOW - timedelta(days=10), 'patch', 'crm-task-management', rel_task,
                        OLD_TASK_SKILL, NEW_TASK_SKILL),
            ledger_line(fx.owner, 'user00000001', NOW - timedelta(hours=1), 'patch', 'tone', 'productivity/tone/SKILL.md',
                        'a', 'Người dùng tự sửa: tạo phiếu thu bằng crm_action_run.', actor='user'),
            '{không phải json',
        ]
        (fx.owner / 'skills' / '.curator_ledger.jsonl').write_text('\n'.join(lines) + '\n', encoding='utf-8')
        report, outbox, _ = la.run_audit(fx.config(), NOW, use_state=False)
        owner = profile(report, 'owner')
        self.assertEqual(len(owner['proposals']), 1, owner['proposals'])
        prop = owner['proposals'][0]
        self.assertEqual(prop['kind'], 'skill_crm_write')
        self.assertIn('crm_task_create', prop['content'])
        self.assertNotIn('Keep replies short', prop['content'])  # câu cũ không thuộc phần curator thêm
        self.assertEqual(prop['source']['ledgerId'], 'aaa111bbb222')
        self.assertEqual(prop['source']['sessionId'], '20261031_081600_abcdef12')
        self.assertFalse(prop['source']['diffUnavailable'])
        self.assertRegex(prop['dedupeKey'], r'^[0-9a-f]{64}$')
        self.assertEqual(prop['detectedAt'], la.iso(NOW - timedelta(hours=5)))
        self.assertTrue(any(a['kind'] == 'skill_preference' and a['source']['skill'] == 'tone' for a in owner['autoApplied']))
        self.assertIn('1 dòng sổ curator không đọc được', owner['errors'])
        self.assertEqual(owner['counts']['ledgerNew'], 3)  # mục 10 ngày trước nằm ngoài cửa sổ lần đầu
        # Outbox chỉ có đề xuất (đúng như báo cáo), mỗi hồ sơ đã kiểm một mục — kể cả hồ sơ không có đề xuất (nhịp kiểm).
        self.assertEqual(sorted(outbox), ['generatedAt', 'kind', 'profiles', 'schemaVersion'])
        self.assertEqual([(p['profile'], len(p['proposals'])) for p in outbox['profiles']], [('owner', 1), ('tkt', 0)])
        self.assertEqual(outbox['profiles'][0]['proposals'], owner['proposals'])

    def test_missing_blob_falls_back_to_current_file_and_says_so(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        rel = 'productivity/crm-task-management/SKILL.md'
        line = json.loads(ledger_line(fx.owner, 'abcabcabcabc', NOW - timedelta(hours=2), 'patch', 'crm-task-management', rel,
                                      OLD_TASK_SKILL, NEW_TASK_SKILL))
        line['before'][0]['sha256'] = '0' * 64  # blob trước đã bị dọn
        (fx.owner / 'skills' / '.curator_ledger.jsonl').write_text(json.dumps(line) + '\n', encoding='utf-8')
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        prop = profile(report, 'owner')['proposals'][0]
        self.assertTrue(prop['source']['diffUnavailable'])
        self.assertIn('crm_task_create', prop['content'])

    def test_memory_entries_split_by_section_sign_and_preferences_are_not_copied(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text(
            'CRM receivables: crm_read_receivables pages use cursor, limit max 50.\n§\n'
            'Khi khách chuyển khoản tiền cọc thì tạo phiếu thu bằng crm_action_run với expense.create.\n§\n'
            'Phòng 301 hay hỏi giá: lập phiếu cọc giữ phòng ngay khi khách đồng ý.', encoding='utf-8')
        (fx.owner / 'memories' / 'USER.md').write_text(
            'User communicates in Vietnamese and prefers concise replies.\n§\nUser likes jazz in the evening.', encoding='utf-8')
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        owner = profile(report, 'owner')
        self.assertEqual(owner['counts']['memoryEntries'], 5)
        kinds = sorted((p['kind'], p['source']['file']) for p in owner['proposals'])
        self.assertEqual(kinds, [('memory_crm_write', 'memories/MEMORY.md'), ('memory_crm_write', 'memories/MEMORY.md')])
        self.assertTrue(all(p['source']['firstRun'] for p in owner['proposals']))
        self.assertEqual(len(owner['autoApplied']), 3)
        # Tự áp dụng chỉ được đếm (băm + tên file): nội dung bộ nhớ của người dùng không rời hồ sơ.
        dumped = json.dumps(owner['autoApplied'], ensure_ascii=False)
        for text in ('jazz', 'concise', 'cursor'):
            self.assertNotIn(text, dumped)
        self.assertNotIn('jazz', json.dumps(report, ensure_ascii=False))

    def test_second_run_only_reports_new_items_and_journal_gets_counts_only(self):
        fx = self.fx
        rel = 'productivity/crm-task-management/SKILL.md'
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        ledger = fx.owner / 'skills' / '.curator_ledger.jsonl'
        ledger.write_text(ledger_line(fx.owner, 'aaa111bbb222', NOW - timedelta(hours=5), 'patch', 'crm-task-management', rel,
                                      OLD_TASK_SKILL, NEW_TASK_SKILL) + '\n', encoding='utf-8')
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo việc CRM bằng crm_action_run task.create.', encoding='utf-8')
        cfg = fx.config()
        rc, printed = run_main(fx.argv(NOW))
        self.assertEqual(rc, 0)
        self.assertTrue(fx.state.is_file())
        first = json.loads((fx.out / 'private' / 'latest.json').read_text(encoding='utf-8'))
        self.assertTrue(first['firstRun'])
        self.assertEqual(len(profile(first, 'owner')['proposals']), 2)
        self.assertTrue((fx.out / 'private' / 'latest.txt').read_text(encoding='utf-8').startswith('Kiểm học tập Hermes'))
        # Journal: đúng một dòng JSON đếm số, không tiêu đề/nội dung đề xuất.
        line = json.loads(printed)
        self.assertEqual((line['event'], line['proposals'], line['proposalsReal'], line['profiles']), ('learning_audit', 2, 2, 2))
        self.assertNotIn('crm_task_create', printed)
        self.assertNotIn('task.create', printed)
        newer = NEW_TASK_SKILL.rstrip('\n') + ' Always lock the room with crm_room_lock before a deposit.\n'
        fx.skill(fx.owner, 'productivity/crm-task-management', newer)
        with ledger.open('a', encoding='utf-8') as handle:
            handle.write(ledger_line(fx.owner, 'bbb222ccc333', NOW + timedelta(hours=1), 'patch', 'crm-task-management', rel,
                                     NEW_TASK_SKILL, newer) + '\n')
        later = NOW + timedelta(hours=2)
        report, _, state = la.run_audit(cfg, later, use_state=True)
        owner = profile(report, 'owner')
        self.assertFalse(report['firstRun'])
        self.assertEqual(len(owner['proposals']), 1)
        self.assertIn('crm_room_lock', owner['proposals'][0]['content'])
        self.assertNotIn('crm_task_create', owner['proposals'][0]['content'])
        self.assertEqual(state['profiles']['owner']['ledgerSeen'], ['aaa111bbb222', 'bbb222ccc333'])
        self.assertFalse([f for f in owner['findings'] if f['kind'] == 'skill_changed_without_ledger'])

    def test_outputs_private_report_and_proposals_only_outbox(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo phiếu chi bằng crm_action_run expense.create.', encoding='utf-8')
        make_state_db(fx.owner / 'state.db', [('s1', 'zalo_personal', 'assistant', NOW.timestamp() - 60, 'CRM hiện không cho phép khóa phòng.')])
        rc, _ = run_main(fx.argv(NOW))
        self.assertEqual(rc, 0)
        [box] = fx.outboxes()
        self.assertEqual(box['kind'], 'hermes-learning-outbox')
        self.assertEqual(box['generatedAt'], la.iso(NOW))
        self.assertEqual(sorted(box['profiles'][0]), ['profile', 'proposals'])  # không phát hiện, không "bó tay", không tự áp dụng
        self.assertNotIn('không cho phép', json.dumps(box, ensure_ascii=False))
        for path in [*(fx.out / 'outbox').glob('*.json'), fx.out / 'private' / 'latest.json', fx.state]:
            path.read_bytes().decode('ascii')  # ghi thuần ASCII: không có lỗi mã hoá nào chặn được lần ghi
        if os.name == 'posix':
            mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)  # noqa: E731
            self.assertEqual(mode(fx.out / 'private'), 0o700)
            self.assertEqual(mode(fx.out / 'private' / 'latest.json'), 0o600)
            self.assertEqual(mode(fx.state), 0o600)
            self.assertEqual(mode(fx.out / 'outbox'), 0o750)
            self.assertEqual(mode(next((fx.out / 'outbox').glob('*.json'))), 0o640)

    def test_poisoned_ledger_lines_never_stop_the_job_and_state_advances(self):
        fx = self.fx
        rc, _ = run_main(fx.argv(NOW))
        self.assertEqual(rc, 0)
        lesson = 'Khi tạo việc thì gọi crm_action_run task.create với confirmToken.'
        digest = blob(fx.owner, lesson)
        path = '/home/hermes/.hermes/profiles/owner/skills/productivity/crm-x/SKILL.md'
        poisoned = [
            # surrogate lẻ trong tên skill (chuỗi thoát JSON hợp lệ) — bản cũ chết khi ghi UTF-8 và không bao giờ tiến trạng thái
            '{"id":"p1","ts":"' + (NOW + timedelta(hours=2)).isoformat() + '","actor":"curator","action":"archive",'
            '"skill":"abc' + BS + 'udc00","before":[],"after":[]}',
            # NUL trong mã + mốc 9999 lệch −14:00 (tràn khi đổi sang UTC)
            '{"id":"p2' + BS + 'u0000","ts":"9999-12-31T23:00:00-14:00","actor":"curator","action":"patch","skill":"x",'
            '"before":[],"after":[]}',
            # mốc ở tương lai + surrogate/NUL rải trong actor, skill, phiên ⇒ vẫn thành đề xuất sạch, detectedAt = lúc chạy
            '{"id":"p3","ts":"2099-01-01T00:00:00Z","actor":"curator' + BS + 'ud800","action":"create","skill":"crm-x' + BS + 'u0000",'
            '"evidence":{"session_id":"s' + BS + 'udfff"},"before":[],"after":[{"path":"' + path + '","sha256":"' + digest + '"}]}',
            '[1,2,3]',
        ]
        self.assertTrue(all(ord(ch) < 128 for line in poisoned for ch in line))
        (fx.owner / 'skills' / '.curator_ledger.jsonl').write_bytes(('\n'.join(poisoned) + '\n').encode('ascii'))
        # Bài học thật cùng ngày vẫn phải tới hàng duyệt.
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo phiếu chi bằng crm_action_run expense.create.', encoding='utf-8')
        for day in (1, 2):
            rc, printed = run_main(fx.argv(NOW + timedelta(days=day)))
            self.assertEqual(rc, 0, printed)
            state = json.loads(fx.state.read_text(encoding='ascii'))
            self.assertEqual(state['lastRunAt'], la.iso(NOW + timedelta(days=day)))
        boxes = fx.outboxes()
        self.assertEqual(len(boxes), 3)
        day1 = boxes[1]['profiles'][0]['proposals']
        self.assertEqual(sorted(p['kind'] for p in day1), ['memory_crm_write', 'skill_crm_write'])
        skill = next(p for p in day1 if p['kind'] == 'skill_crm_write')
        self.assertEqual(skill['detectedAt'], la.iso(NOW + timedelta(days=1)))
        self.assertEqual(skill['source']['skill'], 'crm-x')
        for item in day1:
            self.assertTrue(la.valid_proposal(item, NOW + timedelta(days=1)), item)
            dumped = json.dumps(item, ensure_ascii=False)
            self.assertFalse(la._SURROGATES.search(dumped))
            self.assertNotIn('\\u0000', json.dumps(item))
        self.assertEqual(boxes[2]['profiles'][0]['proposals'], [])  # ngày 2: mọi mục đã thấy, không báo lại

    def test_one_bad_ledger_entry_is_a_finding_not_a_crash(self):
        fx = self.fx
        rel = 'productivity/crm-task-management/SKILL.md'
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        (fx.owner / 'skills' / '.curator_ledger.jsonl').write_text('\n'.join([
            ledger_line(fx.owner, 'boom00000001', NOW - timedelta(hours=3), 'patch', 'crm-task-management', rel, OLD_TASK_SKILL, NEW_TASK_SKILL),
            ledger_line(fx.owner, 'good00000002', NOW - timedelta(hours=2), 'patch', 'crm-task-management', rel, OLD_TASK_SKILL, NEW_TASK_SKILL),
        ]) + '\n', encoding='utf-8')
        real = la.ProfileAudit._ledger_entry

        def flaky(self, entry, entry_id, ts, covered):
            if entry_id == 'boom00000001':
                raise RuntimeError('mục lạ')
            return real(self, entry, entry_id, ts, covered)

        with mock.patch.object(la.ProfileAudit, '_ledger_entry', flaky):
            report, _, state = la.run_audit(fx.config(), NOW, use_state=True)
        owner = profile(report, 'owner')
        self.assertEqual([f['ledgerId'] for f in owner['findings'] if f['kind'] == 'ledger_entry_error'], ['boom00000001'])
        self.assertEqual([p['source']['ledgerId'] for p in owner['proposals']], ['good00000002'])
        self.assertEqual(state['profiles']['owner']['ledgerSeen'], ['boom00000001', 'good00000002'])
        self.assertIn('1 mục sổ curator không xử lý được', report['summaryVi'])

    def test_long_tokens_keep_source_title_and_reasons_bounded(self):
        fx = self.fx
        token = 'crm_' + 'x' * 5000 + '_create'
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Khi thu tien coc thi goi ' + token + ' ngay, khong can hoi chu.',
                                                          encoding='utf-8')
        report, outbox, _ = la.run_audit(fx.config(), NOW, use_state=False)
        [prop] = profile(report, 'owner')['proposals']
        self.assertLessEqual(len(prop['title']), la.MAX_TITLE)
        self.assertLessEqual(la.pg_json_bytes(prop['source']), la.MAX_SOURCE_BYTES)
        self.assertTrue(all(len(reason) <= 200 for reason in prop['source']['reasons']))
        self.assertTrue(la.valid_proposal(prop, NOW))
        self.assertEqual(outbox['profiles'][0]['proposals'], [prop])
        dead = [f for f in profile(report, 'owner')['findings'] if f['kind'] == 'dead_tool_name']
        self.assertTrue(all(len(name) <= la.MAX_NAME for f in dead for name in f['names']))

    def test_secrets_and_personal_data_are_redacted_before_leaving_the_profile(self):
        fx = self.fx
        jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
        raw = ['0912345678', '001203012345', 'khach.thue@example.com', 'abcdefghijklmnopqrstu',
               'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', jwt]
        (fx.owner / 'memories' / 'MEMORY.md').write_text(
            'Khi khách 0912 345 678 (CCCD 001203012345, khach.thue@example.com) chuyển cọc thì tạo phiếu thu bằng '
            'crm_action_run expense.create.\nheader Authorization: Bearer abcdefghijklmnopqrstu\n'
            f'khoá sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv; token={jwt}', encoding='utf-8')
        make_state_db(fx.owner / 'state.db', [
            ('s1', 'zalo_personal', 'user', NOW.timestamp() - 120, 'Gọi lại số 0912345678 giúp anh, mã ' + jwt),
            ('s1', 'zalo_personal', 'assistant', NOW.timestamp() - 60, 'Dạ ' + jwt + ' CRM hiện không cho phép khóa phòng.'),
        ])
        rc, _ = run_main(fx.argv(NOW))
        self.assertEqual(rc, 0)
        written = [p.read_text(encoding='utf-8') for p in [*fx.out.rglob('*.json'), *fx.out.rglob('*.txt')]]
        everything = '\n'.join(json.dumps(json.loads(t), ensure_ascii=False) if t.lstrip().startswith('{') else t for t in written)
        for value in raw:
            self.assertNotIn(value, everything)
        self.assertNotIn('912 345 678', everything)
        report = json.loads((fx.out / 'private' / 'latest.json').read_text(encoding='ascii'))
        [prop] = profile(report, 'owner')['proposals']
        for marker in ('[SĐT đã che]', '[số giấy tờ đã che]', '[email đã che]', 'Authorization: [đã che]', '[khoá đã che]', '[JWT đã che]'):
            self.assertIn(marker, prop['content'])
        self.assertIn('crm_action_run expense.create', prop['content'])  # phần bài học vẫn đọc được
        item = profile(report, 'owner')['refusals']['items'][0]
        self.assertIn('[SĐT đã che]', item['previousUser'])
        self.assertIn('[JWT đã che]', item['assistant'])

    def test_redaction_examples(self):
        r = la.redact
        self.assertEqual(r('gọi 0912 345 678 nhé'), 'gọi [SĐT đã che] nhé')
        self.assertEqual(r('SĐT: +84 912 345 678.'), 'SĐT: [SĐT đã che].')
        self.assertEqual(r('số 079203001234.'), 'số [số giấy tờ đã che].')
        self.assertEqual(r('CMND: 024123456'), 'CMND: [số giấy tờ đã che]')
        self.assertEqual(r('STK 0071 0012 34567 Vietcombank'), 'STK [số tài khoản đã che] Vietcombank')
        self.assertEqual(r('mail khach@example.com.vn'), 'mail [email đã che]')
        self.assertEqual(r('dùng Bearer sk_live_0123456789abcdefgh'), 'dùng Bearer [đã che]')
        self.assertEqual(r('mật khẩu: Abc@12345 nhé'), 'mật khẩu: [đã che] nhé')
        self.assertEqual(r('password="hunter2hunter2"'), 'password="[đã che]"')
        self.assertEqual(r('ghp_' + 'a' * 36), '[khoá đã che]')
        self.assertEqual(r('-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----'), '[khoá riêng đã che]')
        # Không che nhầm chữ thường gặp trong bài học CRM.
        for text in ('Thu 1.500.000 đồng tiền cọc', 'Dùng crm_action_run task.create', 'Hạn 31/10/2026 lúc 08:30',
                     'phòng 301, tầng 3', 'mã VIEC-0042', 'confirmToken lấy từ crm_action_run', 'task-management-skill-for-crm',
                     'basic information', 'risk_assessment_document_for_tenants'):
            self.assertEqual(r(text), text)

    def test_skill_change_without_ledger_is_flagged(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', OLD_TASK_SKILL)
        cfg = fx.config()
        _, _, state = la.run_audit(cfg, NOW, use_state=True)
        la.write_atomic(fx.state, la.json_bytes(state))
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        report, _, _ = la.run_audit(cfg, NOW + timedelta(hours=1), use_state=True)
        flagged = [f for f in profile(report, 'owner')['findings'] if f['kind'] == 'skill_changed_without_ledger']
        self.assertEqual(flagged[0]['files'], ['skills/productivity/crm-task-management/SKILL.md'])

    def test_refusals_last_24h_real_profile_only(self):
        fx = self.fx
        t = NOW.timestamp()
        make_state_db(fx.owner / 'state.db', [
            ('20261031_zalo_1', 'zalo_personal', 'user', t - 7300, 'Tạo việc sửa vòi nước phòng 203 cho anh'),
            ('20261031_zalo_1', 'zalo_personal', 'assistant', t - 7200,
             'Em chưa thể tạo được: công cụ tạo việc CRM hiện không khả dụng trong phiên này.'),
            ('20261031_zalo_1', 'zalo_personal', 'user', t - 3700, 'Giữ phòng 301 cho khách'),
            ('20261031_zalo_1', 'zalo_personal', 'assistant', t - 3600, 'CRM hiện không cho phép khóa phòng.'),
            ('20261031_zalo_1', 'zalo_personal', 'assistant', t - 3500, 'Thao tác lock hiện cũng chưa có trong CRM phiên này.'),
            ('20261031_zalo_1', 'zalo_personal', 'assistant', t - 3400, 'Dạ em đã tạo việc VIEC-0042 cho anh.'),
            ('20261030_zalo_0', 'zalo_personal', 'assistant', t - 30 * 3600, 'Công cụ hiện không khả dụng.'),
            ('20261031_full50', 'full50', 'assistant', t - 600, 'Công cụ hiện không khả dụng.'),
        ])
        make_state_db(fx.tkt / 'state.db', [
            ('20261031_tkt', 'zalo_personal', 'assistant', t - 600, 'Công cụ hiện không khả dụng.'),
        ])
        before = snapshot(fx.profiles)
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertEqual(snapshot(fx.profiles), before, 'kiểm học tập không được ghi vào hồ sơ')
        ref = profile(report, 'owner')['refusals']
        self.assertEqual(ref['status'], 'ok')
        self.assertEqual(ref['count'], 3)
        self.assertEqual(ref['sessions'], 1)
        self.assertEqual(ref['byPattern'].get('khong_kha_dung'), 1)
        self.assertEqual(ref['byPattern'].get('khong_cho_phep'), 1)
        self.assertEqual(ref['byPattern'].get('chua_co_trong_crm'), 1)
        newest = ref['items'][0]
        self.assertIn('chưa có trong CRM', newest['assistant'])
        self.assertEqual(newest['previousUser'], 'Giữ phòng 301 cho khách')
        oldest = ref['items'][-1]
        self.assertEqual(oldest['previousUser'], 'Tạo việc sửa vòi nước phòng 203 cho anh')
        self.assertIsNone(profile(report, 'tkt')['refusals'])  # hồ sơ nghiệm thu không đếm
        self.assertEqual(report['totals']['refusalsReal'], 3)
        self.assertIn('"Bó tay" 24 giờ: 3 lần', report['summaryVi'])

    def test_refusals_fall_back_to_private_copy_when_ro_open_fails(self):
        fx = self.fx
        t = NOW.timestamp()
        make_state_db(fx.owner / 'state.db', [
            ('20261031_zalo_1', 'zalo_personal', 'user', t - 700, 'Khoá phòng 301 giúp anh'),
            ('20261031_zalo_1', 'zalo_personal', 'assistant', t - 600, 'CRM hiện không cho phép khóa phòng.'),
        ])
        real = la._connect_ro
        opened: list[str] = []

        def flaky(path):
            opened.append(Path(path).parent.name)
            if Path(path).resolve() == (fx.owner / 'state.db').resolve():
                raise la.sqlite3.OperationalError('attempt to write a readonly database')
            return real(path)

        before = snapshot(fx.profiles)
        with mock.patch.object(la, '_connect_ro', flaky):
            report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertEqual(snapshot(fx.profiles), before)
        self.assertEqual(len(opened), 2)
        self.assertTrue(opened[1].startswith('hermes-learning-audit-'))
        ref = profile(report, 'owner')['refusals']
        self.assertEqual((ref['status'], ref['count']), ('ok', 1))
        self.assertEqual(ref['items'][0]['previousUser'], 'Khoá phòng 301 giúp anh')

    def test_wal_mode_state_db_is_read_in_place_and_from_copy(self):
        """Hermes giữ state.db ở chế độ WAL: tin mới nằm trong -wal chưa checkpoint vẫn phải được đếm (cả khi đọc qua bản sao)."""
        fx = self.fx
        t = NOW.timestamp()
        db = fx.owner / 'state.db'
        make_state_db(db, [('s0', 'zalo_personal', 'user', t - 900, 'Xin chào')])
        writer = sqlite3.connect(db)
        self.addCleanup(writer.close)
        self.assertEqual(writer.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute("INSERT INTO sessions(id, source, started_at) VALUES ('s1','zalo_personal',?)", (t - 1000,))
        writer.execute("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('s1','user','Khoá phòng 301',?)", (t - 700,))
        writer.execute("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('s1','assistant',?,?)",
                       ('CRM hiện không cho phép khóa phòng.', t - 600))
        writer.commit()
        self.assertGreater((fx.owner / 'state.db-wal').stat().st_size, 0)
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        ref = profile(report, 'owner')['refusals']
        self.assertEqual((ref['status'], ref['count']), ('ok', 1))
        self.assertEqual(ref['items'][0]['previousUser'], 'Khoá phòng 301')
        real = la._connect_ro

        def in_place_fails(path):
            if Path(path).resolve() == db.resolve():
                raise la.sqlite3.OperationalError('unable to open database file')
            return real(path)

        with mock.patch.object(la, '_connect_ro', in_place_fails):
            report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        ref = profile(report, 'owner')['refusals']
        self.assertEqual((ref['status'], ref['count']), ('ok', 1))

    def test_invalid_utf8_in_state_db_does_not_break_the_count(self):
        fx = self.fx
        make_state_db(fx.owner / 'state.db', [('s1', 'zalo_personal', 'assistant', NOW.timestamp() - 60, 'placeholder')])
        conn = sqlite3.connect(fx.owner / 'state.db')
        broken = 'CRM hiện không cho phép'.encode('utf-8') + b'\xff'  # byte cuối không phải UTF-8
        conn.execute(f"UPDATE messages SET content=CAST(X'{broken.hex()}' AS TEXT)")
        conn.commit()
        conn.close()
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        ref = profile(report, 'owner')['refusals']
        self.assertEqual((ref['status'], ref['count']), ('ok', 1))
        self.assertIn('\ufffd', ref['items'][0]['assistant'])

    def test_multiline_memory_entry_gets_single_line_title(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text(
            'Quy trình thu cọc:\n- tạo phiếu thu bằng crm_action_run expense.create\n- gửi biên nhận', encoding='utf-8')
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        prop = profile(report, 'owner')['proposals'][0]
        self.assertNotRegex(prop['title'], r'[\n\r\t]')
        self.assertTrue(prop['title'].startswith('Bộ nhớ MEMORY.md: Quy trình thu cọc: - tạo phiếu thu'))
        self.assertIn('\n- tạo phiếu thu', prop['content'])

    def test_ledger_paths_outside_profile_are_never_read(self):
        fx = self.fx
        secret = self.tmp / 'secret.md'
        secret.write_text('SECRET-HOST-KEY: dùng crm_action_run để tạo phiếu', encoding='utf-8')
        container = '/home/hermes/.hermes/profiles/owner/skills/'
        lines = [json.dumps({'id': f'evil{n:08d}', 'ts': (NOW - timedelta(hours=1)).isoformat(), 'actor': 'curator', 'action': 'create',
                             'skill': 'evil', 'evidence': {'session_id': 's'}, 'before': [],
                             'after': [{'path': container + rel, 'sha256': '0' * 64}]})
                 for n, rel in enumerate(['../../../secret.md', '/' + secret.as_posix().lstrip('/'), 'a/../../../../secret.md'])]
        (fx.owner / 'skills' / '.curator_ledger.jsonl').write_text('\n'.join(lines) + '\n', encoding='utf-8')
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertNotIn('SECRET-HOST-KEY', json.dumps(report, ensure_ascii=False))
        owner = profile(report, 'owner')
        self.assertEqual(owner['proposals'], [])
        rejected = [f for f in owner['findings'] if f['kind'] == 'ledger_path_rejected']
        self.assertEqual(len(rejected), 3)  # bỏ nhưng có báo, không mất im lặng
        self.assertIn('3 mục sổ curator có đường file lạ', report['summaryVi'])

    def test_symlinked_profile_root_is_reported_not_followed(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo việc bằng crm_action_run task.create.', encoding='utf-8')
        with fake_symlinks({os.path.realpath(fx.owner)}):  # thư mục hồ sơ bị tráo thành symlink
            report, outbox, state = la.run_audit(fx.config(), NOW, use_state=False)
        owner = profile(report, 'owner')
        self.assertEqual(owner['proposals'], [])
        self.assertEqual([f['kind'] for f in owner['findings']], ['unsafe_profile_file'])
        self.assertNotIn('owner', state['profiles'])
        self.assertEqual([p['profile'] for p in outbox['profiles']], ['tkt'])  # hồ sơ không kiểm được: không có nhịp kiểm
        self.assertIn('CẢNH BÁO: 1 file không đọc an toàn', report['summaryVi'])

    def test_symlinked_profiles_root_fails_and_keeps_the_previous_state(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo việc bằng crm_action_run task.create.', encoding='utf-8')
        self.assertEqual(run_main(fx.argv(NOW))[0], 0)
        kept = fx.state.read_bytes()
        with fake_symlinks({os.path.realpath(fx.profiles)}):
            rc, printed = run_main(fx.argv(NOW + timedelta(days=1)))
        self.assertEqual(rc, 1)  # systemd báo lỗi (OnFailure)
        self.assertEqual(json.loads(printed)['profilesRootError'], 'OSError')
        self.assertEqual(fx.state.read_bytes(), kept)  # không ghi trạng thái rỗng (lần sau không bị coi như lần đầu)
        self.assertEqual(fx.outboxes()[-1]['profiles'], [])

    def test_symlinked_profile_subdirectories_are_refused(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo việc bằng crm_action_run task.create.', encoding='utf-8')
        with fake_symlinks({os.path.realpath(fx.owner / 'skills'), os.path.realpath(fx.owner / 'memories')}):
            report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        owner = profile(report, 'owner')
        self.assertEqual(sorted(f['file'] for f in owner['findings'] if f['kind'] == 'unsafe_profile_file'), ['memories', 'skills'])
        self.assertFalse([f for f in owner['findings'] if f['kind'] == 'dead_tool_name'])
        self.assertEqual(owner['proposals'], [])
        self.assertEqual((owner['counts']['localSkills'], owner['counts']['memoryEntries']), (0, 0))

    def test_symlinked_profile_files_are_never_read(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/evil', '---\nname: evil\n---\nRediscover crm_task_create.\n')
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo việc bằng crm_action_run task.create.', encoding='utf-8')
        make_state_db(fx.owner / 'state.db', [('s1', 'zalo_personal', 'assistant', NOW.timestamp() - 60, 'CRM hiện không cho phép khóa phòng.')])
        targets = {os.path.realpath(fx.owner / 'skills' / 'productivity' / 'evil' / 'SKILL.md'),
                   os.path.realpath(fx.owner / 'memories' / 'MEMORY.md'), os.path.realpath(fx.owner / 'state.db')}
        with fake_symlinks(targets):  # Hermes đã thay file bằng symlink trỏ ra ngoài hồ sơ
            report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        owner = profile(report, 'owner')
        self.assertFalse([f for f in owner['findings'] if f.get('skill') == 'evil'])
        self.assertEqual(owner['proposals'], [])
        self.assertEqual(owner['counts']['memoryEntries'], 0)
        self.assertEqual(owner['refusals']['status'], 'error')
        self.assertTrue(any('state.db không phải file thường' in e for e in owner['errors']))
        # Không để Hermes né kiểm bằng symlink: file bị từ chối được báo mức cao.
        unsafe = sorted(f['file'] for f in owner['findings'] if f['kind'] == 'unsafe_profile_file')
        self.assertEqual(unsafe, ['memories/MEMORY.md', 'skills/productivity/evil/SKILL.md'])
        self.assertTrue(all(f['severity'] == 'high' for f in owner['findings'] if f['kind'] == 'unsafe_profile_file'))
        self.assertIn('CẢNH BÁO: 2 file không đọc an toàn', report['summaryVi'])
        # Máy tạo được symlink thật (Linux/CI) thì kiểm thêm bằng symlink thật trỏ ra ngoài hồ sơ.
        outside = self.tmp / 'outside.md'
        outside.write_text('SECRET-HOST-KEY crm_action_run', encoding='utf-8')
        link = fx.owner / 'skills' / 'productivity' / 'evil' / 'notes.md'
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            return
        report, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        self.assertNotIn('SECRET-HOST-KEY', json.dumps(report, ensure_ascii=False))

    def test_stdout_mode_writes_nothing(self):
        fx = self.fx
        fx.skill(fx.owner, 'productivity/crm-task-management', NEW_TASK_SKILL)
        rc, printed = run_main(fx.argv(NOW, '--stdout'))
        self.assertEqual(rc, 0)
        self.assertFalse(fx.out.exists())
        self.assertEqual(json.loads(printed)['schemaVersion'], la.SCHEMA_VERSION)

    def test_bad_config_types_are_rejected(self):
        bad = self.tmp / 'bad.json'
        bad.write_text(json.dumps({'windowHours': '24'}), encoding='utf-8')
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(la.main(['--config', str(bad), '--stdout']), 2)

    def test_dedupe_keys_are_stable(self):
        fx = self.fx
        (fx.owner / 'memories' / 'MEMORY.md').write_text('Tạo phiếu chi bằng crm_action_run expense.create.', encoding='utf-8')
        first, _, _ = la.run_audit(fx.config(), NOW, use_state=False)
        second, _, _ = la.run_audit(fx.config(), NOW + timedelta(hours=3), use_state=False)
        self.assertEqual([p['dedupeKey'] for p in profile(first, 'owner')['proposals']],
                         [p['dedupeKey'] for p in profile(second, 'owner')['proposals']])

    def test_source_runs_on_python_310(self):
        """VPS chạy Python 3.10: biểu thức trong f-string không được chứa dấu \\ (3.12 mới cho phép)."""
        source = Path(la.__file__).read_text(encoding='utf-8')
        compile(source, la.__file__, 'exec')
        if sys.version_info < (3, 12):
            return  # bản < 3.12 đã tự từ chối cú pháp đó khi compile ở trên
        depth, inside, bad = 0, 0, []
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            name = tokenize.tok_name[tok.type]
            if name in ('FSTRING_START', 'FSTRING_END'):
                inside += 1 if name == 'FSTRING_START' else -1
                continue
            if inside and tok.type == tokenize.OP and tok.string in ('{', '}'):
                depth += 1 if tok.string == '{' else -1
                continue
            if inside and depth > 0 and '\\' in tok.string:
                bad.append(tok.start[0])
        self.assertEqual(bad, [], 'f-string có dấu \\ trong biểu thức (Python 3.10 báo SyntaxError)')

    def test_classifier_examples(self):
        self.assertTrue(la.crm_write_reasons('Use crm_action_run with task.create'))
        self.assertTrue(la.crm_write_reasons('Gọi crm_room_pass_upsert để cập nhật'))
        self.assertTrue(la.crm_write_reasons('Khi khách đặt cọc thì ghi phiếu thu ngay'))
        self.assertFalse(la.crm_write_reasons('User prefers concise replies using anh/em address.'))
        self.assertFalse(la.crm_write_reasons('crm_read_receivables pages use cursor'))
        self.assertFalse(la.crm_write_reasons('crm_read_asset returns one asset'))
        # Chuỗi dài bất thường không làm phân loại chạy bậc hai.
        self.assertEqual(la.crm_write_reasons('crm_' + 'a_' * 200_000 + 'b'), [])


if __name__ == '__main__':
    unittest.main()
