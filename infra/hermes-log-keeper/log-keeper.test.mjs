// Kiểm log-keeper.sh bằng journalctl giả (nguồn = file mỗi unit, con trỏ = số dòng đã xuất). Cần bash + GNU find/gzip ⇒ bỏ qua trên Windows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'log-keeper.sh');
const skip = process.platform === 'win32' ? 'cần bash + GNU find/gzip (chạy ở CI Linux)' : false;

const FAKE = `#!/usr/bin/env bash
unit=""; cur=""
for a in "$@"; do case "$a" in --cursor-file=*) cur="\${a#--cursor-file=}";; esac; done
while [ $# -gt 0 ]; do [ "$1" = "-u" ] && { unit="$2"; shift; }; shift; done
src="$FAKE_JOURNAL_DIR/$unit"
[ -f "$src" ] || exit 1
n=0; [ -f "$cur" ] && n=$(cat "$cur")
tail -n +"$((n+1))" "$src"
wc -l < "$src" | tr -d ' ' > "$cur"
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'log-keeper-'));
  const fake = join(root, 'journalctl'); writeFileSync(fake, FAKE); chmodSync(fake, 0o755);
  const journal = join(root, 'journal'); mkdirSync(journal);
  const env = { ...process.env, JOURNALCTL: fake, FAKE_JOURNAL_DIR: journal, LOG_DIR: join(root, 'log'), STATE_DIR: join(root, 'state'),
    UNITS: 'a.service b.service', RETENTION_DAYS: '14', MAX_TOTAL_MB: '300' };
  const run = (extra = {}) => JSON.parse(execFileSync('bash', [SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8' }).trim().split('\n').pop());
  return { root, journal, env, run };
}

// Chuỗi giống token dựng lúc chạy (không viết nguyên văn trong mã — secret-scan quét cả test).
const fakeToken = () => ['hc', 'A'.repeat(20) + 'b1-_'].join('_');
const fakeBearer = () => ['Bearer', 'x'.repeat(12) + '.yz'].join(' ');

test('xuất phần mới theo con trỏ, không lặp, che token', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), `l1 ok\nl2 token ${fakeToken()} end\nl3 auth: ${fakeBearer()}\n`);
  run({ TODAY: '2026-11-05' });
  const day = join(env.LOG_DIR, 'a', '2026-11-05.log');
  const first = readFileSync(day, 'utf8');
  assert.equal(first.split('\n').filter(Boolean).length, 3);
  assert.ok(!first.includes(fakeToken()) && first.includes('hc_***'), 'token hc_ phải bị che');
  assert.ok(first.includes('Bearer ***') && !first.includes('x'.repeat(12)), 'Bearer phải bị che');
  appendFileSync(join(journal, 'a.service'), 'l4 moi\n');
  run({ TODAY: '2026-11-05' });
  const lines = readFileSync(day, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map(l => l.split(' ')[0]), ['l1', 'l2', 'l3', 'l4'], 'lượt 2 chỉ thêm dòng mới');
  assert.ok(!existsSync(join(env.LOG_DIR, 'b', '2026-11-05.log')), 'unit không có journal ⇒ không tạo file rỗng');
});

test('sang ngày mới thì nén ngày cũ; quá hạn thì xoá', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), 'd1\n');
  run({ TODAY: '2026-11-05' });
  appendFileSync(join(journal, 'a.service'), 'd2\n');
  run({ TODAY: '2026-11-06' });
  const dir = join(env.LOG_DIR, 'a');
  assert.deepEqual(readdirSync(dir).sort(), ['2026-11-05.log.gz', '2026-11-06.log']);
  assert.equal(gunzipSync(readFileSync(join(dir, '2026-11-05.log.gz'))).toString(), 'd1\n');
  const old = join(dir, '2026-10-01.log.gz'); writeFileSync(old, 'x');
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(old, t, t);
  run({ TODAY: '2026-11-06' });
  assert.ok(!existsSync(old), 'file nén quá 14 ngày phải bị xoá');
  assert.ok(existsSync(join(dir, '2026-11-05.log.gz')), 'file nén còn hạn giữ nguyên');
});

test('vượt trần dung lượng ⇒ xoá file nén cũ nhất, giữ file hôm nay, vòng lặp dừng', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), 'x\n');
  run({ TODAY: '2026-11-04' });
  appendFileSync(join(journal, 'a.service'), 'y\n');
  run({ TODAY: '2026-11-05' });
  appendFileSync(join(journal, 'a.service'), 'z\n');
  const r = run({ TODAY: '2026-11-06', MAX_TOTAL_MB: '0' });
  assert.ok(r.removedOverCap >= 1);
  assert.deepEqual(readdirSync(join(env.LOG_DIR, 'a')), ['2026-11-06.log']);
});

test('tên unit lạ bị bỏ qua, tham số sai khuôn thì dừng', { skip }, () => {
  const { env, run } = setup();
  run({ UNITS: '../x.service a;rm.service', TODAY: '2026-11-05' });
  assert.ok(!existsSync(join(env.LOG_DIR, '..', 'x')));
  assert.throws(() => run({ TODAY: '05/11/2026' }));
  assert.throws(() => run({ MAX_TOTAL_MB: '-1' }));
});
