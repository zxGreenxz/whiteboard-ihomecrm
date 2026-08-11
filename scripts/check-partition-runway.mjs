#!/usr/bin/env node
// Gate: bảng phân mảnh theo ngày phải còn ĐỦ PARTITION PHÍA TRƯỚC.
//
// VÌ SAO CẦN
//   `network_device_samples` và `network_interface_samples` phân mảnh theo NGÀY.
//   Partition được tạo trước bằng `app_private.network_center_ensure_raw_partitions_v1`.
//   Nếu không ai gọi hàm đó, partition mới nhất sẽ lùi dần về hôm nay — và đúng
//   ngày nó tụt lại phía sau, MỌI INSERT telemetry đều lỗi
//   (`no partition of relation ... found for row`).
//
//   Hỏng theo kiểu tệ: nó không hỏng dần. Hôm nay chạy tốt, ngày mai chết sạch,
//   và thời điểm chết là một ngày trong tương lai mà không ai có lịch để nhớ.
//
//   Đo 11/08/2026: 46 partition mỗi bảng, phủ 28/07 → 11/09, tức còn 31 ngày.
//
// SÀN 7 NGÀY, VÀ VÌ SAO KHÔNG CAO HƠN
//   Hàm tạo partition chặn khoảng quá 63 ngày, nên trần là 63. Sàn 7 cho một tuần
//   để phản ứng — đủ để một lượt chạy định kỳ hằng ngày bắt được và còn thời gian
//   xử. Đặt sàn sát mức hiện tại (31) sẽ đỏ ngay khi ai đó tạo ít hơn thường lệ,
//   dù chưa có rủi ro gì.
//
//   node scripts/check-partition-runway.mjs
//
// CHỈ ĐỌC pg_catalog. Thoát 0 · 1 khi hết dự phòng · 3 khi KHÔNG HỎI ĐƯỢC.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPat, readProjectRef } from './capture-production-catalog.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
void repoRoot;

/** Số ngày dự phòng tối thiểu phía trước. */
export const SAN_NGAY = 7;

/** Bảng cha bắt buộc phải có mặt — vắng nghĩa là phép đo hỏng, không phải "sạch". */
export const BANG_BAT_BUOC = ['network_device_samples', 'network_interface_samples'];

/** `..._20260911` → Date(2026-09-11). Trả null nếu tên không mang ngày. */
export function ngayTuTenPartition(ten) {
  const m = /_(\d{4})(\d{2})(\d{2})$/.exec(ten);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Số ngày từ `moc` tới ngày muộn nhất trong danh sách partition. */
export function duPhong(tenPartitions, moc) {
  const ngay = tenPartitions.map(ngayTuTenPartition).filter(Boolean);
  if (ngay.length === 0) return null;
  const muon = new Date(Math.max(...ngay.map((d) => d.getTime())));
  const som = new Date(Math.min(...ngay.map((d) => d.getTime())));
  return {
    som,
    muon,
    ngayPhiaTruoc: Math.floor((muon - moc) / 86_400_000),
    ngayGiuLai: Math.floor((moc - som) / 86_400_000),
    so: ngay.length,
  };
}

const SQL = `
SELECT parent.relname AS cha, child.relname AS con
FROM pg_inherits i
JOIN pg_class child  ON child.oid  = i.inhrelid
JOIN pg_class parent ON parent.oid = i.inhparent
JOIN pg_namespace n  ON n.oid = parent.relnamespace
WHERE n.nspname = 'public' AND parent.relkind = 'p'
`;

async function main() {
  const pat = readPat();
  if (!pat) {
    console.error('❌ KHÔNG HỎI ĐƯỢC: thiếu SUPABASE_PAT (hoặc CLAUDE.local.md).');
    console.error('   "Không hỏi được catalog" KHÁC "còn đủ partition".');
    process.exit(3);
  }
  const ref = readProjectRef();

  let rows;
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: SQL }),
    });
    if (!res.ok) throw new Error(`Management API ${res.status}`);
    rows = JSON.parse(await res.text());
  } catch (error) {
    console.error(`❌ KHÔNG HỎI ĐƯỢC: ${error.message}`);
    process.exit(3);
  }

  const theoBang = new Map();
  for (const r of rows) {
    if (!theoBang.has(r.cha)) theoBang.set(r.cha, []);
    theoBang.get(r.cha).push(r.con);
  }

  const thieuBang = BANG_BAT_BUOC.filter((b) => !theoBang.has(b));
  if (thieuBang.length > 0) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: không thấy bảng phân mảnh ${thieuBang.join(', ')}.`);
    console.error('   Truy vấn hỏng hoặc bảng đã đổi tên — đừng đọc thành "không có gì để canh".');
    process.exit(3);
  }

  const homNay = new Date();
  homNay.setUTCHours(0, 0, 0, 0);
  const van = [];

  for (const bang of BANG_BAT_BUOC) {
    const d = duPhong(theoBang.get(bang), homNay);
    if (!d) {
      van.push(`${bang}: không partition nào mang ngày trong tên — bộ đọc tên hỏng.`);
      continue;
    }
    console.log(
      `${bang}: ${d.so} partition · giữ lại ${d.ngayGiuLai} ngày · còn ${d.ngayPhiaTruoc} ngày phía trước`,
    );
    if (d.ngayPhiaTruoc < SAN_NGAY) {
      van.push(
        `${bang}: chỉ còn ${d.ngayPhiaTruoc} ngày dự phòng (sàn ${SAN_NGAY}). ` +
        'Khi hết, MỌI insert telemetry sẽ lỗi cùng lúc — gọi ' +
        'app_private.network_center_ensure_raw_partitions_v1 để tạo thêm.',
      );
    }
  }

  if (van.length > 0) {
    console.error(`\n❌ ${van.length} bảng sắp hết partition:\n`);
    for (const v of van) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${BANG_BAT_BUOC.length} bảng phân mảnh đều còn ≥ ${SAN_NGAY} ngày dự phòng.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
