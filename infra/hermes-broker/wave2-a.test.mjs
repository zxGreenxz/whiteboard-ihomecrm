import test, { before, after } from 'node:test';
import { sharedW2a } from './wave2-a-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';

// Gói A đợt 2 — test RIÊNG của Gói A (chỉ Gói A sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mỗi báo cáo cần: số khớp RPC/bộ lọc web (dẫn file:line), có/không khoá, khác công ty, toà ∩ overlay,
// Toàn tổ chức khi scope=organization, riêng tư (tên/SĐT khách cần customers.view qua ctx.scopes),
// rào đầu ra broker (domainInput/domainResult của crm_read_report) và đột biến SQL trên chính migration gói A.
let shared;
before(async () => { shared = await sharedW2a(); });
after(async () => { await shared?.close(); });

test('gói A: bảng báo cáo SQL (hermes_w2a_catalog_v1) khớp khai báo JS (W2A_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'a')));
