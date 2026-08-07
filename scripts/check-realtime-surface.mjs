#!/usr/bin/env node
// Gate chống trôi cho contracts/surfaces/realtime-surface.json.
//
// PHÂN VAI VỚI check-realtime-descriptors.mjs
//   Gate kia trả lời MỘT câu nhị phân, và đó là câu đắt nhất: bảng hub nghe có
//   được publish không (không thì im lặng tuyệt đối). Gate này giữ TOÀN CẢNH để
//   diff được — ai nghe bảng nào, bảng nào publish mà không hệ nào nghe, và
//   REPLICA IDENTITY của từng bảng.
//
//   REPLICA IDENTITY đáng một dòng riêng: mặc định là DEFAULT, nghĩa là payload
//   UPDATE/DELETE chỉ mang KHOÁ CHÍNH. Code đọc `payload.old.status` từ một bảng
//   DEFAULT sẽ nhận `undefined` — không lỗi, không cảnh báo, chỉ là một nhánh
//   điều kiện lặng lẽ đi sai đường. Đổi một bảng từ FULL về DEFAULT là thay đổi
//   hành vi vô hình, và manifest này làm nó thành một dòng diff.
//
//   node scripts/check-realtime-surface.mjs
//
// Cần SUPABASE_PAT. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hoiCatalog, pat } from "./generate-rpc-surface.mjs";
import {
  DUONG_DAN_RT,
  SQL_REALTIME,
  docHubTables,
  dungManifestRt,
  lietKeFileRt,
  nạpHangDanhSach,
  timNguoiNgheKhac,
} from "./generate-realtime-surface.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Sàn chống rỗng — hệ này chắc chắn publish hàng chục bảng. */
export const TOI_THIEU_PUBLISH = 15;

export function soManifestRt(cu, moi) {
  const lech = [];
  const a = cu.tables ?? {};
  const b = moi.tables ?? {};
  for (const t of Object.keys(b)) if (!(t in a)) lech.push(`+ bảng mới trong bề mặt: ${t}`);
  for (const t of Object.keys(a)) if (!(t in b)) lech.push(`- bảng rời bề mặt: ${t}`);
  for (const t of Object.keys(b).filter((x) => x in a)) {
    for (const k of ["published", "replicaIdentity", "rlsEnabled", "listenedByHub"]) {
      if (JSON.stringify(a[t][k]) !== JSON.stringify(b[t][k])) {
        lech.push(`~ ${t}.${k}: ${JSON.stringify(a[t][k])} → ${JSON.stringify(b[t][k])}`);
      }
    }
    if (JSON.stringify(a[t].otherListeners) !== JSON.stringify(b[t].otherListeners)) {
      lech.push(`~ ${t}: danh sách hệ lắng nghe đã đổi`);
    }
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
    cu = JSON.parse(readFileSync(join(repoRoot, DUONG_DAN_RT), "utf8"));
  } catch (e) {
    console.error(`❌ Không đọc được ${DUONG_DAN_RT}: ${e.message}`);
    console.error("   Sinh lần đầu: node scripts/generate-realtime-surface.mjs");
    process.exit(3);
  }

  const doc = (f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8");
    } catch {
      return null;
    }
  };
  const hub = docHubTables();
  if (!hub) {
    console.error("❌ Không đọc được REALTIME_SYNC_TABLES qua vite-node — không kết luận được.");
    process.exit(3);
  }
  const hangPub = await hoiCatalog(SQL_REALTIME);
  if (hangPub.length < TOI_THIEU_PUBLISH) {
    console.error(`❌ Publication chỉ trả ${hangPub.length} bảng (sàn ${TOI_THIEU_PUBLISH}) — phép đo hỏng.`);
    process.exit(3);
  }
  const files = lietKeFileRt();
  const { hang, loi } = nạpHangDanhSach(doc, files);
  if (hang === null) {
    console.error("❌ Không nạp được hằng danh sách bảng qua vite-node — không kết luận được.");
    console.error(loi ?? "");
    process.exit(3);
  }
  const ngheKhac = timNguoiNgheKhac(doc, files, hang);
  const kq = dungManifestRt(hangPub, hub, ngheKhac);

  console.log(`Bề mặt realtime: ${hangPub.length} bảng publish · ${hub.length} hub nghe`);

  let hong = 0;
  if (kq.hubKhongPublish.length > 0) {
    console.error(`\n❌ ${kq.hubKhongPublish.length} bảng hub nghe mà KHÔNG được publish (subscribe câm):`);
    for (const t of kq.hubKhongPublish) console.error(`   - ${t}`);
    hong = 1;
  }
  const lech = soManifestRt(cu, kq);
  if (lech.length > 0) {
    console.error(`\n❌ Manifest đã trôi ở ${lech.length} chỗ:`);
    for (const l of lech.slice(0, 25)) console.error(`   ${l}`);
    console.error("\n  Sinh lại rồi ĐỌC DIFF: node scripts/generate-realtime-surface.mjs");
    hong = 1;
  }
  if (hong) process.exit(1);

  const dinh = Object.entries(kq.tables).filter(([, v]) => v.published && v.replicaIdentity === "DEFAULT");
  console.log(`✅ Bề mặt khớp thực tế: 0 subscribe câm · 0 trôi.`);
  console.log(
    `   ℹ ${dinh.length}/${hangPub.length} bảng có REPLICA IDENTITY = DEFAULT ⇒ payload UPDATE/DELETE chỉ mang khoá chính.`,
  );
  if (kq.publishKhongAiNghe.length > 0) {
    console.log(`   ℹ ${kq.publishKhongAiNghe.length} bảng publish mà không hệ nào trong repo nghe: ${kq.publishKhongAiNghe.join(", ")}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ Lỗi không lường trước: ${e.message}`);
    process.exit(3);
  });
}
