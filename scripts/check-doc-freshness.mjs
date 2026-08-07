#!/usr/bin/env node
// Gate: tài liệu mà AI Copilot ĐỌC phải có con dấu review CÒN HIỆU LỰC.
//
// VÌ SAO KHÁC check-copilot-docs-manifest.mjs
//   Gate kia hỏi "file trong thư mục có khớp manifest không". Gate này hỏi câu
//   đắt hơn: "con dấu review có còn nói gì về BẢN HIỆN TẠI của tài liệu không".
//
//   Ba cách một con dấu mất hiệu lực, và cách thứ hai là cách hay xảy ra nhất mà
//   không ai để ý:
//     1. không có dấu — chưa ai từng xác nhận;
//     2. TÀI LIỆU ĐÃ ĐỔI SAU NGÀY ĐÓNG DẤU — dấu nói về một văn bản không còn
//        tồn tại. Đây là dạng nguy hiểm nhất vì manifest trông vẫn "đã review";
//     3. quá `staleAfterDays` — code đã trôi đủ xa.
//
// VÌ SAO ĐÁNG MỘT CỬA CHẶN RIÊNG
//   Copilot trả lời câu hỏi nghiệp vụ của người dùng TỪ những tài liệu này, gồm
//   SOP tiền và sổ quỹ, hợp đồng, thanh lý, cọc giữ chỗ. Một tài liệu sai không
//   dừng lại ở chỗ sai: nó được đọc to lên bằng giọng của hệ thống.
//
//   Đo 07/08/2026: 21/25 tài liệu Copilot đọc KHÔNG có review còn hiệu lực —
//   9 cái đã sửa sau ngày đóng dấu, 12 cái chưa từng review.
//
// RATCHET, KHÔNG PHẢI ĐỎ NGAY
//   Đỏ ngay 21 chỗ thì gate bị tắt trong tuần. Baseline giữ nợ hiện có; tài liệu
//   MỚI hoặc tài liệu vừa được dọn xong rồi bẩn lại thì đỏ. Riêng ngưỡng
//   `staleAfterDays` là đỏ THẬT ngay cả với mục trong baseline — hôm nay chưa
//   file nào chạm ngưỡng đó nên bật được mà không vỡ gì.
//
//   node scripts/check-doc-freshness.mjs
//   node scripts/check-doc-freshness.mjs --write   # chốt mức mới (chỉ khi GIẢM)
//
// Cần lịch sử git (fetch-depth: 0). Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join("docs", "he-thong", "manifest.json");
const BASELINE = join("tooling", "doc-freshness-baseline.json");

/** Sàn chống rỗng — hệ này chắc chắn cho Copilot đọc hàng chục trang. */
export const TOI_THIEU_TAI_LIEU = 15;

/**
 * Con dấu review có còn hiệu lực không.
 *
 * `lanSuaCuoi` là ngày commit cuối của CHÍNH file đó (YYYY-MM-DD). So theo NGÀY
 * chứ không theo giờ: `reviewed` chỉ có độ chính xác tới ngày, nên so giờ sẽ báo
 * đỏ cho một lần sửa cùng ngày với lần review.
 */
export function danhGiaDau(entry, lanSuaCuoi, homNay, staleAfterDays) {
  if (!entry.reviewed) return { ok: false, vi: "chưa từng review" };
  if (lanSuaCuoi && lanSuaCuoi > entry.reviewed) {
    return { ok: false, vi: `sửa ${lanSuaCuoi} SAU khi review ${entry.reviewed}`, doiSauReview: true };
  }
  const tuoi = Math.floor((Date.parse(homNay) - Date.parse(entry.reviewed)) / 86_400_000);
  if (Number.isFinite(tuoi) && tuoi > staleAfterDays) {
    return { ok: false, vi: `review ${entry.reviewed} đã ${tuoi} ngày (ngưỡng ${staleAfterDays})`, quaHan: true };
  }
  return { ok: true };
}

function main() {
  const viet = process.argv.includes("--write");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
  } catch (e) {
    console.error(`❌ Không đọc được ${MANIFEST}: ${e.message}`);
    process.exit(3);
  }
  const staleAfterDays = manifest.staleAfterDays;
  if (!Number.isFinite(staleAfterDays)) {
    console.error(`❌ manifest thiếu \`staleAfterDays\` — không có ngưỡng thì không kết luận được.`);
    process.exit(3);
  }

  try {
    if (execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot, encoding: "utf8" }).trim() === "true") {
      // Trên checkout nông, `git log -1 -- <file>` trả RỖNG cho phần lớn file, và
      // "không có commit" sẽ bị đọc thành "chưa sửa sau review" — tức xanh rỗng.
      console.error("❌ Repo đang shallow — ngày sửa cuối không đọc được, không kết luận được.");
      console.error("   Thêm `fetch-depth: 0` vào bước checkout của job này.");
      process.exit(3);
    }
  } catch (e) {
    console.error(`❌ Không chạy được git: ${e.message}`);
    process.exit(3);
  }

  const doc = (manifest.entries ?? []).filter((e) => e.copilotIngest);
  if (doc.length < TOI_THIEU_TAI_LIEU) {
    console.error(`❌ Chỉ thấy ${doc.length} tài liệu Copilot đọc (sàn ${TOI_THIEU_TAI_LIEU}) — phép đo hỏng.`);
    process.exit(3);
  }

  const homNay = new Date().toISOString().slice(0, 10);
  const hong = [];
  const quaHanThat = [];
  for (const e of doc) {
    const p = `docs/he-thong/${e.file}`;
    let lanSuaCuoi = null;
    try {
      const s = execFileSync("git", ["log", "-1", "--format=%cI", "--", p], { cwd: repoRoot, encoding: "utf8" }).trim();
      lanSuaCuoi = s ? s.slice(0, 10) : null;
    } catch {
      lanSuaCuoi = null;
    }
    const kq = danhGiaDau(e, lanSuaCuoi, homNay, staleAfterDays);
    if (!kq.ok) {
      hong.push({ file: e.file, vi: kq.vi });
      if (kq.quaHan) quaHanThat.push({ file: e.file, vi: kq.vi });
    }
  }

  let baseline = [];
  const bPath = join(repoRoot, BASELINE);
  if (existsSync(bPath)) {
    try {
      baseline = JSON.parse(readFileSync(bPath, "utf8")).files ?? [];
    } catch (e) {
      console.error(`❌ Không đọc được ${BASELINE}: ${e.message}`);
      process.exit(3);
    }
  }
  const moi = hong.filter((h) => !baseline.includes(h.file));
  const daDon = baseline.filter((f) => !hong.some((h) => h.file === f));

  console.log(
    `Tài liệu Copilot đọc: ${doc.length} · dấu còn hiệu lực ${doc.length - hong.length} · ` +
      `nợ ${hong.length} (baseline ${baseline.length})`,
  );

  if (viet) {
    const laLanDau = !existsSync(bPath);
    if (!laLanDau && moi.length > 0) {
      console.error(`❌ Không chốt baseline khi có ${moi.length} tài liệu mới mất hiệu lực. Ratchet chỉ đi xuống.`);
      for (const m of moi) console.error(`   + ${m.file}: ${m.vi}`);
      process.exit(1);
    }
    writeFileSync(
      bPath,
      JSON.stringify(
        {
          $comment:
            "Nợ tài liệu: file Copilot ĐỌC mà con dấu review không còn hiệu lực. Ratchet — danh sách chỉ được ngắn đi. Dọn một file = đọc lại nó, sửa cho đúng, rồi cập nhật `reviewed` trong docs/he-thong/manifest.json, sau đó chạy `npm run gate:doc-freshness -- --write`. Vì sao quan trọng: Copilot trả lời câu hỏi nghiệp vụ TỪ những trang này, gồm SOP tiền và sổ quỹ — một trang sai không dừng ở chỗ sai, nó được đọc to lên bằng giọng của hệ thống.",
          updatedAt: homNay,
          staleAfterDays,
          files: hong.map((h) => h.file).sort(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✅ Đã chốt baseline ở ${hong.length} tài liệu (dọn được ${daDon.length} so với trước).`);
    return;
  }

  let loi = 0;

  // Quá ngưỡng là ĐỎ THẬT, kể cả nằm trong baseline: baseline giữ nợ cũ, không
  // giữ quyền để nó cũ mãi.
  if (quaHanThat.length > 0) {
    console.error(`\n❌ ${quaHanThat.length} tài liệu quá ngưỡng ${staleAfterDays} ngày (baseline KHÔNG che):`);
    for (const q of quaHanThat) console.error(`   - ${q.file}: ${q.vi}`);
    loi = 1;
  }

  if (moi.length > 0) {
    console.error(`\n❌ ${moi.length} tài liệu MỚI mất hiệu lực review:`);
    for (const m of moi) console.error(`   + ${m.file}: ${m.vi}`);
    console.error("\n  Sửa một trang Copilot đọc thì phải cập nhật `reviewed` trong manifest —");
    console.error("  bạn vừa đọc nó rồi, đóng dấu tốn một dòng. Con dấu trỏ vào một văn bản");
    console.error("  không còn tồn tại thì tệ hơn không có dấu: manifest vẫn trông như đã review.");
    loi = 1;
  }

  if (loi) process.exit(1);

  if (daDon.length > 0) {
    console.log(`✅ 0 vi phạm mới. Đã dọn ${daDon.length} tài liệu — chạy \`--write\` để chốt mức thấp hơn.`);
  } else {
    console.log(`✅ 0 vi phạm mới. Nợ còn ${hong.length} tài liệu (xem ${BASELINE}).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
