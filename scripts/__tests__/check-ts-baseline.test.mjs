// Gate ts-baseline phải phân biệt được "tsc chạy sạch" với "tsc không chạy".
// Án lệ 02/09/2026: tsc --pretty false in RỖNG khi 0 lỗi, gate coi đó là "không
// đọc được" và exit 2 — đỏ đúng lúc codebase sạch nhất. Ba test này ghim:
// (1) exit 0 + output rỗng = 0 diagnostic; (2) mọi ca khác vẫn fail-closed;
// (3) gate gọi tsc thật, chấp nhận file sạch và trả đúng diagnostic khi file lỗi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSuccessfulCleanTscRun } from '../check-ts-baseline.mjs';

test('chấp nhận tsc exit 0 + output rỗng là 0 diagnostic', () => {
  assert.equal(isSuccessfulCleanTscRun({ status: 0, error: undefined }, '\n'), true);
  assert.equal(isSuccessfulCleanTscRun({ status: 0 }, ''), true);
});

test('mọi ca khác vẫn fail-closed', () => {
  assert.equal(isSuccessfulCleanTscRun({ status: 1 }, ''), false);
  assert.equal(isSuccessfulCleanTscRun({ status: 0 }, 'warning TS1234: gì đó'), false);
  assert.equal(isSuccessfulCleanTscRun({ status: 0, error: new Error('spawn failed') }, ''), false);
  assert.equal(isSuccessfulCleanTscRun(undefined, ''), false);
});

test('gate chạy tsc thật: chấp nhận file sạch và báo đúng diagnostic khi file lỗi', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ihome-ts-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'src', 'tooling', 'node_modules']) mkdirSync(join(root, dir));
  const script = join(root, 'scripts', 'check-ts-baseline.mjs');
  copyFileSync(new URL('../check-ts-baseline.mjs', import.meta.url), script);
  const typescript = fileURLToPath(new URL('../../node_modules/typescript/', import.meta.url));
  symlinkSync(typescript, join(root, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'tsconfig.app.json'), JSON.stringify({
    compilerOptions: { strict: true, types: [], lib: ['es5'], skipLibCheck: true },
    include: ['src'],
  }));
  writeFileSync(join(root, 'ts-baseline.json'), '[]');
  const coverage = join(root, 'tooling', 'ts-coverage-baseline.json');
  writeFileSync(coverage, '{"files":1}');

  const source = join(root, 'src', 'example.ts');
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  writeFileSync(source, 'export const answer: number = 42;');
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Tập lỗi TS khớp baseline \(0 fingerprint/);
  assert.equal(clean.stderr, '');

  // Một lượt compiler dùng cache vẫn phải đo cùng độ phủ với --listFilesOnly.
  const listed = spawnSync(process.execPath, [join(typescript, 'bin', 'tsc'), '--listFilesOnly', '-p', 'tsconfig.app.json'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  const fileCount = (listed.stdout.match(/[/\\]src[/\\]/g) ?? []).length;
  assert.ok(fileCount > 0);
  writeFileSync(coverage, JSON.stringify({ files: fileCount + 1 }));
  const reduced = run();
  assert.equal(reduced.status, 1, `stdout:\n${reduced.stdout}\nstderr:\n${reduced.stderr}`);
  assert.ok(reduced.stderr.includes(`${fileCount} file trong src/ (sàn ${fileCount + 1})`), reduced.stderr);

  writeFileSync(coverage, '{"files":1}');
  writeFileSync(source, 'export const answer: number = "wrong";');
  const invalid = run();
  assert.equal(invalid.status, 1, `stdout:\n${invalid.stdout}\nstderr:\n${invalid.stderr}`);
  assert.match(invalid.stderr, /src\/example\.ts\|TS2322\|/);
});
