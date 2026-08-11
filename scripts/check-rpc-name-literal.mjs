#!/usr/bin/env node
// Gate: TÊN RPC phải là chuỗi viết thẳng ngay tại chỗ gọi — và nếu không được
// thì phải đếm được, chứ không im lặng.
//
// KHOẢNG MÙ NÀY LÀ CỦA CHÍNH BỘ GATE
//   Ba gate canh biên RPC (`check-rpc-surface`, `check-rpc-arg-names`,
//   `check-rpc-layer`) đều tìm `\.rpc\(['"]<tên>['"]` bằng văn bản. Khi tên đi
//   qua một biến — `supabase.rpc(fn, args)`, `rpc(PROFIT_CLOSE_RPC.state, …)`,
//   `rpc(accrual ? "a" : "b", …)` — thì KHÔNG gate nào thấy lời gọi đó, và RPC
//   ấy cũng không có trong `contracts/surfaces/rpc-surface.json`.
//
//   Hệ quả đo được 12/08/2026: 31/270 lời gọi (11,5%) vô hình. Trong đó có cả
//   năm RPC `profit_close_*_v2` — nhóm chốt lợi nhuận, tức đường tiền. Ba gate
//   kia vẫn in "✅ 230 RPC" mà không hề nói rằng chúng không nhìn thấy 31 cái.
//   Một gate báo xanh trên tập nó không quét hết, mà không khai ra, là đúng thứ
//   repo này gọi là "xanh rỗng".
//
//   Gate này KHÔNG cấm hẳn — cấm hẳn thì phải viết lại 31 chỗ trong một lát, và
//   vài mẫu trong đó là hợp lý (wrapper nhận `fn: string` để gom xử lý lỗi).
//   Nó ĐẾM và KHOÁ: không được sinh thêm chỗ mù mới.
//
// TẠI SAO KHOÁ THEO TẬP VÂN TAY, KHÔNG THEO SỐ
//   Đếm số thì gỡ một chỗ mù và thêm một chỗ mù khác sẽ hoà, trong khi vùng
//   không được canh đã dịch sang chỗ khác. Vân tay là `<file>::<biểu thức>`.
//
//   node scripts/check-rpc-name-literal.mjs
//   node scripts/check-rpc-name-literal.mjs --write   # chốt lại baseline
//
// Không cần credential. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_BASELINE = join(repoRoot, 'tooling', 'rpc-name-literal-baseline.json');

/** Dưới ngần này lời gọi đọc được thì bộ dò hỏng, không phải repo hết RPC. */
export const SAN_LOI_GOI = 150;

/**
 * Tách mọi lời gọi `.rpc(` thành hai nhóm: tên VIẾT THẲNG và tên ẨN.
 *
 * Bỏ chú thích trước khi quét — một dòng giải thích nhắc `.rpc(fn)` không phải
 * một lời gọi, và repo này đã bốn lần dính lỗi "gate đọc văn kể lại về mã".
 */
export function tachLoiGoi(vanBan) {
  const s = boChuThichJs(vanBan);
  const vietThang = [];
  const an = [];
  for (const m of s.matchAll(/\.rpc\(\s*([^,)]{1,120})/g)) {
    const doi = m[1].trim();
    if (/^['"`]/.test(doi)) vietThang.push(doi.replace(/^['"`]|['"`]$/g, ''));
    else an.push(doi.replace(/\s+/g, ' '));
  }
  return { vietThang, an };
}

/**
 * Biểu thức nào GIẢI ĐƯỢC thành tên thật? Hai mẫu đáng gỡ vì chúng che tên mà
 * không đổi lại được gì:
 *   - ternary của hai chuỗi:      `accrual ? "a" : "b"`
 *   - tra hằng viết thẳng:        `PROFIT_CLOSE_RPC.state`
 * Wrapper nhận `fn: string` thì KHÔNG giải được — đó là lựa chọn thiết kế, chỉ
 * cần đếm.
 */
export function giaiDuoc(bieuThuc) {
  const ternary = /^[^?]+\?\s*['"]([a-z0-9_]+)['"]\s*:\s*['"]([a-z0-9_]+)['"]$/i.exec(bieuThuc);
  if (ternary) return { kieu: 'ternary', ten: [ternary[1], ternary[2]] };
  if (/^[A-Z][A-Z0-9_]*\.[a-zA-Z0-9_]+$/.test(bieuThuc)) return { kieu: 'hang', ten: [] };
  return null;
}

function lietKe(thuMuc) {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) di(p);
      else if (/\.(ts|tsx)$/.test(e.name)) ra.push(p);
    }
  };
  di(thuMuc);
  return ra;
}

function main() {
  const ghi = process.argv.includes('--write');
  const files = lietKe(join(repoRoot, 'src'));

  let soVietThang = 0;
  const hienTai = [];
  const giaiDuocDs = [];
  for (const f of files) {
    const rel = relative(repoRoot, f).replace(/\\/g, '/');
    const { vietThang, an } = tachLoiGoi(readFileSync(f, 'utf8'));
    soVietThang += vietThang.length;
    for (const bt of an) {
      const vt = `${rel}::${bt}`;
      hienTai.push(vt);
      const g = giaiDuoc(bt);
      if (g) giaiDuocDs.push({ vt, ...g });
    }
  }

  const tong = soVietThang + hienTai.length;
  if (tong < SAN_LOI_GOI) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${tong} lời gọi .rpc() (sàn ${SAN_LOI_GOI}).`);
    console.error('   Bộ dò hỏng hoặc cách gọi đã đổi — đừng đọc thành "không còn chỗ mù".');
    process.exit(3);
  }

  const tyLe = ((hienTai.length / tong) * 100).toFixed(1);
  console.log(
    `Lời gọi .rpc(): ${soVietThang} tên viết thẳng · ${hienTai.length} tên ẩn (${tyLe}%).\n` +
    `  ${hienTai.length} lời gọi này VÔ HÌNH với check-rpc-surface, check-rpc-arg-names và check-rpc-layer.`,
  );
  if (giaiDuocDs.length) {
    console.log(`\n  ${giaiDuocDs.length} chỗ GIẢI ĐƯỢC thành tên thật — nên viết thẳng để ba gate kia thấy:`);
    for (const g of giaiDuocDs) console.log(`     [${g.kieu}] ${g.vt}`);
  }

  if (ghi) {
    writeFileSync(
      FILE_BASELINE,
      JSON.stringify(
        {
          $comment:
            'Vân tay <file>::<biểu thức> của những lời gọi .rpc() có tên KHÔNG viết thẳng — tức vô hình với ba gate RPC. Khoá theo TẬP, không theo số đếm: đếm số thì gỡ một chỗ mù và thêm một chỗ mù khác sẽ hoà, trong khi vùng không được canh đã dịch đi. Xem đầu scripts/check-rpc-name-literal.mjs.',
          choMu: hienTai.sort(),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\n✅ Đã chốt ${hienTai.length} vân tay vào ${FILE_BASELINE}`);
    return;
  }

  if (!existsSync(FILE_BASELINE)) {
    console.error(`\n❌ KHÔNG ĐO ĐƯỢC: thiếu ${FILE_BASELINE}. Chạy với --write để tạo.`);
    process.exit(3);
  }
  let baseline;
  try {
    const doc = JSON.parse(readFileSync(FILE_BASELINE, 'utf8'));
    baseline = doc.choMu;
    if (!Array.isArray(baseline)) throw new Error('thiếu mảng `choMu`');
  } catch (e) {
    console.error(`\n❌ KHÔNG ĐO ĐƯỢC: baseline hỏng — ${e.message}`);
    process.exit(3);
  }

  const moi = hienTai.filter((v) => !baseline.includes(v));
  const daGo = baseline.filter((v) => !hienTai.includes(v));

  if (moi.length > 0) {
    console.error(`\n❌ ${moi.length} chỗ mù MỚI:\n`);
    for (const v of moi) console.error(`  - ${v}`);
    console.error('\n  Viết thẳng tên RPC thành chuỗi ngay tại chỗ gọi để ba gate kia thấy nó.');
    console.error('  Nếu buộc phải giấu tên sau biến, chạy --write và giải trình trong commit.');
    process.exitCode = 1;
    return;
  }
  if (daGo.length > 0) {
    console.log(`\n🎉 ${daGo.length} chỗ mù đã được gỡ — chạy --write để chốt mức thấp hơn:`);
    for (const v of daGo) console.log(`  - ${v}`);
  }
  console.log('\n✅ Không có chỗ mù mới.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
