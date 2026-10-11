#!/usr/bin/env node
// Dựng vault cho phiên Claude Code CLOUD từ biến môi trường của environment.
//
//   node scripts/cloud-vault-from-env.mjs
//
// VÌ SAO TỒN TẠI
//   Container cloud clone repo mới mỗi phiên, nên không có vault gitignore (Contract §9).
//   Đa số script đọc env trước, nhưng một số chỉ đọc vault theo mẫu của
//   tooling/local-credential-contract.json (capture-schema-baseline, reconcile-money,
//   check-local-agent-credentials…). Script này ghép các biến người dùng khai ở cài
//   đặt environment thành một vault đúng mẫu, đặt NGOÀI repo, để mọi script chạy như
//   ở máy dev mà không phải sửa từng script.
//
// CÁCH CHẠY
//   Hook SessionStart trong .claude/settings.json gọi script khi CLAUDE_CODE_REMOTE=true.
//   Vault ghi vào IHOMECRM_VAULT nếu có, mặc định ~/.ihomecrm/vault.md; hook ghi
//   `export IHOMECRM_VAULT=…` vào CLAUDE_ENV_FILE để các lệnh sau dò được nó.
//
// AN TOÀN
//   - Chỉ in TÊN biến; không in giá trị.
//   - Không ghi vào trong repo; không ghi đè file không do script này tạo (thiếu dòng
//     đánh dấu ở đầu) — vault thật ở máy dev không bao giờ bị thay.
//   - Không ghi GH_TOKEN: harness cloud tự cấp token phiên, không đưa nó ra đĩa.
//   - Lỗi nào cũng thoát 0 kèm thông báo: hook không được chặn phiên khởi động.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './lib/vault.mjs';

export const DANH_DAU = '<!-- sinh tự động bởi scripts/cloud-vault-from-env.mjs — không sửa tay -->';

const HOP_DONG = JSON.parse(
  readFileSync(new URL('../tooling/local-credential-contract.json', import.meta.url), 'utf8'),
);

/** Biến đọc qua `^TEN=(\S+)$` ngoài hợp đồng (scripts/test-env/lib.mjs, edge.mjs). */
const BIEN_BO_SUNG = Object.freeze([
  'TEST_SUPABASE_REF',
  'TEST_SUPABASE_PAT',
  'TEST_SUPABASE_SECRET_KEY',
  'TEST_SUPABASE_PUBLISHABLE_KEY',
  'TEST_SUPABASE_POOLER_HOST',
  'OPENROUTER_API_KEY',
]);

/** Biến có định dạng riêng trong vault (không phải `TEN=giá trị`) hoặc không được ghi. */
const BIEN_DINH_DANG_RIENG = new Set(['TEST_ACCOUNT_EMAIL', 'TEST_ACCOUNT_PASSWORD', 'TEST_PASS', 'GH_TOKEN']);

const motDong = (v) => typeof v === 'string' && /^\S+$/.test(v.trim());
const trongBacktick = (v) => typeof v === 'string' && v.trim() !== '' && !/[`\r\n]/.test(v.trim());

/** Mọi tên biến script này đọc, theo thứ tự ghi. */
export function danhSachBien(env = process.env) {
  const tuHopDong = (HOP_DONG.credentials ?? []).map((c) => c.name);
  const fleetThem = Object.keys(env).filter((k) => /^FLEET_PASS_[A-Z0-9_]+$/.test(k)).sort();
  return [...new Set([...tuHopDong, ...BIEN_BO_SUNG, ...fleetThem])];
}

/**
 * Văn bản vault từ env. Trả `{ vanBan, co, thieu, boQua }` — `co`/`thieu`/`boQua` chỉ
 * chứa TÊN; `boQua` là biến có giá trị nhưng sai dạng (khoảng trắng, xuống dòng, backtick).
 */
export function dungVault(env = process.env) {
  const dong = [DANH_DAU, '', '# Vault phiên cloud (ghép từ biến môi trường environment)', ''];
  const co = [];
  const thieu = [];
  const boQua = [];
  const lay = (ten) => env[ten]?.trim() ?? '';

  // Tài khoản test — mẫu `Email: \`…\`` / `Password: \`…\`` của hợp đồng.
  for (const [ten, nhan] of [['TEST_ACCOUNT_EMAIL', 'Email'], ['TEST_ACCOUNT_PASSWORD', 'Password']]) {
    const v = lay(ten);
    if (!v) thieu.push(ten);
    else if (!trongBacktick(v)) boQua.push(ten);
    else {
      dong.push(`- ${nhan}: \`${v}\``);
      co.push(ten);
    }
  }

  // Mật khẩu pooler: cả dòng `TEN=` (db-query) lẫn mẫu "Persistent database password".
  const mkDb = lay('SUPABASE_DB_PASSWORD');
  if (mkDb && trongBacktick(mkDb)) dong.push(`- Persistent database password: \`${mkDb}\``);

  // TEST_PASS: nhiều cặp "email mật-khẩu", ngăn bằng `;` hoặc xuống dòng.
  const testPass = lay('TEST_PASS');
  if (!testPass) thieu.push('TEST_PASS');
  else {
    const cap = testPass.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
    const hopLe = cap.filter((s) => /^\S+@\S+ \S+$/.test(s));
    if (hopLe.length === 0 || hopLe.length !== cap.length) boQua.push('TEST_PASS');
    if (hopLe.length > 0) {
      for (const s of hopLe) dong.push(`TEST_PASS ${s}`);
      co.push('TEST_PASS');
    }
  }

  dong.push('');
  for (const ten of danhSachBien(env)) {
    if (BIEN_DINH_DANG_RIENG.has(ten)) continue;
    const v = lay(ten);
    if (!v) thieu.push(ten);
    else if (!motDong(v)) boQua.push(ten);
    else {
      dong.push(`${ten}=${v}`);
      co.push(ten);
    }
  }
  dong.push('');
  return { vanBan: dong.join('\n'), co, thieu, boQua };
}

/** Đường dẫn đích: IHOMECRM_VAULT hoặc ~/.ihomecrm/vault.md. Ném nếu nằm trong repo. */
export function duongDanDich({ env = process.env, repoRoot = REPO_ROOT, home = homedir() } = {}) {
  const p = resolve(env.IHOMECRM_VAULT?.trim() || join(home, '.ihomecrm', 'vault.md'));
  const r = relative(resolve(repoRoot), p);
  if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) {
    throw new Error('Đích vault nằm trong repo — từ chối ghi (dễ bị commit nhầm).');
  }
  return p;
}

/** Ghi vault; từ chối đè file không mang dòng đánh dấu. */
export function ghiVault(dich, vanBan) {
  if (existsSync(dich) && !readFileSync(dich, 'utf8').startsWith(DANH_DAU)) {
    throw new Error(`${dich} đã có và không do script này tạo — không ghi đè.`);
  }
  mkdirSync(dirname(dich), { recursive: true, mode: 0o700 });
  writeFileSync(dich, vanBan, { encoding: 'utf8', mode: 0o600 });
  chmodSync(dich, 0o600);
}

function main() {
  const { vanBan, co, thieu, boQua } = dungVault();
  if (co.length === 0) {
    console.log('cloud-vault: environment chưa khai credential nào — bỏ qua, không tạo vault.');
    console.log(`  Tên biến nhận: ${danhSachBien().filter((t) => t !== 'GH_TOKEN').join(', ')}`);
    return;
  }
  let dich;
  try {
    dich = duongDanDich();
    ghiVault(dich, vanBan);
  } catch (e) {
    console.log(`cloud-vault: ${e.message}`);
    return;
  }
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) appendFileSync(envFile, `export IHOMECRM_VAULT=${JSON.stringify(dich)}\n`);
  console.log(`cloud-vault: đã dựng vault ${dich} (${co.length} biến: ${co.join(', ')}).`);
  if (!envFile && !process.env.IHOMECRM_VAULT) {
    console.log('  Không có CLAUDE_ENV_FILE: đặt IHOMECRM_VAULT trỏ tới file trên để script dò được vault.');
  }
  if (boQua.length) console.log(`  Bỏ qua vì sai dạng (khoảng trắng/xuống dòng/backtick): ${boQua.join(', ')}`);
  if (thieu.length) console.log(`  Chưa khai: ${thieu.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.log(`cloud-vault: lỗi không mong đợi — ${e?.message ?? e}`);
  }
}
