#!/usr/bin/env node
// Chạy một lệnh với credential từ vault nạp vào env của TIẾN TRÌNH CON.
//
//   npm run with-cred -- <lệnh> [đối số…]
//   npm run with-cred -- node scripts/check-view-invoker.mjs
//   npm run with-cred -- gh run list --limit 5
//
// VÌ SAO TỒN TẠI
//   Agent làm việc trong git worktree, còn vault chỉ ở checkout chính. Trước script này
//   mỗi phiên tự dựng wrapper tạm (with-vault.cjs, withgh.cjs…) hoặc dán token lên
//   dòng lệnh. Nay một lệnh nạp SUPABASE_PAT, SUPABASE_ACCESS_TOKEN (= PAT),
//   SUPABASE_DB_PASSWORD, GH_TOKEN, VERCEL_TOKEN qua scripts/lib/vault.mjs.
//
// AN TOÀN
//   - Giá trị chỉ vào env của tiến trình con; không in, không ghi file, không lên argv.
//   - Biến đã có trong env THẮNG vault (CI chỉ có env — hành vi không đổi).
//   - Thư mục làm việc giữ nguyên (gọi qua npm thì là thư mục đã gõ lệnh: INIT_CWD).
//   - Mã thoát của lệnh con được trả lại nguyên vẹn.
//   - Thiếu biến nào thì chỉ in TÊN ra stderr.
//
// GIỚI HẠN (Windows, lệnh là file .cmd/.bat như npm, npx)
//   File .cmd đọc lại `%*` thêm một lần, nên một đối số CHỨA nháy kép làm lệch trạng thái
//   nháy của các đối số sau nó; nếu sau đó có `&`/`|` thì cmd tách lệnh. Đối số có dấu
//   cách, `%`, `&`, `^` riêng lẻ đều qua đúng (có test). Cần chắc chắn thì gọi thẳng
//   `node <script>` thay vì qua shim .cmd.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { credentialChoTienTrinhCon } from './lib/vault.mjs';

// cmd.exe: ký tự đặc biệt phải thoát bằng `^` (cùng thuật toán với cross-spawn).
const KY_TU_DAC_BIET_CMD = /([()\][%!^"`<>&|;, *?])/g;

export function thoatLenhCmd(lenh) {
  return lenh.replace(KY_TU_DAC_BIET_CMD, '^$1');
}

/** Một đối số cho cmd.exe: bọc nháy theo quy tắc CommandLineToArgvW rồi thoát `^`. */
export function thoatDoiSoCmd(doiSo, thoatKep = false) {
  let s = String(doiSo);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(KY_TU_DAC_BIET_CMD, '^$1');
  if (thoatKep) s = s.replace(KY_TU_DAC_BIET_CMD, '^$1');
  return s;
}

function laFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Đường dẫn thật của lệnh theo PATH (+ PATHEXT trên Windows); null nếu không thấy. */
export function timLenh(lenh, { env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const coDuongDan = isAbsolute(lenh) || /[\\/]/.test(lenh);
  // Windows: tên không đuôi chỉ dò theo PATHEXT — thư mục nodejs có cả file `npm` (script
  // sh, không chạy được) cạnh `npm.cmd`; thử tên trần trước sẽ chọn nhầm file sh.
  const duoi = platform === 'win32'
    ? (extname(lenh) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  // Windows: tên biến PATH không phân biệt hoa thường (thường là `Path`).
  const khoaPath = platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const thuMuc = coDuongDan ? [''] : (env[khoaPath] ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const d of thuMuc) {
    const goc = d ? join(d, lenh) : resolve(cwd, lenh);
    for (const e of duoi) {
      const p = goc + e;
      if (laFile(p)) return p;
    }
  }
  return null;
}

/**
 * Cách gọi lệnh con. Windows: .exe/.com gọi thẳng; .cmd/.bat phải qua cmd.exe (Node
 * từ chối spawn .cmd khi shell:false) nên dựng dòng lệnh đã thoát ký tự, không dùng
 * `shell: true` (cách đó không bọc nháy đối số).
 */
export function dungLoiGoi(lenh, doiSo, { env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  if (platform !== 'win32') return { command: lenh, args: doiSo, options: {} };
  const thatSu = timLenh(lenh, { env, platform, cwd });
  if (!thatSu || !/\.(cmd|bat)$/i.test(thatSu)) return { command: thatSu ?? lenh, args: doiSo, options: {} };
  const thoatKep = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(thatSu);
  const dong = [thoatLenhCmd(lenh), ...doiSo.map((a) => thoatDoiSoCmd(a, thoatKep))].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${dong}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/** Thư mục làm việc của lệnh con: nơi người dùng gõ lệnh (npm đổi cwd về gốc package). */
export function thuMucLamViec(env = process.env, cwd = process.cwd()) {
  return env.npm_lifecycle_event === 'with-cred' && env.INIT_CWD && existsSync(env.INIT_CWD) ? env.INIT_CWD : cwd;
}

/** Mã thoát của tiến trình cha theo kết quả tiến trình con. */
export function maThoat(code, signal) {
  if (typeof code === 'number') return code;
  const so = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal];
  return so ? 128 + so : 1;
}

export function chay(argv, { env = process.env } = {}) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.error('Cách dùng: npm run with-cred -- <lệnh> [đối số…]');
    console.error('Nạp SUPABASE_PAT, SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, GH_TOKEN, VERCEL_TOKEN');
    console.error('từ vault vào env của lệnh con (biến đã có trong env được giữ nguyên).');
    return Promise.resolve(2);
  }
  const { them, thieu } = credentialChoTienTrinhCon({ env });
  if (thieu.length) console.error(`with-cred: không có trong env lẫn vault: ${thieu.join(', ')}`);
  const cwd = thuMucLamViec(env);
  const envCon = { ...env, ...them };
  const [lenh, ...doiSo] = argv;
  const { command, args, options } = dungLoiGoi(lenh, doiSo, { env, cwd });
  return new Promise((done) => {
    const con = spawn(command, args, { cwd, env: envCon, stdio: 'inherit', ...options });
    // Ctrl+C tới cả nhóm tiến trình: để lệnh con tự xử lý rồi trả mã của nó.
    const boQua = () => {};
    process.on('SIGINT', boQua);
    process.on('SIGTERM', boQua);
    con.on('error', (e) => {
      console.error(`with-cred: không chạy được "${lenh}": ${e.code ?? e.message}`);
      done(127);
    });
    con.on('close', (code, signal) => {
      process.off('SIGINT', boQua);
      process.off('SIGTERM', boQua);
      done(maThoat(code, signal));
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await chay(process.argv.slice(2));
}
