#!/usr/bin/env node
// Ratchet: caller ở tier RỦI RO CAO không được thêm lời gọi RPC/Edge thô mới.
//
// HAI LOẠI, KHÔNG PHẢI MỘT — và bản đầu của gate này nói SAI về loại thứ hai
//
//   Bản đầu viết: "`supabase.rpc("slug", {...})` không có gì kiểm slug đó tồn tại,
//   kiểm tham số đúng tên". Đo thật 12/08/2026 (file thử trong `src/`, chạy
//   `tsc -p tsconfig.app.json`) cho thấy câu đó SAI với slug viết thẳng:
//     supabase.rpc("khong_ton_tai_v9", {})
//       → TS2345, và thông báo liệt kê đủ 648 tên hợp lệ
//     supabase.rpc("profit_close_state_v2", { p_sai_ten: "x" })
//       → TS2353 "'p_sai_ten' does not exist in type
//          '{ p_organization_id: string; p_period_month: string; }'"
//   Kiểu sinh tự động ĐÃ canh cả tên hàm lẫn tên tham số cho dạng literal.
//
//   Tiền đề đó chỉ đúng với hai dạng còn lại:
//     `rpc-dynamic`  slug nằm sau một biến — TypeScript mù hoàn toàn, và không
//                    grep ra được, không đổi tên an toàn được.
//     `edge-invoke`  Edge function không có kiểu sinh tự động nào cả.
//
// VÌ SAO PHÂN BIỆT LẠI QUAN TRỌNG
//   Bản đầu khuyên "chuyển sang wrapper typed (xem paymentRecordRpc.ts)". Đã thử
//   thật cho sáu RPC chốt lợi nhuận và kết quả là BƯỚC LÙI: wrapper nhận invoker
//   qua tham số nên trong file không còn `.rpc(`, mà `check-rpc-surface` và
//   `check-rpc-name-literal` tìm chỗ gọi bằng đúng chuỗi đó — tên RPC tàng hình
//   trở lại với manifest bề mặt. Kiểm chứng: `record_invoice_collection_v5` của
//   chính `paymentRecordRpc.ts` KHÔNG có trong `contracts/surfaces/rpc-surface.json`.
//   Tức lời khuyên cũ đánh đổi TẦM NHÌN để lấy một thứ (kiểu) vốn đã có sẵn.
//
//   Wrapper vẫn đúng khi nó thêm thứ trình biên dịch không làm được: chuẩn hoá
//   idempotency key, bất biến tiền, kế hoạch phân bổ — đó là lý do thật của
//   `paymentRecordRpc`. Nó KHÔNG đúng khi lý do duy nhất là "cho có kiểu".
//
// CẢ HAI LOẠI VẪN BỊ RATCHET NHƯ CŨ
//   Lát này KHÔNG nới cưỡng chế: thêm vân tay mới thuộc loại nào cũng exit 1.
//   Thứ đổi là gate không còn nói sai lý do, và báo cáo tách hai nhóm để nhóm
//   nguy hiểm thật (mù kiểu) không bị chìm giữa nhóm đã được canh.
//
// KHÔNG PHẢI "CẤM RAW RPC" — mà là "không thêm nữa ở chỗ đắt nhất"
//   Đo 11/08/2026: 238 lời gọi thô trên toàn src/, trong đó 100 nằm ở 24 file
//   thuộc tier đòi soi chéo (money · authorization · migration · infrastructure).
//   Cấm sạch là bất khả thi trong một lát; ratchet thì thi hành được ngay.
//
// SO TẬP VÂN TAY, KHÔNG SO SỐ ĐẾM
//   Số đếm cho phép xoá một lời gọi rồi thêm một lời gọi khác trong cùng một lát
//   mà không ai thấy. Vân tay là `<file>::<slug>`.
//
//   node scripts/check-raw-rpc-callers.mjs
//   node scripts/check-raw-rpc-callers.mjs --write   # chốt lại baseline
//
// Thoát 0 · 1 khi có vân tay mới · 3 khi KHÔNG ĐO ĐƯỢC.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xepTier } from './check-risk-classifier.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const RISK_MAP = join(repoRoot, 'tooling', 'risk-map.json');
const BASELINE = join(repoRoot, 'tooling', 'raw-rpc-callers-baseline.json');

/**
 * Bốn dạng lời gọi thô, khai tường minh vì mỗi dạng hỏng một kiểu khác nhau.
 *
 * Dạng `DYNAMIC` (slug là biến) đáng lo nhất: không grep ra được, không đổi tên
 * an toàn được, và không công cụ nào biết nó gọi cái gì. Nó vẫn vào baseline như
 * mọi thứ khác — mục đích của lát này là chặn TĂNG, không phải xử nợ cũ.
 */
const MAU = [
  { ten: 'rpc-literal', re: /\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g, lay: (m) => m[1] },
  { ten: 'edge-invoke', re: /functions\.invoke\(\s*["'`]([a-zA-Z0-9_-]+)["'`]/g, lay: (m) => `edge:${m[1]}` },
  { ten: 'rpc-dynamic', re: /\.rpc\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g, lay: (m) => `DYNAMIC:${m[1]}` },
];

/**
 * Xếp một vân tay vào loại.
 *
 * `khong-kiem-duoc` = trình biên dịch KHÔNG canh được (slug sau biến, hoặc Edge
 * function không có kiểu sinh tự động). `literal` = đã được canh tên hàm + tên
 * tham số, phần còn thiếu là tầng kiểm hợp lệ lúc chạy chứ không phải kiểu.
 */
export function phanLoai(vanTay) {
  const slug = vanTay.slice(vanTay.indexOf('::') + 2);
  if (slug.startsWith('DYNAMIC:') || slug.startsWith('edge:')) return 'khong-kiem-duoc';
  return 'literal';
}

export function vanTayCuaNguon(duong, nguon) {
  const out = new Set();
  for (const { re, lay } of MAU) {
    for (const m of nguon.matchAll(new RegExp(re.source, re.flags))) {
      out.add(`${duong}::${lay(m)}`);
    }
  }
  return out;
}

/** File nguồn thuộc tier đòi soi chéo. Đây là định nghĩa "rủi ro cao" của repo. */
export function fileRuiRoCao(files, tiers) {
  const cao = new Set(Object.entries(tiers).filter(([, t]) => t.crossReview === true).map(([k]) => k));
  return files.filter((p) => cao.has(xepTier(p, tiers)));
}

function main(argv) {
  const { tiers } = JSON.parse(readFileSync(RISK_MAP, 'utf8'));
  const caoTier = Object.values(tiers).filter((t) => t.crossReview === true).length;
  if (caoTier === 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: risk-map không còn tier nào đòi soi chéo.');
    console.error('   Không có định nghĩa "rủi ro cao" thì ratchet này không có phạm vi — đừng đọc thành "sạch".');
    process.exit(3);
  }

  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((p) => /^src\/.*\.tsx?$/.test(p));
  } catch (error) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC danh sách file: ${error.message}`);
    process.exit(3);
  }
  if (tracked.length < 500) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${tracked.length} file src (repo có hơn 1.200). Phép quét hỏng.`);
    process.exit(3);
  }

  const hr = fileRuiRoCao(tracked, tiers);
  if (hr.length < 50) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ ${hr.length} file rơi vào tier rủi ro cao (đo 11/08/2026: 121).`);
    console.error('   Nhiều khả năng risk-map bị thu hẹp — ratchet sẽ xanh vì không còn gì để canh.');
    process.exit(3);
  }

  const hienTai = new Set();
  for (const p of hr) {
    for (const v of vanTayCuaNguon(p, readFileSync(join(repoRoot, p), 'utf8'))) hienTai.add(v);
  }

  if (argv.includes('--write')) {
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          $comment:
            'Vân tay `<file>::<slug>` của mọi lời gọi RPC/Edge THÔ trong file thuộc tier đòi soi chéo. Danh sách CHỈ ĐƯỢC TEO. Hai loại, đóng theo hai cách khác nhau: `DYNAMIC:` và `edge:` là loại trình biên dịch KHÔNG canh được — đóng bằng cách viết thẳng slug ra chuỗi. Loại literal đã được kiểu sinh tự động canh tên hàm + tên tham số — đóng bằng cách bỏ hẳn lời gọi, KHÔNG phải bọc vào wrapper nhận invoker (làm vậy thì tên RPC biến mất khỏi manifest bề mặt; xem đầu scripts/check-raw-rpc-callers.mjs).',
          generatedBy: 'node scripts/check-raw-rpc-callers.mjs --write',
          fingerprints: [...hienTai].sort(),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Đã chốt baseline: ${hienTai.size} vân tay trên ${hr.length} file rủi ro cao.`);
    return;
  }

  let baseline;
  try {
    baseline = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).fingerprints);
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC baseline: ${error.message}`);
    console.error('   Thiếu baseline thì mọi lời gọi đều "mới" — chạy --write một lần để chốt hiện trạng.');
    process.exit(3);
  }

  const moi = [...hienTai].filter((v) => !baseline.has(v)).sort();
  const daXoa = [...baseline].filter((v) => !hienTai.has(v)).sort();

  const moiMu = moi.filter((v) => phanLoai(v) === 'khong-kiem-duoc');
  const moiLiteral = moi.filter((v) => phanLoai(v) === 'literal');

  if (moi.length > 0) {
    console.error(`❌ ${moi.length} lời gọi RPC/Edge THÔ mới ở file thuộc tier đòi soi chéo`);
    console.error('   (tiền · phân quyền · migration · hạ tầng).\n');

    if (moiMu.length > 0) {
      console.error(`  ${moiMu.length} cái TRÌNH BIÊN DỊCH KHÔNG CANH ĐƯỢC — nhóm đắt nhất:`);
      for (const v of moiMu) console.error(`   - ${v}`);
      console.error('    Slug nằm sau biến, hoặc là Edge function (không có kiểu sinh tự động).');
      console.error('    Đổi tên trong migration thì TypeScript im lặng, lỗi chỉ hiện lúc chạy.');
      console.error('    → viết thẳng slug ra chuỗi. Đó là cách duy nhất để cả trình biên dịch');
      console.error('      lẫn ba gate bề mặt nhìn thấy nó.\n');
    }

    if (moiLiteral.length > 0) {
      console.error(`  ${moiLiteral.length} cái là slug VIẾT THẲNG:`);
      for (const v of moiLiteral) console.error(`   - ${v}`);
      console.error('    Tên hàm và tên tham số đã được kiểu sinh tự động canh (TS2345 / TS2353),');
      console.error('    nên đây KHÔNG phải lỗ hổng kiểu. Cái ratchet muốn hỏi là: đường tiền này');
      console.error('    có cần tầng kiểm hợp lệ lúc chạy không (idempotency key, bất biến tiền)?');
      console.error('    → nếu CÓ: đặt phần kiểm đó vào lib và GIỮ NGUYÊN lời gọi literal tại chỗ.');
      console.error('      ĐỪNG bọc lời gọi vào wrapper nhận invoker: làm vậy thì trong file không');
      console.error('      còn `.rpc(`, và tên RPC biến mất khỏi manifest bề mặt.');
      console.error('    → nếu KHÔNG: `--write` KÈM lý do trong commit message.\n');
    }

    process.exitCode = 1;
    return;
  }

  const soMu = [...hienTai].filter((v) => phanLoai(v) === 'khong-kiem-duoc').length;
  console.log(
    `✅ ${hienTai.size} lời gọi thô trên ${hr.length} file rủi ro cao ` +
      `(${soMu} không canh được bằng kiểu · ${hienTai.size - soMu} literal), không có cái nào mới.`,
  );
  if (daXoa.length > 0) {
    console.log(`\n🎉 ${daXoa.length} lời gọi đã được gỡ — chạy --write để hạ baseline:`);
    for (const v of daXoa.slice(0, 10)) console.log(`   - ${v}`);
    if (daXoa.length > 10) console.log(`   … còn ${daXoa.length - 10}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
