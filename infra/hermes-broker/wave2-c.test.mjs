import test, { before, after } from 'node:test';
import { sharedW2c } from './wave2-c-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';

// Gói C đợt 2 — test RIÊNG của Gói C (chỉ Gói C sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mỗi báo cáo cần: số khớp RPC/bộ lọc web (dẫn file:line), có/không khoá, khác công ty, toà ∩ overlay,
// lương người khác đúng điều kiện web, "lương của tôi" chỉ chính người hỏi, khách hotspot Network Center
// cần customers.view (chặt hơn web), riêng tư, rào đầu ra broker và đột biến SQL của gói C.
let shared;
before(async () => { shared = await sharedW2c(); });
after(async () => { await shared?.close(); });

test('gói C: bảng báo cáo SQL (hermes_w2c_catalog_v1) khớp khai báo JS (W2C_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'c')));
