#!/usr/bin/env node
// Gate: client KHÔNG được INSERT/UPDATE/DELETE thẳng vào các bảng TIỀN.
//
// VÌ SAO CÓ GATE NÀY — nó ra đời từ một lỗi đã sống 35 ngày trên production.
//   23/07/2026, migration 20260723070000 REVOKE INSERT/UPDATE/DELETE của
//   `authenticated` trên `income_expenses`/`income_expense_items`: từ đó mọi
//   đường ghi hợp lệ phải đi qua RPC SECURITY DEFINER. Chính header migration
//   đó liệt kê các caller phải dọn — nhưng `useStopRecurring` trong
//   `src/hooks/income-expenses/recurring.ts` bị bỏ sót.
//
//   Hậu quả không nổ lúc deploy mà nổ lúc NGƯỜI DÙNG BẤM NÚT: PostgREST trả
//   403 `permission denied for table income_expenses` (SQLSTATE 42501). Không
//   test nào đỏ, không gate nào đỏ, TypeScript không có gì để nói — vì lời gọi
//   hoàn toàn hợp lệ về kiểu. Thứ đã đổi nằm ở tầng GRANT của database, và
//   không có thứ gì trong repo canh hai đầu cho khớp. Đo 27/08/2026, người
//   dùng báo nút "Dừng lặp lại" hỏng.
//
//   Đây chính là lớp lỗi mà một phép quét tĩnh bắt được trong một giây.
//
// RATCHET, KHÔNG PHẢI MỨC 0 — và lý do phải nói thẳng.
//   Đo lúc dựng gate: 5 vi phạm còn lại đều nằm trong `useManagerSalary.ts`,
//   thuộc lát lương V5 mà phiên khác đang sửa. Chốt baseline ở 5 để con số chỉ
//   được PHÉP GIẢM. Baseline không phải lời tha bổng: mỗi dòng trong đó là một
//   nút bấm sẽ trả 403 nếu nhánh ấy còn sống.
//
//   node scripts/check-money-table-dml.mjs
//   node scripts/check-money-table-dml.mjs --list    # in chi tiết từng chỗ
//   node scripts/check-money-table-dml.mjs --write   # chốt mức mới (chỉ khi GIẢM)
//
// Không cần credential, không đọc database. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';


const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(repoRoot, 'tooling', 'money-table-dml-baseline.json');

/**
 * Bảng đã bị REVOKE DML khỏi `authenticated`/`anon`. Nguồn sự thật là hai
 * migration 20260723070000 (income_expenses + _items) và 20260730102000
 * (accounts, cash_handovers, cash_handover_items, cashbook_reconciliations).
 * Thêm bảng vào đây khi có REVOKE mới — danh sách CỐ Ý viết tay chứ không đọc
 * database, vì gate phải chạy được trong CI không credential.
 */
export const BANG_TIEN = [
  'income_expenses',
  'income_expense_items',
  'accounts',
  'cash_handovers',
  'cash_handover_items',
  'cashbook_reconciliations',
];

/** Dưới ngần này file trong src/ thì phép quét hỏng, không phải repo sạch. */
export const SAN_SO_FILE = 400;

const RE_FROM = new RegExp(String.raw`\.from\(\s*['"](${BANG_TIEN.join('|')})['"]\s*\)`, 'g');
const RE_DML = /\.\s*(insert|update|delete|upsert)\s*\(/;
const RE_KHOI_CHU_THICH = new RegExp(String.raw`/\*[\s\S]*?\*/`, 'g');
const RE_DONG_CHU_THICH = new RegExp(String.raw`^\s*(//|\*)`);

/**
 * Một lời gọi `.from("<bảng tiền>")` bị tính là vi phạm khi trong CÙNG một câu
 * lệnh (tới dấu `;` đầu tiên) có `.insert(`/`.update(`/`.delete(`/`.upsert(`.
 * Cắt ở `;` là cố ý: nó giữ phép đo trong đúng chuỗi builder đó, nên một
 * `.select()` ở câu này và một `.update()` ở câu sau không dính vào nhau.
 */
export function boChuThichGiuDong(vanBan) {
  // Cùng phép cắt với scripts/lib/bo-chu-thich.mjs, khác một điểm: dòng chú
  // thích bị làm RỖNG chứ không bị XOÁ. Gate này in số dòng cho người đọc đi
  // sửa, nên đánh rơi dòng là chỉ sai chỗ — bản dùng chung `boChuThichJs` báo
  // recurring.ts:11 trong khi lời gọi nằm ở dòng 15.
  const xuongDong = String.fromCharCode(10);
  const khoiThanhKhoangTrang = (khoi) =>
    khoi.split(xuongDong).map((d) => ' '.repeat(d.length)).join(xuongDong);
  return vanBan
    .replace(RE_KHOI_CHU_THICH, khoiThanhKhoangTrang)
    .split(/\r?\n/)
    .map((d) => (RE_DONG_CHU_THICH.test(d) ? '' : d))
    .join(xuongDong);
}

export function timGhiThang(vanBan) {
  // Bỏ chú thích trước: một dòng `// đừng .update() bảng này` là VĂN KỂ LẠI VỀ
  // MÃ, không phải mã.
  const sach = boChuThichGiuDong(vanBan);
  const ra = [];
  for (const m of sach.matchAll(RE_FROM)) {
    const cauLenh = sach.slice(m.index + m[0].length, m.index + m[0].length + 400).split(';')[0];
    const dml = RE_DML.exec(cauLenh);
    if (dml) ra.push({ bang: m[1], phepGhi: dml[1], dong: sach.slice(0, m.index).split('\n').length });
  }
  return ra;
}

function lietKe(thuMuc) {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__') continue;
        di(p);
      } else if (/\.tsx?$/.test(e.name)) ra.push(p);
    }
  };
  di(thuMuc);
  return ra;
}

export function quet() {
  const goc = join(repoRoot, 'src');
  if (!existsSync(goc)) return { loi: 'thiếu thư mục src/' };
  const files = lietKe(goc);
  if (files.length < SAN_SO_FILE) return { loi: `chỉ thấy ${files.length} file (sàn ${SAN_SO_FILE})`, files };
  const viPham = [];
  for (const f of files) {
    const rel = relative(repoRoot, f).replaceAll(String.fromCharCode(92), '/');
    for (const v of timGhiThang(readFileSync(f, 'utf8'))) viPham.push({ file: rel, ...v });
  }
  viPham.sort((a, b) => a.file.localeCompare(b.file) || a.dong - b.dong);
  return { files, viPham };
}

function main() {
  const argv = process.argv.slice(2);
  const { loi, files, viPham } = quet();
  if (loi) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: ${loi} — cấu trúc repo đã đổi.`);
    console.error('   Đừng đọc thành "không còn ghi thẳng bảng tiền".');
    process.exit(3);
  }

  const moc = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).soViPham : 0;
  console.log(`Quét ${files.length} file src/ · ${BANG_TIEN.length} bảng tiền · thấy ${viPham.length} chỗ ghi thẳng (mốc ${moc}).`);

  if (argv.includes('--list') || viPham.length > moc) {
    for (const v of viPham) console.error(`  - ${v.file}:${v.dong} → .from("${v.bang}").${v.phepGhi}()`);
  }

  if (argv.includes('--write')) {
    if (existsSync(BASELINE) && viPham.length > moc) {
      console.error(`\n❌ --write chỉ chốt mức GIẢM: ${viPham.length} > ${moc}.`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(BASELINE, `${JSON.stringify({ soViPham: viPham.length, chiTiet: viPham }, null, 2)}\n`, 'utf8');
    console.log(`✅ Đã chốt mốc mới: ${viPham.length}.`);
    return;
  }

  if (viPham.length > moc) {
    console.error(`\n❌ Thêm ${viPham.length - moc} chỗ ghi thẳng vào bảng tiền so với mốc ${moc}.`);
    console.error('\n  `authenticated` chỉ còn SELECT trên các bảng này — PostgREST sẽ trả 403');
    console.error('  "permission denied for table ..." NGAY LÚC NGƯỜI DÙNG BẤM, không phải lúc build.');
    console.error('  Đường ghi hợp lệ là RPC SECURITY DEFINER (xem 20260723070000 · 20260730102000).');
    process.exitCode = 1;
    return;
  }

  if (viPham.length < moc) {
    console.log(`✅ Giảm còn ${viPham.length} — chạy \`--write\` để chốt mốc mới.`);
    return;
  }
  console.log('✅ Không phát sinh chỗ ghi thẳng nào ngoài mốc.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
