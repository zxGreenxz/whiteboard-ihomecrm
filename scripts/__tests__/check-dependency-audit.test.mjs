// Đột biến cho check-dependency-audit.
//
// Mỗi ca dưới đây trả lời một câu: "nếu gate hỏng theo kiểu X thì test nào đỏ?"
// Không có bộ này thì một gate luôn-xanh và một gate đúng nhìn giống hệt nhau.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TANG,
  goiDuocSrcNap,
  gocCapMot,
  soSanhBaseline,
  vanTay,
  xepTang,
} from '../check-dependency-audit.mjs';

// ── Bộ dò import ─────────────────────────────────────────────────────────────
// Ca quan trọng nhất: `import('xlsx')` ĐỘNG. Bỏ sót dạng này là hạ nhầm tầng
// của đúng gói nguy hiểm nhất — chính lỗi tôi suýt mắc khi viết gate.

test('bắt import động — bỏ sót là hạ nhầm tầng gói đang chạy trên trình duyệt', () => {
  const ra = goiDuocSrcNap([`const getXLSX = () => import('xlsx');`]);
  assert.ok(ra.has('xlsx'));
});

test('bắt cả from và require', () => {
  const ra = goiDuocSrcNap([`import a from "recharts";`, `const b = require('lodash');`]);
  assert.ok(ra.has('recharts'));
  assert.ok(ra.has('lodash'));
});

test('bỏ qua đường dẫn tương đối và alias @/ — không phải gói npm', () => {
  const ra = goiDuocSrcNap([`import x from './a';`, `import y from '@/lib/b';`, `import z from '/c';`]);
  assert.equal(ra.size, 0);
});

test('gói có scope giữ đủ hai đoạn, gói con cắt về gốc', () => {
  const ra = goiDuocSrcNap([`import a from '@supabase/supabase-js/dist/x';`, `import b from 'date-fns/format';`]);
  assert.ok(ra.has('@supabase/supabase-js'));
  assert.ok(!ra.has('@supabase'));
  assert.ok(ra.has('date-fns'));
});

// ── Truy gốc cấp một ─────────────────────────────────────────────────────────

test('gói lồng sâu vẫn quy về đúng gốc cấp một', () => {
  const cay = {
    dependencies: {
      'tailwindcss-animate': { dependencies: { tailwindcss: { dependencies: { glob: {} } } } },
    },
  };
  assert.deepEqual([...gocCapMot(cay).get('glob')], ['tailwindcss-animate']);
});

test('một gói tới được từ nhiều gốc thì giữ đủ cả hai', () => {
  const cay = {
    dependencies: { a: { dependencies: { x: {} } }, b: { dependencies: { x: {} } } },
  };
  assert.deepEqual([...gocCapMot(cay).get('x')].sort(), ['a', 'b']);
});

// ── Xếp tầng ─────────────────────────────────────────────────────────────────

test('không có trong cây production ⇒ chỉ-dev', () => {
  const t = xepTang('vitest', {
    trongCayProd: new Set(),
    gocProd: new Map(),
    srcNap: new Set(['react']),
  });
  assert.equal(t, TANG.CHI_DEV);
});

test('trong cây production nhưng gốc không được src nạp ⇒ cài-đặt-prod', () => {
  const t = xepTang('glob', {
    trongCayProd: new Set(['glob']),
    gocProd: new Map([['glob', new Set(['tailwindcss-animate'])]]),
    srcNap: new Set(['react']),
  });
  assert.equal(t, TANG.CAI_DAT_PROD);
});

test('gốc được src nạp ⇒ có-thể-vào-bundle', () => {
  const t = xepTang('lodash', {
    trongCayProd: new Set(['lodash']),
    gocProd: new Map([['lodash', new Set(['recharts'])]]),
    srcNap: new Set(['recharts']),
  });
  assert.equal(t, TANG.CO_THE_VAO_BUNDLE);
});

test('ĐỘT BIẾN: nếu bộ dò import bỏ sót recharts thì lodash tụt xuống tầng vô hại', () => {
  // Đây là cách hỏng NGUY HIỂM NHẤT của gate này: nó vẫn xanh, vẫn in số, chỉ
  // xếp sai tầng — và tầng sai lại là tầng không cần ai ký nhận.
  const t = xepTang('lodash', {
    trongCayProd: new Set(['lodash']),
    gocProd: new Map([['lodash', new Set(['recharts'])]]),
    srcNap: new Set(),
  });
  assert.equal(t, TANG.CAI_DAT_PROD);
  assert.notEqual(t, TANG.CO_THE_VAO_BUNDLE);
});

// ── Ratchet trên TẬP ─────────────────────────────────────────────────────────

const T = new Date('2026-08-11T00:00:00Z').getTime();
const muc = (v, hetHan) => ({ vanTay: v, lyDo: 'x', hetHan });

test('vân tay mới chưa ai ký ⇒ báo mới', () => {
  const r = soSanhBaseline([vanTay(TANG.CO_THE_VAO_BUNDLE, 'axios', 'high')], [], T);
  assert.deepEqual(r.moi, ['co-the-vao-bundle|axios|high']);
});

test('ĐỘT BIẾN: vá một lỗ và nhận một lỗ mới KHÔNG được hoà — đếm số sẽ im lặng', () => {
  const baseline = [muc('co-the-vao-bundle|a|high', '2026-12-31')];
  const r = soSanhBaseline([vanTay(TANG.CO_THE_VAO_BUNDLE, 'b', 'high')], baseline, T);
  assert.deepEqual(r.moi, ['co-the-vao-bundle|b|high']);
  assert.deepEqual(r.thua, ['co-the-vao-bundle|a|high']);
});

test('đổi MỨC của cùng một gói cũng là vân tay mới — leo thang phải được thấy', () => {
  const baseline = [muc('co-the-vao-bundle|xlsx|moderate', '2026-12-31')];
  const r = soSanhBaseline([vanTay(TANG.CO_THE_VAO_BUNDLE, 'xlsx', 'critical')], baseline, T);
  assert.deepEqual(r.moi, ['co-the-vao-bundle|xlsx|critical']);
});

test('đổi TẦNG của cùng một gói cũng là vân tay mới — gói vừa chạm tới bundle', () => {
  const baseline = [muc('cai-dat-prod|glob|high', '2026-12-31')];
  const r = soSanhBaseline([vanTay(TANG.CO_THE_VAO_BUNDLE, 'glob', 'high')], baseline, T);
  assert.deepEqual(r.moi, ['co-the-vao-bundle|glob|high']);
});

test('đã vá thì phải bỏ khỏi baseline, kẻo nó che lần tái phát sau', () => {
  const r = soSanhBaseline([], [muc('cai-dat-prod|yaml|moderate', '2026-12-31')], T);
  assert.deepEqual(r.thua, ['cai-dat-prod|yaml|moderate']);
  assert.deepEqual(r.moi, []);
});

test('ký nhận quá hạn ⇒ đỏ, dù lỗ hổng không đổi gì', () => {
  const v = vanTay(TANG.CAI_DAT_PROD, 'yaml', 'moderate');
  const r = soSanhBaseline([v], [muc(v, '2026-08-10')], T);
  assert.deepEqual(r.hetHan, [v]);
});

test('ký nhận còn hạn ⇒ im lặng', () => {
  const v = vanTay(TANG.CAI_DAT_PROD, 'yaml', 'moderate');
  const r = soSanhBaseline([v], [muc(v, '2026-08-12')], T);
  assert.deepEqual(r, { moi: [], thua: [], hetHan: [] });
});

test('hetHan không phải ngày đọc được ⇒ coi như quá hạn, không phải bỏ qua', () => {
  const v = vanTay(TANG.CAI_DAT_PROD, 'yaml', 'moderate');
  const r = soSanhBaseline([v], [muc(v, 'bao giờ đó')], T);
  assert.deepEqual(r.hetHan, [v]);
});

test('lỗ hổng chỉ-dev không sinh vân tay nên không cần ký nhận', () => {
  // Bảo vệ ranh giới phạm vi: 6 advisory dev (kể cả 1 critical của vitest)
  // không được kéo vào baseline, nếu không baseline sẽ đầy nhiễu và mất tác dụng.
  assert.ok(!new Set([TANG.CO_THE_VAO_BUNDLE, TANG.CAI_DAT_PROD]).has(TANG.CHI_DEV));
});
