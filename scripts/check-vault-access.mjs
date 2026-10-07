#!/usr/bin/env node
// Gate: chỉ scripts/lib/vault.mjs được đọc vault credential `CLAUDE.local.md`.
//
// VÌ SAO GATE NÀY TỒN TẠI
//   Vault chỉ nằm ở CHECKOUT CHÍNH (Contract §9); git worktree không có bản sao. Tới
//   07/10/2026 có ~56 script tự đọc vault bằng đường dẫn tương đối
//   (`new URL('../CLAUDE.local.md', import.meta.url)`, `join(repoRoot, …)`,
//   `readFileSync('CLAUDE.local.md')`), nên chạy trong worktree là hỏng: gate sống báo
//   thiếu PAT và agent dựng lại wrapper tạm 19 lần trong 14 ngày. Helper dùng chung
//   dò được checkout chính; gate này giữ cho không ai viết lại đường đọc thẳng.
//
// QUY TẮC
//   Ngoài helper, mã không được chứa CHUỖI ĐƯỜNG DẪN tới vault: chuỗi/template kết thúc
//   bằng tên vault mà là chính tên đó, có dấu phân cách thư mục ngay trước, hoặc không
//   có khoảng trắng (xem `laDuongDanVault`). Câu thông báo ("… hoặc CLAUDE.local.md.")
//   không bị tính; cần TÊN vault cho việc khác đọc thì import `TEN_VAULT`.
//
// VÌ SAO BỎ CHÚ THÍCH THEO TỪNG DÒNG
//   `boChuThichJs` trên cả file coi `/*` trong chuỗi glob (`'**/*.ts'`) là mở chú thích
//   và nuốt mã tới `*/` kế tiếp — một lời đọc vault nằm trong đoạn bị nuốt sẽ lọt, tức
//   gate XANH GIẢ. Cắt từng dòng thì chỗ sai duy nhất có thể là dòng giữa một khối
//   `/* … */` nhiều dòng (không mở đầu bằng `*`) bị báo nhầm — ĐỎ nhìn thấy được.
//
//   docs/** nằm ngoài phạm vi: script trong docs/audits là bằng chứng đóng băng, không
//   phải công cụ đang chạy.
//
//   node scripts/check-vault-access.mjs
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';
import { TEN_VAULT } from './lib/vault.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Cửa đọc duy nhất và file khai kiểu của nó. */
export const MIEN_TRU = Object.freeze(['scripts/lib/vault.mjs', 'scripts/lib/vault.d.mts']);

/** Mã chạy được: JS/TS mọi biến thể module. */
export const DUOI_MA = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Ngoài phạm vi: tài liệu và bằng chứng audit đóng băng. */
export const NGOAI_PHAM_VI = /^docs\//;

/**
 * Sàn chống xanh rỗng: bộ liệt kê hỏng trả ít file thì "0 vi phạm" vô nghĩa.
 * Đo 07/10/2026: 3105 file mã ngoài docs/.
 */
export const SAN_SO_FILE = 1500;

const TEN = TEN_VAULT;

/**
 * Chuỗi trong một dòng, quét TUẦN TỰ từ trái sang (không dùng regex cặp dấu nháy —
 * regex dễ ghép nhầm dấu đóng của chuỗi này với dấu mở của chuỗi sau). Chuỗi chưa
 * đóng thì kéo tới cuối dòng.
 */
export function chuoiTrongDong(dong) {
  const ra = [];
  for (let i = 0; i < dong.length; i += 1) {
    const q = dong[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    let j = i + 1;
    let noiDung = '';
    while (j < dong.length && dong[j] !== q) {
      if (dong[j] === '\\' && j + 1 < dong.length) {
        noiDung += dong[j] + dong[j + 1];
        j += 2;
        continue;
      }
      noiDung += dong[j];
      j += 1;
    }
    ra.push(noiDung);
    i = j;
  }
  return ra;
}

/**
 * Chuỗi có phải ĐƯỜNG DẪN tới vault không: kết thúc bằng tên vault, và hoặc chỉ là
 * tên vault, hoặc ngay trước tên là dấu phân cách thư mục (bắt cả đường dẫn Windows
 * có dấu cách như `C:/Users/Ten Nguoi/…`), hoặc cả chuỗi không có khoảng trắng.
 * Câu thông báo "… hoặc CLAUDE.local.md" có dấu cách ngay trước tên ⇒ không tính.
 */
export function laDuongDanVault(noiDung) {
  if (!noiDung.endsWith(TEN)) return false;
  const truoc = noiDung.slice(0, -TEN.length);
  return truoc === '' || /[\\/]$/.test(truoc) || !/\s/.test(noiDung);
}

/** Các chuỗi đường dẫn vault trong một file mã, sau khi bỏ chú thích từng dòng. */
export function timDocVault(maNguon) {
  const ra = [];
  String(maNguon).split(/\r?\n/).forEach((dong, i) => {
    const sach = boChuThichJs(dong);
    if (!sach.includes(TEN)) return;
    for (const chuoi of chuoiTrongDong(sach)) if (laDuongDanVault(chuoi)) ra.push({ dong: i + 1, chuoi });
  });
  return ra;
}

/** File cần quét trong danh sách đường dẫn (dạng git, dấu `/`). */
export function chonFile(danhSach) {
  return danhSach.filter((f) => DUOI_MA.test(f) && !NGOAI_PHAM_VI.test(f) && !MIEN_TRU.includes(f));
}

function main() {
  let files;
  try {
    files = chonFile(
      execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1e8 })
        .split('\0')
        .filter(Boolean),
    );
  } catch (e) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC: không liệt kê được file — ${e.message}`);
    process.exit(3);
  }
  if (files.length < SAN_SO_FILE) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC: chỉ thấy ${files.length} file mã (sàn ${SAN_SO_FILE}) — bộ liệt kê hỏng.`);
    process.exit(3);
  }

  const viPham = [];
  for (const f of files) {
    let ma;
    try {
      ma = readFileSync(join(repoRoot, f), 'utf8');
    } catch {
      continue; // file bị xoá trong cây làm việc nhưng còn trong index
    }
    for (const v of timDocVault(ma)) viPham.push({ file: f, ...v });
  }

  if (viPham.length > 0) {
    console.error(`❌ ${viPham.length} chỗ đọc thẳng vault ngoài ${MIEN_TRU[0]}:\n`);
    for (const v of viPham) console.error(`  - ${v.file}:${v.dong}  ${JSON.stringify(v.chuoi)}`);
    console.error('\n  Vault chỉ nằm ở checkout chính; đường dẫn tương đối hỏng trong git worktree.');
    console.error(`  Dùng helper: import { layPat, layMatKhauDb, docVault, … } from '${MIEN_TRU[0]}'`);
    console.error('  (env trước, vault sau; CI không có vault nên hành vi chỉ-env giữ nguyên).');
    process.exit(1);
  }
  console.log(`✅ ${files.length} file mã: chỉ ${MIEN_TRU[0]} đọc vault.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
