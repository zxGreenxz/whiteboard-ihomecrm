import test, { before, after } from 'node:test';
import { sharedW2b } from './wave2-b-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';

// Gói B đợt 2 — test RIÊNG của Gói B (chỉ Gói B sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mỗi báo cáo cần: số khớp RPC/bộ lọc web (dẫn file:line), có/không khoá, khác công ty, toà ∩ overlay,
// sổ quỹ chỉ trong sổ nhìn thấy (chặt hơn web ở chênh lệch chốt sổ), RPC INVOKER luôn nhận danh sách
// toà tường minh, riêng tư (cổ đông, ví, biến động số dư), rào đầu ra broker và đột biến SQL của gói B.
let shared;
before(async () => { shared = await sharedW2b(); });
after(async () => { await shared?.close(); });

test('gói B: bảng báo cáo SQL (hermes_w2b_catalog_v1) khớp khai báo JS (W2B_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'b')));
