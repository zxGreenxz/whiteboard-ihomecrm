// Đợt 2: chuỗi migration theo DẢI TIMESTAMP cấp trước cho từng gói (Gói 0, 18/10/2026) — các gói
// thêm file trong dải của mình mà không sửa file này, khỏi đổi tên khi rebase. Thứ tự áp = thứ tự tên.
//   nền (Gói 0)  2026101800xxxx_hermes_w2_<slug>.sql    (20261018000000_hermes_w2_foundation_v1, 000500 _fixes_v1,
//                                                       000600 _invoker_gate_v1)
//   Gói A        2026101801xxxx_hermes_w2a_<slug>.sql   (đề xuất 20261018010000_hermes_w2a_receivables_read_v1)
//   Gói B        2026101802xxxx_hermes_w2b_<slug>.sql   (đề xuất 20261018020000_hermes_w2b_cashbook_read_v1)
//   Gói C        2026101803xxxx_hermes_w2c_<slug>.sql   (đề xuất 20261018030000_hermes_w2c_ops_read_v1)
//   Gói D        2026101804xxxx_hermes_w2d_<slug>.sql   (đề xuất 20261018040000_hermes_w2d_catalog_read_v1)
//   Gói Z        2026101809xxxx_hermes_w2_<slug>.sql    (đề xuất 20261018090000_hermes_w2_enable_v1)
// Sửa sau review trong cùng gói: timestamp kế tiếp trong dải (vd. 20261018010100_hermes_w2a_review_fixes_v1).
// KHÔNG dùng scripts/tao-ten-migration.mjs cho các file này (nó cấp giờ thực, ra ngoài dải).
import { readdirSync, readFileSync } from 'node:fs';

export const W2_MIGRATION_DIR = 'supabase/migrations';
export const W2_FOUNDATION_FILE = '20261018000000_hermes_w2_foundation_v1.sql';
export const W2_FOUNDATION_PATH = `${W2_MIGRATION_DIR}/${W2_FOUNDATION_FILE}`;
export const W2_FIXES_FILE = '20261018000500_hermes_w2_foundation_fixes_v1.sql';
export const W2_FIXES_PATH = `${W2_MIGRATION_DIR}/${W2_FIXES_FILE}`;
// Cổng INVOKER + RLS: lối vào public.hermes_w2_read_v1, bước kiểm quyền/bước kết thúc DEFINER, hàm gói INVOKER.
export const W2_INVOKER_FILE = '20261018000600_hermes_w2_invoker_gate_v1.sql';
export const W2_INVOKER_PATH = `${W2_MIGRATION_DIR}/${W2_INVOKER_FILE}`;
export const W2_RANGES = Object.freeze({
  foundation: /^2026101800\d{4}_hermes_w2_[a-z0-9_]+\.sql$/,
  a: /^2026101801\d{4}_hermes_w2a_[a-z0-9_]+\.sql$/,
  b: /^2026101802\d{4}_hermes_w2b_[a-z0-9_]+\.sql$/,
  c: /^2026101803\d{4}_hermes_w2c_[a-z0-9_]+\.sql$/,
  d: /^2026101804\d{4}_hermes_w2d_[a-z0-9_]+\.sql$/,
  z: /^2026101809\d{4}_hermes_w2_[a-z0-9_]+\.sql$/,
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
  'app_private.hermes_w2_scope_v1', 'app_private.hermes_w2_finish_v1', 'public.hermes_w2_read_v1']);
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
const createdFunctions = sql => [...stripComments(sql).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+)\.([a-z0-9_]+)\s*\(/gi)]
  .map(match => `${match[1].toLowerCase()}.${match[2].toLowerCase()}`);

/** Hàng rào gói (P2-4, review PR #195). files: [{name, sql}] mọi migration theo thứ tự tên. Trả danh sách vi phạm:
 * file trong dải gói <x> chỉ được tạo/thay hermes_w2<x>_* (public hoặc app_private) hoặc hàm dùng chung MỚI
 * public.<miền>_*_v<n> (không bắt đầu bằng hermes_, chưa có ở file nào khác); định nghĩa cuối của hàm nền phải
 * nằm ở dải nền hoặc Z. */
export function w2FenceViolations(files) {
  const violations = [], definedBy = new Map();
  for (const { name, sql } of files) for (const fn of createdFunctions(sql)) definedBy.set(fn, [...(definedBy.get(fn) ?? []), name]);
  for (const { name, sql } of files) {
    const letter = W2_PACKAGE_LETTERS.find(item => W2_RANGES[item].test(name));
    if (!letter) continue;
    for (const fn of createdFunctions(sql)) {
      const own = new RegExp(`^(public|app_private)\\.hermes_w2${letter}_[a-z0-9_]+$`).test(fn);
      const shared = /^public\.[a-z][a-z0-9_]*_v\d+$/.test(fn) && !/^public\.hermes_/.test(fn) &&
        (definedBy.get(fn) ?? []).every(file => file === name);
      if (!own && !shared) violations.push(`${name}: ${fn}`);
    }
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
