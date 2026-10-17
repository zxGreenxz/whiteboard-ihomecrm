import test, { before, after } from 'node:test';
import { sharedW2d } from './wave2-d-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';

// Gói D đợt 2 — test RIÊNG của Gói D (chỉ Gói D sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mỗi báo cáo cần: số khớp RPC/bộ lọc web (dẫn file:line), có/không khoá, khác công ty, toà ∩ overlay,
// cột danh sách trắng (không select *: hoa hồng, tài khoản, SĐT NCC…), báo cáo BĐS không cắt 1000 như
// web (sourceCapped), rào đầu ra broker và đột biến SQL của gói D.
let shared;
before(async () => { shared = await sharedW2d(); });
after(async () => { await shared?.close(); });

test('gói D: bảng báo cáo SQL (hermes_w2d_catalog_v1) khớp khai báo JS (W2D_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'd')));
