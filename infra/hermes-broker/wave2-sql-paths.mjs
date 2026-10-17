// Đợt 2: chuỗi migration theo DẢI TIMESTAMP cấp trước cho từng gói (Gói 0, 18/10/2026) — các gói
// thêm file trong dải của mình mà không sửa file này, khỏi đổi tên khi rebase. Thứ tự áp = thứ tự tên.
//   nền (Gói 0)  20261018000000_hermes_w2_foundation_v1.sql
//   Gói A        2026101801xxxx_hermes_w2a_<slug>.sql   (đề xuất 20261018010000_hermes_w2a_receivables_read_v1)
//   Gói B        2026101802xxxx_hermes_w2b_<slug>.sql   (đề xuất 20261018020000_hermes_w2b_cashbook_read_v1)
//   Gói C        2026101803xxxx_hermes_w2c_<slug>.sql   (đề xuất 20261018030000_hermes_w2c_ops_read_v1)
//   Gói D        2026101804xxxx_hermes_w2d_<slug>.sql   (đề xuất 20261018040000_hermes_w2d_catalog_read_v1)
//   Gói Z        2026101809xxxx_hermes_w2_<slug>.sql    (đề xuất 20261018090000_hermes_w2_enable_v1)
// Sửa sau review trong cùng gói: timestamp kế tiếp trong dải (vd. 20261018010100_hermes_w2a_review_fixes_v1).
import { readdirSync } from 'node:fs';

export const W2_MIGRATION_DIR = 'supabase/migrations';
export const W2_FOUNDATION_FILE = '20261018000000_hermes_w2_foundation_v1.sql';
export const W2_FOUNDATION_PATH = `${W2_MIGRATION_DIR}/${W2_FOUNDATION_FILE}`;
export const W2_RANGES = Object.freeze({
  a: /^2026101801\d{4}_hermes_w2a_[a-z0-9_]+\.sql$/,
  b: /^2026101802\d{4}_hermes_w2b_[a-z0-9_]+\.sql$/,
  c: /^2026101803\d{4}_hermes_w2c_[a-z0-9_]+\.sql$/,
  d: /^2026101804\d{4}_hermes_w2d_[a-z0-9_]+\.sql$/,
  z: /^2026101809\d{4}_hermes_w2_[a-z0-9_]+\.sql$/,
});

/** Đường dẫn migration đợt 2 theo thứ tự áp: nền rồi các gói được chọn (mặc định mọi gói + Z). */
export function w2MigrationPaths({ packages = Object.keys(W2_RANGES), dir = W2_MIGRATION_DIR } = {}) {
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  if (!files.includes(W2_FOUNDATION_FILE)) throw new Error(`missing ${W2_FOUNDATION_FILE}`);
  const picked = files.filter(name => packages.some(letter => W2_RANGES[letter]?.test(name)));
  return [W2_FOUNDATION_FILE, ...picked].map(name => `${dir}/${name}`);
}
