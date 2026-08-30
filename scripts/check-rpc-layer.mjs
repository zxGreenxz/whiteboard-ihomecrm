#!/usr/bin/env node
// Gate: `supabase.rpc()` KHÔNG được gọi thẳng trong tầng giao diện.
//
// NGUYÊN TẮC NÀY ĐÃ ĐẠT — GATE ĐỂ NÓ KHÔNG TRÔI NGƯỢC
//   Đo 11/08/2026: 5 component/trang gọi `supabase.rpc()` thẳng, đã chuyển hết
//   vào `src/hooks/` (miễn trừ cuối cùng thuộc OpenClaw, gỡ 30/08/2026 khi xóa
//   OpenClaw khỏi repo).
//
//   Gate ra đời ở mức 0 vi phạm là CỐ Ý. Để nguyên tắc trôi lên vài chục chỗ rồi
//   mới dựng gate thì nó sẽ ra đời kèm một baseline miễn trừ dài — mà baseline
//   miễn trừ chính là thứ đã che 5 bug tên cột trong repo này suốt nhiều tháng.
//
// CHỈ QUÉT `.tsx`, VÀ ĐÓ LÀ PHẠM VI CHỨ KHÔNG PHẢI LỖ HỔNG
//   Nguyên tắc nói về COMPONENT. `src/copilot/tools/registry.ts` là một module
//   đăng ký công cụ, không phải component — nó nằm cùng hạng với `src/lib/`, nơi
//   lời gọi RPC vốn được phép. Quét cả `.ts` sẽ biến gate thành "cấm RPC ở mọi
//   file dưới ba thư mục này", một luật khác hẳn và không ai đồng ý.
//
// VÌ SAO TẦNG LẠI QUAN TRỌNG Ở ĐÂY
//   `supabase.rpc()` nhận TÊN HÀM là một CHUỖI. Mỗi chỗ gọi rải rác là một chỗ
//   gõ sai mà không trình biên dịch nào bắt. Gom về hook/lib thì:
//     - `check-rpc-surface` và `check-rpc-arg-names` có ít điểm phải soi hơn,
//       và mỗi điểm đều nằm trong tập file chúng quét;
//     - quyền sở hữu query key nằm cùng chỗ với lời gọi, nên việc vô hiệu hoá
//       cache không bị bỏ quên ở một component nào đó;
//     - component chỉ còn lo hiển thị, nên test giao diện không cần dựng mock
//       cho biên mạng.
//
//   node scripts/check-rpc-layer.mjs
//
// Không cần credential. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tầng giao diện — nơi KHÔNG được có lời gọi RPC thô. */
export const TANG_GIAO_DIEN = ['src/components', 'src/pages', 'src/copilot'];

/** Dưới ngần này file trong tầng giao diện thì phép quét hỏng, không phải sạch. */
export const SAN_SO_FILE = 300;

/**
 * Danh sách miễn trừ CỐ Ý ngắn (hiện RỖNG): mỗi dòng thêm vào là một chỗ
 * nguyên tắc không còn đúng, nên phải đắt để thêm — kèm lý do đo được.
 */
export const MIEN_TRU = [];

export function timLoiGoi(vanBan) {
  // Bỏ chú thích trước: một dòng `// đừng gọi supabase.rpc(...) ở đây` là VĂN
  // KỂ LẠI VỀ MÃ, không phải mã. Repo này đã dính đúng lỗi đó bốn lần.
  const sach = boChuThichJs(vanBan);
  return [...sach.matchAll(/\bsupabase\s*\.\s*rpc\s*\(\s*['"]([a-z0-9_]+)['"]/gi)].map((m) => m[1]);
}

function lietKe(thuMuc) {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__') continue;
        di(p);
      } else if (/\.tsx$/.test(e.name)) ra.push(p);
    }
  };
  di(thuMuc);
  return ra;
}

function main() {
  const files = [];
  for (const t of TANG_GIAO_DIEN) {
    const d = join(repoRoot, t);
    if (!existsSync(d)) {
      console.error(`❌ KHÔNG ĐO ĐƯỢC: thiếu thư mục ${t} — cấu trúc repo đã đổi.`);
      process.exit(3);
    }
    files.push(...lietKe(d));
  }
  if (files.length < SAN_SO_FILE) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${files.length} file giao diện (sàn ${SAN_SO_FILE}).`);
    console.error('   Bộ liệt kê hỏng — đừng đọc thành "tầng giao diện đã sạch".');
    process.exit(3);
  }

  const van = [];
  for (const f of files) {
    const rel = relative(repoRoot, f).replace(/\\/g, '/');
    if (MIEN_TRU.includes(rel)) continue;
    const ten = timLoiGoi(readFileSync(f, 'utf8'));
    if (ten.length) van.push({ rel, ten });
  }

  console.log(`Quét ${files.length} file ở ${TANG_GIAO_DIEN.join(' · ')} · miễn trừ ${MIEN_TRU.length}.`);

  if (van.length > 0) {
    console.error(`\n❌ ${van.length} file gọi supabase.rpc() thẳng trong tầng giao diện:\n`);
    for (const v of van) console.error(`  - ${v.rel} → ${[...new Set(v.ten)].join(', ')}`);
    console.error('\n  Chuyển lời gọi vào src/hooks/ hoặc src/lib/: tên RPC là một CHUỖI, và mỗi');
    console.error('  chỗ gọi rải rác là một chỗ gõ sai mà không trình biên dịch nào bắt.');
    process.exitCode = 1;
    return;
  }

  console.log('✅ Không lời gọi RPC thô nào trong tầng giao diện.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
