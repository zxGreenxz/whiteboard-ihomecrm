// Cửa DUY NHẤT để script đọc vault credential `CLAUDE.local.md` (Contract §9).
//
// VÌ SAO CÓ FILE NÀY
//   Vault chỉ nằm ở CHECKOUT CHÍNH và bị gitignore — git worktree không có bản sao.
//   Trước file này ~56 script tự đọc vault bằng đường dẫn tương đối
//   (`new URL('../CLAUDE.local.md', import.meta.url)`, `join(repoRoot, …)`,
//   `readFileSync('CLAUDE.local.md')`), nên chạy từ worktree là hỏng: gate sống báo
//   "thiếu PAT", agent dựng lại wrapper tạm (with-vault.cjs, withgh.cjs…) phiên này
//   qua phiên khác. Chỉ `scripts/test-env/lib.mjs` biết dò ngược về checkout chính.
//   Nay mọi script đi qua đây; `scripts/check-vault-access.mjs` chặn đường đọc thẳng.
//
// THỨ TỰ DÒ (dừng ở file đọc được đầu tiên)
//   1. `IHOMECRM_VAULT` — đường dẫn tường minh (máy khác, thử nghiệm).
//   2. `<repoRoot>/CLAUDE.local.md` — chạy ở checkout chính.
//   3. Checkout chính của worktree: thư mục cha của `git rev-parse --git-common-dir`.
//   (`IHOMECRM_SECRET_FILE` của harness V5 chỉ được loadSupabaseAdminConfig nhận, KHÔNG ở
//   đây: duongDanVault còn là đích GHI của test-env, không được trỏ sang file khác.)
//   CI không có vault: mọi hàm trả rỗng/null và giá trị phải đến từ biến môi trường.
//
// AN TOÀN
//   Không hàm nào in giá trị. Mẫu nhận dạng lấy từ tooling/local-credential-contract.json
//   (cùng nguồn với preflight `gate:local-credentials`) — đổi mẫu ở đó, không ở đây.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEN_VAULT = 'CLAUDE.local.md';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOP_DONG = JSON.parse(
  readFileSync(new URL('../../tooling/local-credential-contract.json', import.meta.url), 'utf8'),
);

/** Mẫu nhận dạng của một credential theo hợp đồng. Thiếu entry là lỗi lập trình ⇒ ném. */
export function mauNhanDang(ten) {
  const entry = (HOP_DONG.credentials ?? []).find((c) => c.name === ten);
  if (!entry?.detect) throw new Error(`local-credential-contract.json không có mẫu nhận dạng cho ${ten}`);
  return new RegExp(entry.detect);
}

const _thuMucChung = new Map();
function checkoutChinh(repoRoot) {
  if (_thuMucChung.has(repoRoot)) return _thuMucChung.get(repoRoot);
  let ketQua = null;
  try {
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) ketQua = dirname(common);
  } catch { /* không phải git checkout (thư mục tạm của test, bản tải về) */ }
  _thuMucChung.set(repoRoot, ketQua);
  return ketQua;
}

/** Các đường dẫn vault theo thứ tự ưu tiên, đã bỏ trùng. */
export function ungVienVault({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const ds = [];
  if (env.IHOMECRM_VAULT) ds.push(resolve(env.IHOMECRM_VAULT));
  ds.push(join(repoRoot, TEN_VAULT));
  const chinh = checkoutChinh(repoRoot);
  if (chinh) ds.push(join(chinh, TEN_VAULT));
  return [...new Set(ds)];
}

/** Đường dẫn vault đang tồn tại, hoặc null (CI, máy chưa cấu hình). */
export function duongDanVault(opts = {}) {
  return ungVienVault(opts).find((p) => existsSync(p)) ?? null;
}

const _boNho = new Map();

/**
 * Nội dung vault, hoặc '' khi không có. `readFile` thay được để test giả lập —
 * khi đó không dùng bộ nhớ đệm.
 */
export function docVault({ readFile, ...opts } = {}) {
  const ungVien = ungVienVault(opts);
  const khoa = ungVien.join('\n');
  if (!readFile && _boNho.has(khoa)) return _boNho.get(khoa);
  const doc = readFile ?? readFileSync;
  let vanBan = '';
  for (const p of ungVien) {
    try {
      vanBan = String(doc(p, 'utf8') ?? '');
      break;
    } catch { /* thử ứng viên kế */ }
  }
  if (!readFile) _boNho.set(khoa, vanBan);
  return vanBan;
}

/** Quên bộ nhớ đệm — sau khi chính tiến trình này vừa ghi thêm vào vault. */
export function quenVault() {
  _boNho.clear();
}

/** Nhóm bắt đầu tiên (hoặc cả chuỗi khớp) của `mau` trong vault; null nếu không thấy. */
export function timTrongVault(mau, opts = {}) {
  const m = docVault(opts).match(mau);
  return m ? (m[1] ?? m[0]) : null;
}

/** Giá trị của dòng `TEN=giá trị` trong vault. */
export function giaTriVault(ten, opts = {}) {
  const tenAnToan = ten.replace(/[^A-Za-z0-9_]/g, '');
  return timTrongVault(new RegExp(`^${tenAnToan}=(\\S+)\\s*$`, 'm'), opts);
}

function tuEnv(env, bien) {
  for (const ten of bien) {
    const v = env[ten]?.trim();
    if (v) return v;
  }
  return null;
}

/** PAT Management API CHỈ từ vault (mẫu SUPABASE_PAT của hợp đồng). */
export function docPatVault(opts = {}) {
  return timTrongVault(mauNhanDang('SUPABASE_PAT'), opts);
}

/**
 * PAT: biến môi trường trước (theo thứ tự `bien`), rồi vault. CI chỉ có env.
 * Mặc định SUPABASE_PAT rồi SUPABASE_ACCESS_TOKEN; call site nào chỉ nhận một biến
 * thì truyền `bien` của nó để giữ nguyên thứ tự cũ.
 */
export function layPat({ env = process.env, bien = ['SUPABASE_PAT', 'SUPABASE_ACCESS_TOKEN'], ...opts } = {}) {
  return tuEnv(env, bien) ?? docPatVault({ env, ...opts });
}

/** Mật khẩu pooler production trong một văn bản vault (mẫu của hợp đồng). */
export function docMatKhauPooler(vanBan) {
  const m = String(vanBan ?? '').match(mauNhanDang('SUPABASE_DB_PASSWORD'));
  return m ? (m[1] ?? null) : null;
}

/** Mật khẩu pooler production: env SUPABASE_DB_PASSWORD trước, rồi vault. */
export function layMatKhauDb({ env = process.env, ...opts } = {}) {
  return tuEnv(env, ['SUPABASE_DB_PASSWORD']) ?? docMatKhauPooler(docVault({ env, ...opts }));
}

/** Tài khoản test đăng nhập thật (RLS + JWT) — CHỈ từ vault; call site tự xét env trước. */
export function docTaiKhoanTest(opts = {}) {
  return {
    email: timTrongVault(mauNhanDang('TEST_ACCOUNT_EMAIL'), opts)?.trim() || null,
    password: timTrongVault(mauNhanDang('TEST_ACCOUNT_PASSWORD'), opts)?.trim() || null,
  };
}

/** Các biến `with-cred` nạp cho tiến trình con. */
export const BIEN_TIEN_TRINH_CON = Object.freeze([
  'SUPABASE_PAT', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'GH_TOKEN', 'VERCEL_TOKEN',
]);

/**
 * Biến env đã "có sẵn" theo nghĩa của công cụ đọc nó: `gh` dùng GITHUB_TOKEN khi không
 * có GH_TOKEN, nên nạp GH_TOKEN từ vault lúc đó là ĐÈ lựa chọn của người gọi.
 */
const TUONG_DUONG = { GH_TOKEN: ['GH_TOKEN', 'GITHUB_TOKEN'] };

/**
 * Credential cần THÊM vào env tiến trình con: chỉ biến env hiện tại chưa có (env thắng,
 * xét TỪNG TÊN). SUPABASE_PAT chỉ lấy từ chính nó rồi vault — không mượn
 * SUPABASE_ACCESS_TOKEN (có thể là token của project khác), vì các script đọc
 * SUPABASE_PAT phải nhận cùng giá trị như khi chạy trực tiếp. SUPABASE_ACCESS_TOKEN
 * theo thứ tự của Supabase CLI wrapper: chính nó → SUPABASE_PAT → vault.
 * Trả `{ them, thieu }` — `them` chứa giá trị (chỉ đưa vào env con, không in), `thieu`
 * chỉ có TÊN biến không tìm thấy ở đâu cả.
 */
export function credentialChoTienTrinhCon({ env = process.env, ...opts } = {}) {
  const coSan = (ten) => Boolean(tuEnv(env, TUONG_DUONG[ten] ?? [ten]));
  let vault;
  const tuVault = (mau) => {
    vault ??= docVault({ env, ...opts });
    const m = vault.match(mau);
    return m ? (m[1] ?? m[0]) : null;
  };
  const nguon = {
    SUPABASE_PAT: () => tuVault(mauNhanDang('SUPABASE_PAT')),
    SUPABASE_ACCESS_TOKEN: () => tuEnv(env, ['SUPABASE_PAT']) ?? tuVault(mauNhanDang('SUPABASE_PAT')),
    SUPABASE_DB_PASSWORD: () => tuVault(mauNhanDang('SUPABASE_DB_PASSWORD')),
    GH_TOKEN: () => tuVault(mauNhanDang('GH_TOKEN')),
    VERCEL_TOKEN: () => tuVault(mauNhanDang('VERCEL_TOKEN')),
  };
  const them = {};
  const thieu = [];
  for (const ten of BIEN_TIEN_TRINH_CON) {
    if (coSan(ten)) continue;
    const giaTri = nguon[ten]();
    if (giaTri) them[ten] = giaTri;
    else thieu.push(ten);
  }
  return { them, thieu };
}
