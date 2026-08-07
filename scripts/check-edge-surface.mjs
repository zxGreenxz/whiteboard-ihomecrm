#!/usr/bin/env node
// Gate cho contracts/surfaces/edge-function-surface.json.
//
// ĐỎ khi:
//   (1) mã client gọi `functions.invoke('slug')` mà slug đó KHÔNG đang chạy —
//       404 lúc chạy, không gì bắt được lúc biên dịch;
//   (2) có bản ACTIVE trên server mà repo KHÔNG còn mã nguồn — mã đang chạy trên
//       dữ liệu thật mà không ai đọc được nữa, cũng không ai sửa được;
//   (3) manifest trôi khỏi thực tế.
//
// CHỈ BÁO (không đỏ):
//   - thư mục có mã mà chưa deploy. Đây là trạng thái HỢP LỆ và đang có thật:
//     network-watchdog, openclaw-watchdog. Bắt đỏ sẽ ép người ta deploy thứ chưa
//     sẵn sàng, hoặc xoá mã đang viết dở — cả hai đều tệ hơn việc biết mà chờ.
//     Nó chỉ thành lỗi khi CÓ AI GỌI, và trường hợp đó rơi vào (1).
//   - verify_jwt = false. Đó là lựa chọn thiết kế cho webhook/cron, nhưng phải
//     NHÌN THẤY ĐƯỢC: nó nghĩa là bất kỳ ai trên Internet cũng gọi được.
//
//   node scripts/check-edge-surface.mjs
//
// Cần SUPABASE_PAT. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pat } from "./generate-rpc-surface.mjs";
import {
  DUONG_DAN_EDGE,
  dungManifestEdge,
  hoiDaDeploy,
  lietKeFileEdge,
  thuMucFunction,
  timInvoke,
} from "./generate-edge-surface.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sàn chống rỗng. Nếu readdirSync trỏ sai chỗ hoặc Management API trả mảng rỗng,
 * mọi phép so đều thoả và gate in dấu tick. Hệ này CHẮC CHẮN có hàng chục hàm.
 */
export const TOI_THIEU_THU_MUC = 8;
export const TOI_THIEU_DEPLOY = 5;

export function soManifestEdge(cu, moi) {
  const lech = [];
  const a = cu.functions ?? {};
  const b = moi.functions ?? {};
  for (const s of Object.keys(b)) if (!(s in a)) lech.push(`+ slug mới: ${s}`);
  for (const s of Object.keys(a)) if (!(s in b)) lech.push(`- slug biến mất: ${s}`);
  for (const s of Object.keys(b).filter((x) => x in a)) {
    for (const k of ["hasSource", "deployed", "status", "verifyJwt"]) {
      if (JSON.stringify(a[s][k]) !== JSON.stringify(b[s][k])) {
        lech.push(`~ ${s}.${k}: ${JSON.stringify(a[s][k])} → ${JSON.stringify(b[s][k])}`);
      }
    }
    if (JSON.stringify(a[s].callers) !== JSON.stringify(b[s].callers)) lech.push(`~ ${s}: nơi gọi đã đổi`);
  }
  return lech;
}

async function main() {
  if (!pat()) {
    console.error("=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===");
    console.error("  Thiếu SUPABASE_PAT (env) hoặc CLAUDE.local.md.");
    process.exit(3);
  }
  let cu;
  try {
    cu = JSON.parse(readFileSync(join(repoRoot, DUONG_DAN_EDGE), "utf8"));
  } catch (e) {
    console.error(`❌ Không đọc được ${DUONG_DAN_EDGE}: ${e.message}`);
    console.error("   Sinh lần đầu: node scripts/generate-edge-surface.mjs");
    process.exit(3);
  }

  const doc = (f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8");
    } catch {
      return null;
    }
  };
  const thuMuc = thuMucFunction();
  const daDeploy = await hoiDaDeploy();
  const files = lietKeFileEdge();
  const goi = timInvoke(doc, files);

  if (thuMuc.length < TOI_THIEU_THU_MUC || daDeploy.length < TOI_THIEU_DEPLOY) {
    console.error(
      `❌ Chỉ thấy ${thuMuc.length} thư mục / ${daDeploy.length} bản deploy ` +
        `(sàn ${TOI_THIEU_THU_MUC}/${TOI_THIEU_DEPLOY}) — phép đo hỏng, không phải "không vi phạm".`,
    );
    process.exit(3);
  }

  const kq = dungManifestEdge(thuMuc, daDeploy, goi);
  console.log(
    `Bề mặt Edge: ${thuMuc.length} thư mục · ${daDeploy.length} đang chạy · ${goi.size} slug được gọi`,
  );

  let hong = 0;

  if (kq.goiHamKhongTonTai.length > 0) {
    console.error(`\n❌ ${kq.goiHamKhongTonTai.length} slug được GỌI mà KHÔNG đang chạy:`);
    for (const t of kq.goiHamKhongTonTai) console.error(`   - ${t.slug}  ← ${t.callers.slice(0, 3).join(", ")}`);
    console.error("  404 lúc chạy. Không gì bắt được lúc biên dịch vì slug chỉ là một chuỗi.");
    hong = 1;
  }

  if (kq.dangChayKhongCoMa.length > 0) {
    console.error(`\n❌ ${kq.dangChayKhongCoMa.length} hàm ĐANG CHẠY mà repo không còn mã nguồn:`);
    for (const s of kq.dangChayKhongCoMa) console.error(`   - ${s}`);
    console.error("  Mã đang chạy trên dữ liệu thật mà không ai đọc được, cũng không ai sửa được.");
    hong = 1;
  }

  const lech = soManifestEdge(cu, kq);
  if (lech.length > 0) {
    console.error(`\n❌ Manifest đã trôi ở ${lech.length} chỗ:`);
    for (const l of lech.slice(0, 20)) console.error(`   ${l}`);
    console.error("\n  Sinh lại rồi ĐỌC DIFF: node scripts/generate-edge-surface.mjs");
    hong = 1;
  }

  if (hong) process.exit(1);

  console.log(`✅ 0 gọi hụt · 0 hàm mồ côi trên server · 0 trôi.`);
  if (kq.coMaKhongChay.length > 0) {
    console.log(`   ℹ ${kq.coMaKhongChay.length} hàm CÓ MÃ mà chưa deploy: ${kq.coMaKhongChay.join(", ")}.`);
    console.log(`     Hợp lệ (chưa tới lúc), chỉ thành lỗi khi có ai gọi — ca đó đã bắt ở trên.`);
  }
  const cong = daDeploy.filter((f) => f.verify_jwt === false).map((f) => f.slug);
  if (cong.length > 0) {
    console.log(`   ℹ ${cong.length} hàm verify_jwt = FALSE ⇒ bất kỳ ai trên Internet cũng gọi được:`);
    console.log(`     ${cong.join(", ")}. Là lựa chọn thiết kế cho webhook/cron, nhưng phải nhìn thấy được.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ Lỗi không lường trước: ${e.message}`);
    process.exit(3);
  });
}
