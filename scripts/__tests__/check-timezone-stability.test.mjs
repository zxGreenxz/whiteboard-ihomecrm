import { expect, test } from 'vitest';

import { extractVitestFailures, parseVitestSummary } from '../check-timezone-stability.mjs';

const ESC = String.fromCharCode(27);
const coloured = [
  'Error: Not implemented: window.scrollTo',
  `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m src/lib/__tests__/a.test.ts ${ESC}[2m>${ESC}[22m ca đỏ`,
  'Error: Test timed out in 5000ms.',
  ` ${ESC}[2mTest Files ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m | ${ESC}[1m${ESC}[32m2 passed${ESC}[39m${ESC}[22m (3)`,
  ` ${ESC}[2m     Tests ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m | ${ESC}[1m${ESC}[32m9 passed${ESC}[39m${ESC}[22m (10)`,
].join('\n');

test('dòng FAIL có màu ANSI vẫn được giữ, kèm tên test và lỗi', () => {
  expect(extractVitestFailures(coloured)).toEqual([
    'FAIL  src/lib/__tests__/a.test.ts > ca đỏ',
    'Error: Test timed out in 5000ms.',
  ]);
});

test('nhiễu in trước không chiếm chỗ của tên test đỏ', () => {
  const noise = Array.from({ length: 50 }, () => 'Error creating income expense: TypeError: Failed to fetch').join('\n');
  expect(extractVitestFailures(`${noise}\n${coloured}`, 1)).toEqual(['FAIL  src/lib/__tests__/a.test.ts > ca đỏ']);
});

test('đọc được số test từ tóm tắt có màu', () => {
  expect(parseVitestSummary(coloured)).toEqual({ testsFailed: 1, testsPassed: 9, filesFailed: 1, filesPassed: 2 });
});
