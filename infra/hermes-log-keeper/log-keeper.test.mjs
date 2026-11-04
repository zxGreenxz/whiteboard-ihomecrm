// Kiểm log-keeper.sh bằng journalctl giả (nguồn = file mỗi unit, con trỏ = số dòng đã xuất). Cần bash + GNU find/gzip/sed ⇒ chỉ Linux.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'log-keeper.sh');
const skip = process.platform !== 'linux' ? 'cần bash + GNU find/gzip/sed (chạy ở CI Linux)' : false;

// journalctl giả, mô phỏng v249: --cursor-file=<f> chứa số dòng đã xuất; KHÔNG có dòng nào để hiện (unit lạ / hết dòng mới) ⇒ thoát 1,
// stderr rỗng (như journalctl thật khi không lấy được con trỏ). FAKE_FAIL_UNIT=<unit> ⇒ lỗi thật: in 1 dòng, "Failed …" ra stderr, thoát 1.
const FAKE = `#!/usr/bin/env bash
unit=""; cur=""
for a in "$@"; do case "$a" in --cursor-file=*) cur="\${a#--cursor-file=}";; esac; done
while [ $# -gt 0 ]; do [ "$1" = "-u" ] && { unit="$2"; shift; }; shift; done
src="$FAKE_JOURNAL_DIR/$unit"
[ -f "$src" ] || exit 1
if [ "\${FAKE_FAIL_UNIT:-}" = "$unit" ]; then echo "partial"; echo "Failed to read journal: Permission denied" >&2; exit 1; fi
n=0; [ -f "$cur" ] && n=$(cat "$cur")
total=$(wc -l < "$src" | tr -d ' ')
[ "$total" -gt "$n" ] || exit 1
tail -n +"$((n+1))" "$src"
echo "$total" > "$cur"
`;

const roots = [];
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup({ symlinkLog = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'log-keeper-')); roots.push(root);
  const fake = join(root, 'journalctl'); writeFileSync(fake, FAKE); chmodSync(fake, 0o755);
  const journal = join(root, 'journal'); mkdirSync(journal);
  let logDir = join(root, 'log');
  if (symlinkLog) { mkdirSync(join(root, 'private', 'log'), { recursive: true }); symlinkSync(join(root, 'private', 'log'), logDir); }
  const env = { ...process.env, JOURNALCTL: fake, FAKE_JOURNAL_DIR: journal, LOG_DIR: logDir, STATE_DIR: join(root, 'state'),
    UNITS: 'a.service b.service', RETENTION_DAYS: '14', MAX_TOTAL_MB: '300' };
  const exec = (extra = {}) => spawnSync('bash', [SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8' });
  const run = (extra = {}) => {
    const r = exec(extra);
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  return { root, journal, env, run, exec, realLog: symlinkLog ? join(root, 'private', 'log') : logDir };
}

// Chuỗi giống bí mật dựng lúc chạy (không viết nguyên văn — secret-scan quét cả test).
const fakeToken = () => ['hc', 'A'.repeat(20) + 'b1-_'].join('_');
const fakeBearer = (word = 'Bearer') => [word, 'x'.repeat(12) + '.yz'].join(' ');
const fakeJwt = () => ['ey' + 'J' + 'h'.repeat(10), 'p'.repeat(12), 's'.repeat(12)].join('.');
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('xuất phần mới theo con trỏ RIÊNG từng unit, không lặp, che token / Bearer mọi kiểu chữ / JWT', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), `a1 ok\na2 token ${fakeToken()} end\na3 auth: ${fakeBearer()}\n`);
  writeFileSync(join(journal, 'b.service'), `b1 ${fakeBearer('bearer')}\nb2 jwt ${fakeJwt()}\n`);
  run({ TODAY: '2026-11-05' });
  const fa = join(env.LOG_DIR, 'a', '2026-11-05.log'), fb = join(env.LOG_DIR, 'b', '2026-11-05.log');
  const a = readFileSync(fa, 'utf8'), b = readFileSync(fb, 'utf8');
  assert.ok(!a.includes(fakeToken()) && a.includes('hc_***'), 'token hc_ phải bị che');
  assert.ok(a.includes('Bearer ***') && b.includes('bearer ***') && !(a + b).includes('x'.repeat(12)), 'Bearer mọi kiểu chữ phải bị che');
  assert.ok(b.includes('eyJ***') && !b.includes('p'.repeat(12)), 'JWT phải bị che');
  appendFileSync(join(journal, 'a.service'), 'a4 moi\n');
  appendFileSync(join(journal, 'b.service'), 'b3 moi\n');
  run({ TODAY: '2026-11-05' });
  assert.deepEqual(lines(fa).map(l => l.split(' ')[0]), ['a1', 'a2', 'a3', 'a4'], 'lượt 2 chỉ thêm dòng mới của a');
  assert.deepEqual(lines(fb).map(l => l.split(' ')[0]), ['b1', 'b2', 'b3'], 'con trỏ b độc lập với a');
});

test('unit không có journal ⇒ không tạo file rỗng; journalctl lỗi ⇒ thoát 1, con trỏ không tiến, lỗi 3 lần ⇒ bỏ con trỏ', { skip }, () => {
  const { journal, env, run, exec } = setup();
  writeFileSync(join(journal, 'a.service'), 'a1\na2\n');
  run({ TODAY: '2026-11-05', UNITS: 'a.service c.service' });       // c không có journal: journalctl thoát 1 im lặng ⇒ không phải lỗi
  assert.ok(!existsSync(join(env.LOG_DIR, 'c', '2026-11-05.log')));
  const r0 = run({ TODAY: '2026-11-05', UNITS: 'a.service' });       // không có dòng mới: journalctl thoát 1 im lặng ⇒ thoát 0
  assert.equal(r0.failedUnits, 0);
  assert.equal(readFileSync(join(env.STATE_DIR, 'a.service.cursor'), 'utf8').trim(), '2', 'không có dòng mới ⇒ giữ con trỏ');
  appendFileSync(join(journal, 'a.service'), 'a3\n');
  for (let i = 1; i <= 2; i++) {
    const r = exec({ TODAY: '2026-11-05', UNITS: 'a.service', FAKE_FAIL_UNIT: 'a.service' });
    assert.equal(r.status, 1, 'unit lỗi ⇒ thoát 1');
    assert.match(r.stderr, /lỗi xuất a\.service/);
    assert.match(r.stderr, /journalctl: Failed to read journal/, 'stderr của journalctl đi vào journal của unit');
    assert.equal(readFileSync(join(env.STATE_DIR, 'a.service.cursor'), 'utf8').trim(), '2', 'con trỏ giữ nguyên khi lỗi');
  }
  run({ TODAY: '2026-11-05', UNITS: 'a.service' });
  assert.ok(lines(join(env.LOG_DIR, 'a', '2026-11-05.log')).includes('a3'), 'hết lỗi ⇒ xuất tiếp phần chưa xuất');
  assert.ok(!existsSync(join(env.STATE_DIR, 'a.service.fails')), 'thành công ⇒ xoá đếm lỗi');
  for (let i = 1; i <= 3; i++) exec({ TODAY: '2026-11-05', UNITS: 'a.service', FAKE_FAIL_UNIT: 'a.service' });
  assert.ok(!existsSync(join(env.STATE_DIR, 'a.service.cursor')), 'lỗi 3 lần liền ⇒ bỏ con trỏ');
});

test('sang ngày mới thì nén ngày cũ (đã có .gz ⇒ nối, không ghi đè); quá hạn thì xoá', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), 'd1\n');
  run({ TODAY: '2026-11-05' });
  appendFileSync(join(journal, 'a.service'), 'd2\n');
  run({ TODAY: '2026-11-06' });
  const dir = join(env.LOG_DIR, 'a');
  assert.deepEqual(readdirSync(dir).sort(), ['2026-11-05.log.gz', '2026-11-06.log']);
  assert.equal(gunzipSync(readFileSync(join(dir, '2026-11-05.log.gz'))).toString(), 'd1\n');
  writeFileSync(join(dir, '2026-11-05.log'), 'tre\n');           // ngày đã nén xuất hiện lại
  run({ TODAY: '2026-11-06' });
  assert.equal(gunzipSync(readFileSync(join(dir, '2026-11-05.log.gz'))).toString(), 'd1\ntre\n', 'nối member gzip, giữ bản cũ');
  const old = join(dir, '2026-10-01.log.gz'); writeFileSync(old, gzipSync('x'));
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(old, t, t);
  run({ TODAY: '2026-11-06' });
  assert.ok(!existsSync(old), 'file nén quá 14 ngày phải bị xoá');
  assert.ok(existsSync(join(dir, '2026-11-05.log.gz')), 'file nén còn hạn giữ nguyên');
});

test('LOG_DIR là symlink (như DynamicUser) ⇒ xoá theo tuổi và trần vẫn chạy', { skip }, () => {
  const { journal, run, realLog } = setup({ symlinkLog: true });
  writeFileSync(join(journal, 'a.service'), 'x\n');
  run({ TODAY: '2026-11-06' });
  const dir = join(realLog, 'a');
  const old = join(dir, '2026-10-01.log.gz'); writeFileSync(old, gzipSync('x'));
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(old, t, t);
  const big = join(dir, '2026-11-04.log.gz'); writeFileSync(big, randomBytes(1400 * 1024));
  const r = run({ TODAY: '2026-11-06', MAX_TOTAL_MB: '1' });
  assert.ok(!existsSync(old), 'xoá theo tuổi qua symlink');
  assert.ok(!existsSync(big) && r.removedOverCap === 1, 'trần dung lượng qua symlink');
  assert.ok(existsSync(join(dir, '2026-11-06.log')), 'file hôm nay giữ nguyên');
});

test('vượt trần ⇒ xoá file nén CŨ NHẤT trước, dừng khi đủ', { skip }, () => {
  const { journal, env, run } = setup();
  writeFileSync(join(journal, 'a.service'), 'z\n');
  run({ TODAY: '2026-11-06' });
  const dir = join(env.LOG_DIR, 'a');
  const now = Date.now() / 1000;
  const mk = (name, ageDays) => { const f = join(dir, name); writeFileSync(f, randomBytes(600 * 1024)); utimesSync(f, now - ageDays * 86400, now - ageDays * 86400); return f; };
  const f3 = mk('2026-11-03.log.gz', 3), f4 = mk('2026-11-04.log.gz', 2), f5 = mk('2026-11-05.log.gz', 1);
  const r = run({ TODAY: '2026-11-06', MAX_TOTAL_MB: '1' });
  assert.equal(r.removedOverCap, 2);
  assert.ok(!existsSync(f3) && !existsSync(f4) && existsSync(f5), 'giữ bản mới nhất, xoá hai bản cũ');
});

test('tên unit lạ bị bỏ qua, tham số sai khuôn thì dừng', { skip }, () => {
  const { env, run, root } = setup();
  writeFileSync(join(root, 'log-sentinel.log'), 'x\n');
  run({ UNITS: '../x.service a;rm.service ...service .x.service', TODAY: '2026-11-05' });
  assert.ok(!existsSync(join(root, 'x')) && existsSync(join(root, 'log-sentinel.log')), 'không ghi / nén ngoài LOG_DIR');
  assert.deepEqual(readdirSync(env.LOG_DIR), []);
  assert.throws(() => run({ TODAY: '05/11/2026' }));
  assert.throws(() => run({ MAX_TOTAL_MB: '-1' }));
});
