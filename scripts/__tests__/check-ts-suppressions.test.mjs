// Đột biến cho bộ dò chỉ thị tắt kiểm tra kiểu.
//
// Trọng tâm: VỊ TRÍ. TypeScript chỉ công nhận chỉ thị ở ĐẦU nội dung comment,
// nên đó cũng phải là điều kiện của gate — không hơn, không kém.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECTIVE } from '../check-ts-suppressions.mjs';

const bat = (s) => [...s.matchAll(new RegExp(DIRECTIVE.source, 'g'))];

test('ĐỘT BIẾN: nhắc TÊN chỉ thị giữa câu văn KHÔNG phải là chỉ thị', () => {
  // Bản cũ khớp chuỗi ở mọi vị trí, nên một dòng giải thích "ở đây không dùng…"
  // bị đếm y như một chỗ tắt kiểm tra kiểu thật. Đã dính đúng trong lát gỡ chỉ
  // thị cuối cùng: gỡ xong mà gate vẫn báo 1, và cái thứ 1 đó chính là câu văn
  // vừa viết ra để giải thích việc gỡ.
  assert.deepEqual(bat('// Chỗ này trước dùng chỉ thị `@ts-expect-error`, và nó SAI.'), []);
  assert.deepEqual(bat('const s = "văn bản nhắc @ts-ignore trong chuỗi";'), []);
});

test('vẫn bắt đủ mọi dạng viết mà TypeScript công nhận', () => {
  for (const s of [
    '// @ts-ignore',
    '//@ts-ignore',
    '/* @ts-ignore */',
    '/// @ts-expect-error',
    '// @ts-nocheck',
    '  // @ts-expect-error kèm lời giải thích phía sau',
  ]) {
    assert.equal(bat(s).length, 1, `phải bắt được: ${s}`);
  }
});

test('phân biệt đúng ba loại chỉ thị', () => {
  assert.equal(bat('// @ts-ignore')[0][1], 'ignore');
  assert.equal(bat('// @ts-expect-error')[0][1], 'expect-error');
  assert.equal(bat('// @ts-nocheck')[0][1], 'nocheck');
});

test('chuỗi gần giống không bị bắt nhầm', () => {
  assert.deepEqual(bat('// @ts-ignored'), []);
  assert.deepEqual(bat('// ts-ignore'), []);
});
