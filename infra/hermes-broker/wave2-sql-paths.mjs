// Đợt 2: chuỗi migration theo DẢI TIMESTAMP cấp trước cho từng gói (Gói 0, 18/10/2026) — các gói
// thêm file trong dải của mình mà không sửa file này, khỏi đổi tên khi rebase. Thứ tự áp = thứ tự tên.
//   nền (Gói 0)  2026101800xxxx_hermes_w2_<slug>.sql    (20261018000000_hermes_w2_foundation_v1, 000500 _fixes_v1,
//                                                       000600 _invoker_gate_v1)
//   Gói A        2026101801xxxx_hermes_w2a_<slug>.sql   (đề xuất 20261018010000_hermes_w2a_receivables_read_v1)
//   Gói B        2026101802xxxx_hermes_w2b_<slug>.sql   (đề xuất 20261018020000_hermes_w2b_cashbook_read_v1)
//   Gói C        2026101803xxxx_hermes_w2c_<slug>.sql   (đề xuất 20261018030000_hermes_w2c_ops_read_v1)
//   Gói D        2026101804xxxx_hermes_w2d_<slug>.sql   (đề xuất 20261018040000_hermes_w2d_catalog_read_v1)
//   Gói Z        2026101808xxxx_hermes_w2z_<slug>.sql   (sửa lúc tích hợp, áp TRƯỚC công tắc; được thay hàm của gói)
//                2026101809xxxx_hermes_w2_<slug>.sql    (20261018090000_hermes_w2_enable_v1 — công tắc bật khoá)
// Sửa sau review trong cùng gói: timestamp kế tiếp trong dải (vd. 20261018010100_hermes_w2a_review_fixes_v1).
// KHÔNG dùng scripts/tao-ten-migration.mjs cho các file trong dải (nó cấp giờ thực, ra ngoài dải).
// Sửa SAU phát hành (sau công tắc 20261018090000): tên do scripts/tao-ten-migration.mjs cấp (giờ thực UTC từ 18/10 10:00
// trở đi), tiền tố của đúng gói (vd. 20261018182656_hermes_w2a_reservation_fund_member_v1) ⇒ thuộc gói đó, áp sau công tắc;
// tiền tố hermes_w2_ (vd. 20261018185339_hermes_w2_rls_buildings_scope_v1) ⇒ thuộc nền (được thay hàm nền).
import { readdirSync, readFileSync } from 'node:fs';

export const W2_MIGRATION_DIR = 'supabase/migrations';
export const W2_FOUNDATION_FILE = '20261018000000_hermes_w2_foundation_v1.sql';
export const W2_FOUNDATION_PATH = `${W2_MIGRATION_DIR}/${W2_FOUNDATION_FILE}`;
export const W2_FIXES_FILE = '20261018000500_hermes_w2_foundation_fixes_v1.sql';
export const W2_FIXES_PATH = `${W2_MIGRATION_DIR}/${W2_FIXES_FILE}`;
// Cổng INVOKER + RLS: lối vào public.hermes_w2_read_v1, bước kiểm quyền/bước kết thúc DEFINER, hàm gói INVOKER.
export const W2_INVOKER_FILE = '20261018000600_hermes_w2_invoker_gate_v1.sql';
export const W2_INVOKER_PATH = `${W2_MIGRATION_DIR}/${W2_INVOKER_FILE}`;
// Rào công ty (organizationId mọi hàng, buildingId mọi hàng theo toà) + loại khoá organization.
export const W2_ORG_FENCE_FILE = '20261018000700_hermes_w2_org_fence_v1.sql';
export const W2_ORG_FENCE_PATH = `${W2_MIGRATION_DIR}/${W2_ORG_FENCE_FILE}`;
// Mốc giờ thực sau công tắc: 18/10 10:00–23:59:59 UTC hoặc ngày sau đó (đến hết 2026).
const W2_POST = String.raw`(?:20261018(?:1\d|2[0-3])\d{4}|2026(?:10(?:19|2\d|3[01])|1[12]\d\d)\d{6})`;
const w2Package = (band, letter) => new RegExp(String.raw`^(?:202610180${band}\d{4}|${W2_POST})_hermes_w2${letter}_[a-z0-9_]+\.sql$`);
export const W2_RANGES = Object.freeze({
  foundation: new RegExp(String.raw`^(?:2026101800\d{4}|${W2_POST})_hermes_w2_[a-z0-9_]+\.sql$`),
  a: w2Package(1, 'a'),
  b: w2Package(2, 'b'),
  c: w2Package(3, 'c'),
  d: w2Package(4, 'd'),
  z: /^20261018(?:08\d{4}_hermes_w2z|09\d{4}_hermes_w2)_[a-z0-9_]+\.sql$/,
});
export const W2_PACKAGE_LETTERS = Object.freeze(['a', 'b', 'c', 'd']);

/** Đường dẫn migration đợt 2 theo thứ tự áp: MỌI file nền (dải 2026101800) rồi các gói được chọn
 * (mặc định mọi gói + Z). */
export function w2MigrationPaths({ packages = ['a', 'b', 'c', 'd', 'z'], dir = W2_MIGRATION_DIR } = {}) {
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  if (!files.includes(W2_FOUNDATION_FILE)) throw new Error(`missing ${W2_FOUNDATION_FILE}`);
  const picked = files.filter(name => W2_RANGES.foundation.test(name) || packages.some(letter => W2_RANGES[letter]?.test(name)));
  return picked.map(name => `${dir}/${name}`);
}

// Hàm NỀN: định nghĩa cuối phải nằm ở dải nền hoặc dải Z (gói không được thay).
export const W2_FOUNDATION_FUNCTIONS = Object.freeze(['app_private.hermes_w2_read_keys_v1', 'app_private.hermes_w2_self_keys_v1',
  'app_private.hermes_w2_reused_keys_v1', 'app_private.hermes_w2_permission_kind_v1', 'app_private.hermes_w2_grant_v1',
  'public.hermes_domain_capabilities_v3', 'app_private.hermes_w2_extend_options_v1', 'public.hermes_org_policy_options_v7',
  'public.hermes_connection_options_v7', 'public.hermes_connection_context_v7', 'app_private.hermes_w2_param_names_v1',
  'app_private.hermes_w2_catalog_v1', 'app_private.hermes_w2_params_v1', 'app_private.hermes_w2_gate_v1', 'public.hermes_domain_read_v3',
  'app_private.hermes_w2_scope_v1', 'app_private.hermes_w2_finish_v1', 'public.hermes_w2_read_v1', 'app_private.hermes_w2_org_keys_v1']);
const stripComments = sql => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
// Tên có/không ngoặc kép, có khoảng trắng quanh dấu chấm; tên không schema bắt riêng (vi phạm ở dải gói).
const NAME = String.raw`"?([a-z_][a-z0-9_$]*)"?\s*\.\s*"?([a-z_][a-z0-9_$]*)"?`;
const qualified = (match, schema = 1, name = 2) => `${match[schema].toLowerCase()}.${match[name].toLowerCase()}`;
const createdFunctions = sql => [...stripComments(sql).matchAll(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+${NAME}\s*\(`, 'gi'))]
  .map(match => qualified(match));
const unqualifiedFunctions = sql => [...stripComments(sql).matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+"?([a-z_][a-z0-9_$]*)"?\s*\(/gi)]
  .map(match => match[1].toLowerCase());
const alteredFunctions = sql => [...stripComments(sql).matchAll(new RegExp(String.raw`\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+${NAME}\s*\([^)]*\)\s*([^;]*)`, 'gi'))]
  .map(match => ({ fn: qualified(match), action: match[3].trim().replace(/\s+/g, ' ') }));
// DO … EXECUTE (SQL động) có thể tạo/thay hàm mà regex không thấy: cấm ở dải gói.
const dynamicBlocks = sql => [...stripComments(sql).matchAll(/\bDO\s+(?:LANGUAGE\s+[a-z]+\s+)?(\$[a-z_]*\$)([\s\S]*?)\1/gi)]
  .filter(match => /\bEXECUTE\b/i.test(match[2])).length + (/\bDO\s+(?:LANGUAGE\s+[a-z]+\s+)?'/i.test(stripComments(sql)) ? 1 : 0);

/** Hàng rào gói (P2-4, review PR #195; mở rộng sau review cổng INVOKER). files: [{name, sql}] mọi migration theo
 * thứ tự tên. Trả danh sách vi phạm: file trong dải gói <x> chỉ được tạo/thay hermes_w2<x>_* (public hoặc
 * app_private) hoặc hàm dùng chung MỚI public.<miền>_*_v<n> (không bắt đầu bằng hermes_, chỉ do file của chính gói
 * định nghĩa, hoặc dải Z — agent tích hợp sửa sau review); tên hàm phải có schema (có/không ngoặc kép đều bắt); ALTER
 * FUNCTION chỉ trên hàm của gói và chỉ OWNER TO postgres; không DO … EXECUTE. Định nghĩa cuối của hàm nền phải nằm ở dải
 * nền hoặc Z (test PGlite còn so định nghĩa SỐNG trong catalog với bản của file nền). */
export function w2FenceViolations(files) {
  const violations = [], definedBy = new Map();
  for (const { name, sql } of files) for (const fn of createdFunctions(sql)) definedBy.set(fn, [...(definedBy.get(fn) ?? []), name]);
  for (const { name, sql } of files) {
    const letter = W2_PACKAGE_LETTERS.find(item => W2_RANGES[item].test(name));
    if (!letter) continue;
    // Hàm dùng chung do HAI gói cùng định nghĩa (vd. public.report_text_v1 của B và D) chỉ qua khi bản cuối nằm ở dải Z:
    // agent tích hợp đã đối chiếu và chốt một bản cho cả hai.
    const reconciled = fn => W2_RANGES.z.test((definedBy.get(fn) ?? []).at(-1) ?? '');
    const mine = fn => new RegExp(`^(public|app_private)\\.hermes_w2${letter}_[a-z0-9_]+$`).test(fn) ||
      /^public\.[a-z][a-z0-9_]*_v\d+$/.test(fn) && !/^public\.hermes_/.test(fn) &&
        ((definedBy.get(fn) ?? []).every(file => W2_RANGES[letter].test(file) || W2_RANGES.z.test(file)) || reconciled(fn));
    for (const fn of createdFunctions(sql)) if (!mine(fn)) violations.push(`${name}: ${fn}`);
    for (const fn of unqualifiedFunctions(sql)) violations.push(`${name}: ${fn} (thiếu schema)`);
    for (const { fn, action } of alteredFunctions(sql))
      if (!mine(fn) || !/^OWNER TO "?postgres"?$/i.test(action)) violations.push(`${name}: ALTER ${fn} ${action}`);
    if (dynamicBlocks(sql)) violations.push(`${name}: DO … EXECUTE`);
  }
  for (const fn of W2_FOUNDATION_FUNCTIONS) {
    const last = (definedBy.get(fn) ?? []).at(-1);
    if (!last) violations.push(`thiếu định nghĩa ${fn}`);
    else if (!W2_RANGES.foundation.test(last) && !W2_RANGES.z.test(last)) violations.push(`${fn}: định nghĩa cuối ở ${last}`);
  }
  return violations;
}
/** Mọi migration của repo (tên + nội dung) theo thứ tự tên. */
export const w2AllMigrations = (dir = W2_MIGRATION_DIR) => readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
  .map(name => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') }));
