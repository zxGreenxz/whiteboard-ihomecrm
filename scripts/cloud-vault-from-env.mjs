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
//   Chỉ nhận BIẾN MÔI TRƯỜNG thật. Network secrets của environment do proxy gắn vào
//   request, không có trong process.env, nên không dùng được làm đầu vào ở đây.
//
// CÁCH CHẠY
//   Hook SessionStart gọi script khi CLAUDE_CODE_REMOTE=true. Vault ghi vào
//   IHOMECRM_VAULT nếu có, mặc định ~/.ihomecrm/vault.md; có CLAUDE_ENV_FILE thì ghi
//   `export IHOMECRM_VAULT=…` vào đó để các lệnh sau dò được vault.
//
// AN TOÀN
//   - Chỉ in TÊN biến; không in giá trị.
//   - Không ghi vào trong repo; không ghi đè file không do script này tạo (thiếu dòng
//     đánh dấu ở đầu) — vault thật ở máy dev không bao giờ bị thay.
//   - Không ghi GH_TOKEN: harness cloud tự cấp token phiên, không đưa nó ra đĩa.
//   - Giá trị không khớp mẫu nhận dạng của hợp đồng thì không ghi và báo TÊN: một dòng
//     sai mẫu nằm trong vault là "có khóa" giả, script đọc vault vẫn hỏng.
//
// Thoát 0 vault đủ mọi biến đã khai · 1 có biến sai dạng/lệch mẫu hoặc không ghi được ·
// 3 environment chưa khai biến nào, không tạo vault.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './lib/vault.mjs';

export const DANH_DAU = '<!-- sinh tự động bởi scripts/cloud-vault-from-env.mjs — không sửa tay -->';

const HOP_DONG = JSON.parse(
  readFileSync(new URL('../tooling/local-credential-contract.json', import.meta.url), 'utf8'),
);
const MAU = new Map((HOP_DONG.credentials ?? []).map((c) => [c.name, c.detect]));

/** Biến đọc qua `^TEN=(\S+)$` ngoài hợp đồng (scripts/test-env/lib.mjs, edge.mjs). */
const BIEN_BO_SUNG = Object.freeze([
  'TEST_SUPABASE_REF',
  'TEST_SUPABASE_PAT',
  'TEST_SUPABASE_SECRET_KEY',
  'TEST_SUPABASE_PUBLISHABLE_KEY',
  'TEST_SUPABASE_POOLER_HOST',
  'OPENROUTER_API_KEY',
]);

/** Biến do harness cloud cấp — không bao giờ ghi ra vault. */
const BIEN_HARNESS = new Set(['GH_TOKEN']);

/** Mọi tên biến script này nhận, theo thứ tự ghi. */
export function danhSachBien(env = process.env) {
  const tuHopDong = (HOP_DONG.credentials ?? []).map((c) => c.name);
  const fleetThem = Object.keys(env).filter((k) => /^FLEET_PASS_[A-Z0-9_]+$/.test(k)).sort();
  return [...new Set([...tuHopDong, ...BIEN_BO_SUNG, ...fleetThem])].filter((t) => !BIEN_HARNESS.has(t));
}

const motDong = (v) => /^\S+$/.test(v);
const trongBacktick = (v) => !/[`\r\n]/.test(v);

/**
 * Dòng vault của một biến, hoặc null khi giá trị sai dạng cho định dạng của nó.
 * SUPABASE_DB_PASSWORD có cả dòng `TEN=` (db-query) lẫn mẫu "Persistent database password".
 */
function dongCua(ten, v) {
  switch (ten) {
    case 'TEST_ACCOUNT_EMAIL':
      return trongBacktick(v) ? [`- Email: \`${v}\``] : null;
    case 'TEST_ACCOUNT_PASSWORD':
      return trongBacktick(v) ? [`- Password: \`${v}\``] : null;
    case 'SUPABASE_DB_PASSWORD':
      if (!trongBacktick(v)) return null;
      return [...(motDong(v) ? [`SUPABASE_DB_PASSWORD=${v}`] : []), `- Persistent database password: \`${v}\``];
    case 'TEST_PASS': {
      // Nhiều cặp "email mật-khẩu", ngăn bằng `;` hoặc xuống dòng; một cặp hỏng là hỏng cả biến.
      const cap = v.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
      if (cap.length === 0 || !cap.every((s) => /^\S+@\S+ \S+$/.test(s))) return null;
      return cap.map((s) => `TEST_PASS ${s}`);
    }
    default:
      return motDong(v) ? [`${ten}=${v}`] : null;
  }
}

/**
 * Mẫu nhận dạng của hợp đồng có lấy lại ĐÚNG giá trị từ các dòng không. Mẫu có nhóm bắt
 * thì so nhóm; mẫu neo vào tên biến (`TEN=`, `TEST_PASS …`) chỉ cần khớp; còn lại (mẫu
 * token như `sbp_…`) phải khớp trọn giá trị — reader lấy đúng chuỗi khớp làm khóa.
 */
function khopMau(ten, dong, v) {
  const detect = MAU.get(ten);
  if (!detect) return true;
  const m = dong.join('\n').match(new RegExp(detect));
  if (!m) return false;
  if (m[1] !== undefined) return m[1] === v;
  if (m[0].startsWith(ten)) return true;
  return m[0] === v;
}

/**
 * Văn bản vault từ env. Trả `{ vanBan, co, thieu, saiDang }` — ba danh sách chỉ chứa TÊN.
 * `saiDang`: có giá trị nhưng không ghi được đúng định dạng hoặc lệch mẫu hợp đồng.
 */
export function dungVault(env = process.env) {
  const dau = [DANH_DAU, '', '# Vault phiên cloud (ghép từ biến môi trường environment)', ''];
  const than = [];
  const co = [];
  const thieu = [];
  const saiDang = [];
  // Tài khoản test đứng đầu: mẫu `Password:` khớp dòng đầu tiên chứa nó.
  const thuTu = ['TEST_ACCOUNT_EMAIL', 'TEST_ACCOUNT_PASSWORD', ...danhSachBien(env)];
  for (const ten of [...new Set(thuTu)]) {
    const v = env[ten]?.trim() ?? '';
    if (!v) {
      thieu.push(ten);
      continue;
    }
    const dong = dongCua(ten, v);
    if (!dong || !khopMau(ten, dong, v)) {
      saiDang.push(ten);
      continue;
    }
    than.push(...dong);
    co.push(ten);
  }
  return { vanBan: [...dau, ...than, ''].join('\n'), co, thieu, saiDang };
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

/** Chạy trọn một lượt; trả mã thoát. `log`/`loi` nhận từng dòng (chỉ TÊN, không giá trị). */
export function chay({ env = process.env, repoRoot = REPO_ROOT, home = homedir(), log = console.log, loi = console.error } = {}) {
  const { vanBan, co, thieu, saiDang } = dungVault(env);
  if (co.length === 0) {
    loi('cloud-vault: KHÔNG tạo vault — environment chưa có biến credential hợp lệ nào.');
    if (saiDang.length) loi(`  Sai dạng/lệch mẫu hợp đồng: ${saiDang.join(', ')}`);
    loi(`  Tên biến nhận: ${danhSachBien(env).join(', ')}`);
    loi('  Network secrets không vào process.env nên không dùng được ở đây; khai ở Environment variables.');
    return saiDang.length ? 1 : 3;
  }
  let dich;
  try {
    dich = duongDanDich({ env, repoRoot, home });
    ghiVault(dich, vanBan);
  } catch (e) {
    loi(`cloud-vault: KHÔNG ghi được vault — ${e.message}`);
    return 1;
  }
  const envFile = env.CLAUDE_ENV_FILE;
  if (envFile) appendFileSync(envFile, `export IHOMECRM_VAULT=${JSON.stringify(dich)}\n`);
  log(`cloud-vault: đã dựng vault ${dich} (quyền 600) với ${co.length} biến: ${co.join(', ')}.`);
  if (!envFile && env.IHOMECRM_VAULT?.trim() !== dich) {
    log(`  Không có CLAUDE_ENV_FILE: đặt IHOMECRM_VAULT=${dich} để script dò được vault.`);
  }
  if (thieu.length) log(`  Chưa khai (tuỳ việc mới cần): ${thieu.join(', ')}`);
  if (saiDang.length) {
    loi(`cloud-vault: ${saiDang.length} biến KHÔNG được ghi vì sai dạng hoặc lệch mẫu hợp đồng: ${saiDang.join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let ma;
  try {
    ma = chay();
  } catch (e) {
    console.error(`cloud-vault: lỗi không mong đợi — ${e?.message ?? e}`);
    ma = 1;
  }
  process.exitCode = ma;
}
