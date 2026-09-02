// Gate ts-baseline phải phân biệt được "tsc chạy sạch" với "tsc không chạy".
// Án lệ 02/09/2026: tsc --pretty false in RỖNG khi 0 lỗi, gate coi đó là "không
// đọc được" và exit 2 — đỏ đúng lúc codebase sạch nhất. Ba test này ghim:
// (1) exit 0 + output rỗng = 0 diagnostic; (2) mọi ca khác vẫn fail-closed;
// (3) gate thật chạy trên repo hiện tại exit 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('gate ts-baseline chạy thật trên repo: exit 0, không rơi vào nhánh "không đọc được"', () => {
  const script = fileURLToPath(new URL('../check-ts-baseline.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr ?? '', /tsc không cho ra kết quả đọc được/);
});
