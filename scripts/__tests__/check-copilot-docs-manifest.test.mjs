// Đột biến cho phần CORPUS HƯỚNG DẪN của check-copilot-docs-manifest.
//
// Phần `he-thong` của gate đã có án lệ riêng: bản đầu chỉ so chuỗi con trên toàn
// văn registry.ts, nên xoá SẠCH code lọc manifest vẫn khiến gate xanh. Corpus
// thứ hai (`docs/huong-dan-su-dung`) ra đời 03/09/2026 và ban đầu KHÔNG có nửa
// cưỡng chế nào. File này là nửa đó — và nó phải chứng minh gate CẮN, chứ không
// chỉ chứng minh gate chạy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FILE_NAP_HUONG_DAN,
  boComment,
  thanHamAllowlist,
  thieuLocNangLuc,
  timGlobHuongDanNgoaiAllowlist,
} from '../check-copilot-docs-manifest.mjs';

const REGISTRY = fileURLToPath(new URL('../../src/copilot/tools/registry.ts', import.meta.url));
const nguonThat = readFileSync(REGISTRY, 'utf8');

const GLOB = `const M = import.meta.glob('/docs/huong-dan-su-dung/**/index.md', { query: '?raw' });`;

test('glob huong-dan o file KHAC registry.ts bi bat', () => {
  const vp = timGlobHuongDanNgoaiAllowlist({
    'src/copilot/docs/docSearch.ts': GLOB,
    [FILE_NAP_HUONG_DAN]: GLOB,
  });
  assert.deepEqual(vp, ['src/copilot/docs/docSearch.ts']);
});

test('glob huong-dan o CHINH registry.ts la hop le', () => {
  assert.deepEqual(timGlobHuongDanNgoaiAllowlist({ [FILE_NAP_HUONG_DAN]: GLOB }), []);
});

test('duong dan Windows (backslash) van khop allowlist', () => {
  // Checkout Windows trả `src\copilot\tools\registry.ts`; so thô sẽ coi chính
  // file được phép là vi phạm, và gate đỏ ở nơi không có lỗi nào.
  const key = FILE_NAP_HUONG_DAN.split('/').join('\\');
  assert.deepEqual(timGlobHuongDanNgoaiAllowlist({ [key]: GLOB }), []);
});

test('DOT BIEN: nhac glob trong CHU THICH khong phai vi pham', () => {
  // Án lệ chung của repo: gate đọc MÃ, không đọc văn kể lại về mã. Một gate hay
  // kêu oan cũng chết như một gate không kêu — người ta tắt nó đi.
  const chiLaChuThich = `
    // Trước đây file này có import.meta.glob('/docs/huong-dan-su-dung/**/index.md')
    /* và bản cũ dùng import.meta.glob("/docs/huong-dan-su-dung/x.md") */
    export const x = 1;
  `;
  assert.deepEqual(timGlobHuongDanNgoaiAllowlist({ 'src/copilot/khac.ts': chiLaChuThich }), []);
});

test('DOT BIEN: glob viet bang backtick / nhay kep van bi bat', () => {
  for (const nguon of [
    'import.meta.glob(`/docs/huong-dan-su-dung/**/index.md`)',
    'import.meta.glob(  "/docs/huong-dan-su-dung/**/index.md" )',
  ]) {
    assert.deepEqual(timGlobHuongDanNgoaiAllowlist({ 'src/a.ts': nguon }), ['src/a.ts'], nguon);
  }
});

test('registry.ts THAT hien tai thoa moi manh cua luat allowlist', () => {
  // Sàn chống-xanh-rỗng: nếu hàm không còn tên đó thì mọi đột biến bên dưới
  // "pass" một cách vô nghĩa.
  assert.notEqual(thanHamAllowlist(nguonThat), '');
  assert.deepEqual(thieuLocNangLuc(nguonThat), []);
});

test('DOT BIEN: bo CAPABILITIES ⇒ allowlist thanh danh sach viet tay', () => {
  const doiBien = nguonThat.replace(/for \(const cap of CAPABILITIES\)/, 'for (const cap of DANH_SACH_TAY)');
  assert.notEqual(doiBien, nguonThat);
  assert.ok(thieuLocNangLuc(doiBien).some((v) => v.includes('CAPABILITIES')));
});

test('DOT BIEN: bo loc visibility ⇒ be mat quan tri lot vao index', () => {
  const doiBien = nguonThat.replace(/cap\.docs\.visibility !== 'public'/, 'false');
  assert.notEqual(doiBien, nguonThat);
  assert.ok(thieuLocNangLuc(doiBien).some((v) => v.includes('visibility')));
});

test('DOT BIEN: bo permission ⇒ huong dan Bang luong vao index cho MOI nguoi', () => {
  // Manh dat nhat: bo no thi Copilot mo ta tung cot bang luong cho mot nhan
  // vien phong, va khong loi nao no ra.
  const doiBien = nguonThat
    .replace(/module: cap\.permission\.module, action: cap\.permission\.action/, '');
  assert.notEqual(doiBien, nguonThat);
  assert.ok(thieuLocNangLuc(doiBien).some((v) => v.includes('permission')));
});

test('DOT BIEN: xoa han ham allowlist ⇒ noi ro la khong tim thay', () => {
  const doiBien = nguonThat.replace('export function trangHuongDanChoPhep(', 'function _daXoa(');
  assert.notEqual(doiBien, nguonThat);
  assert.ok(thieuLocNangLuc(doiBien)[0].includes('trangHuongDanChoPhep'));
});

test('DOT BIEN: phep kiem o HAM KHAC khong chung minh duoc ham nay', () => {
  // Thân hàm cắt tới `export function` kế tiếp; nếu không, một hàm khác trong
  // cùng file có nhắc `CAPABILITIES` sẽ "cứu" một allowlist đã rỗng ruột.
  const gia = [
    "export function trangHuongDanChoPhep() {",
    '  return [];',
    '}',
    '',
    "export function khac() {",
    "  return CAPABILITIES.filter((c) => c.docs.visibility === 'public')",
    '    .map((c) => ({ module: c.permission.module, action: c.permission.action, userDoc: c.docs.userDoc }));',
    '}',
  ].join('\n');
  assert.equal(thieuLocNangLuc(gia).length, 4);
});

test('boComment go ca hai kieu chu thich', () => {
  assert.equal(boComment('a // b\nc'), 'a \nc');
  assert.equal(boComment('a /* b */ c'), 'a  c');
});

test('cli: gate hien tai xanh', () => {
  const ra = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../check-copilot-docs-manifest.mjs', import.meta.url))],
    { encoding: 'utf8' },
  );
  assert.match(ra, /Copilot docs manifest khớp thư mục/);
});
