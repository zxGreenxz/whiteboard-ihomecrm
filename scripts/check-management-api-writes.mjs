#!/usr/bin/env node
// Gate: không ai được GHI production qua Management API ngoài lane chính thức.
//
// VÌ SAO GATE NÀY TỒN TẠI — có án lệ, ngày 07/08/2026
//   Một migration được apply bằng cách POST thẳng file SQL tới
//   `/v1/projects/{ref}/database/query`, bỏ qua toàn bộ lane
//   `npm run migrate:forward`: không cutoff, không provenance, không digest,
//   KHÔNG BACKUP. Với PITR đang TẮT, "không backup" nghĩa là đường lùi gần nhất
//   là bản sao hằng ngày — tới ~24 giờ sổ sách tiền thật.
//
//   Luật cấm việc đó đã có trong Contract từ trước. Nó không giúp gì, vì nó chỉ
//   là chữ: `scripts/check-no-auto-apply.mjs` chỉ canh `supabase db push` trong
//   khối `run:` của GitHub workflow, và không nói gì về endpoint này.
//
// KHÔNG CẤM CẢ ENDPOINT
//   34 script gọi `/database/query`, và phần lớn là các cửa chặn đang canh chính
//   production (catalog, quyền, view invoker, đối chiếu tiền). Cấm cả endpoint
//   thì 20 gate chết theo, và đó là cách chắc chắn nhất để gate này bị gỡ.
//   Nên gate phân biệt ĐỌC với GHI, và chỉ chặn GHI mới.
//
//   node scripts/check-management-api-writes.mjs
//   node scripts/check-management-api-writes.mjs --write   # chốt mức mới
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join("tooling", "management-api-writers.json");

/** Sàn chống rỗng: bộ dò hỏng thì tập rỗng và gate in dấu tick trên hư không. */
export const TOI_THIEU_CALLER = 20;

/** Lane DUY NHẤT được phép ghi schema production. */
export const LANE_CHINH_THUC = "scripts/apply-reviewed-migration.mjs";

const DDL_DML =
  /\b(insert\s+into|update\s+[a-z_"]|delete\s+from|create\s+(or\s+replace\s+)?(table|function|view|materialized|index|policy|trigger|schema|type|extension|publication|role)|alter\s+(table|function|view|publication|role|schema|database|default)|drop\s+(table|function|view|index|policy|trigger|schema|type|publication)|grant\s+\w|revoke\s+\w|truncate\s+\w|refresh\s+materialized)/i;

/**
 * SQL đến từ NGOÀI file (đối số dòng lệnh, hoặc file do người dùng chỉ định).
 *
 * Đây mới là dấu hiệu "gửi được bất cứ thứ gì", chứ không phải việc có một biến
 * tên `sql`. Bản dò đầu tiên nhầm chỗ này và xếp cả `check-view-invoker.mjs`
 * (chỉ đọc, SQL là hằng trong file) vào nhóm nguy hiểm — một gate báo động giả
 * ngay từ lần chạy đầu sẽ không sống nổi tới lần thứ ba.
 */
const NHAN_SQL_TU_NGOAI = [
  /readFileSync\(\s*(file|filePath|duongDan|argPath|process\.argv\[\d\])/,
  /process\.argv\[\d\][\s\S]{0,160}?(query|sql)\s*[:=]/i,
  /const\s+(sql|query)\s*=\s*readFileSync\(/,
];

/**
 * Tên file TỰ KHAI là đường ghi. Thiên lệch AN TOÀN, không phải phỏng đoán.
 *
 * `apply-accounting-rollout.mjs` gửi một biến `query` được dựng ở chỗ khác trong
 * file, nên mọi phép quét từ khoá đều trượt và nó bị xếp là "chỉ đọc" — sai theo
 * đúng hướng nguy hiểm. Một script tự gọi mình là apply/backfill/seed/migrate thì
 * không bao giờ được xếp vào nhóm vô hại chỉ vì bộ dò không đọc ra SQL của nó.
 */
const TEN_TU_KHAI_GHI = /(^|\/)(apply|backfill|seed|migrate|rollout|fix|repair|patch)[-_]/i;

export function phanLoai(noiDung, duongDan) {
  const p = duongDan.replace(/\\/g, "/");
  if (p === LANE_CHINH_THUC) return "lane";
  if (TEN_TU_KHAI_GHI.test(p)) return "write";
  // Bỏ comment: một script chỉ ĐỌC nhưng có comment giải thích "đừng CREATE
  // TABLE ở đây" sẽ bị xếp nhầm là ghi. Mẫu "gate tự khớp vào chính câu nói thứ
  // đó bị cấm" đã lặp nhiều lần trong repo này.
  const sach = noiDung.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  if (NHAN_SQL_TU_NGOAI.some((re) => re.test(sach))) return "passthrough";
  if (DDL_DML.test(sach)) return "write";
  return "read";
}

export function timCaller(docFile, danhSachFile) {
  const ra = [];
  for (const f of danhSachFile) {
    const s = docFile(f);
    if (s === null || !s.includes("database/query")) continue;
    ra.push({ file: f.replace(/\\/g, "/"), loai: phanLoai(s, f) });
  }
  return ra.sort((a, b) => a.file.localeCompare(b.file));
}

/** Caller nguy hiểm (ghi hoặc passthrough) mà baseline chưa biết. */
export function timMoiNguyHiem(baseline, hienTai) {
  const biet = new Map(baseline.map((b) => [b.file, b.loai]));
  return hienTai.filter((c) => c.loai !== "read" && c.loai !== "lane" && biet.get(c.file) !== c.loai);
}

/** Caller baseline ghi là ĐỌC mà nay thành ghi — leo thang âm thầm. */
export function timLeoThang(baseline, hienTai) {
  const biet = new Map(baseline.map((b) => [b.file, b.loai]));
  return hienTai.filter((c) => biet.has(c.file) && biet.get(c.file) === "read" && c.loai !== "read");
}

function main() {
  const viet = process.argv.includes("--write");
  let files;
  try {
    files = execFileSync("git", ["ls-files", "scripts/", "api/", "services/", "infra/", "worker/", "supabase/"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1e8,
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f));
  } catch (e) {
    console.error(`❌ Không liệt kê được file: ${e.message}`);
    process.exit(3);
  }

  const doc = (f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8");
    } catch {
      return null;
    }
  };
  const hienTai = timCaller(doc, files);
  if (hienTai.length < TOI_THIEU_CALLER) {
    console.error(`❌ Chỉ dò được ${hienTai.length} caller (sàn ${TOI_THIEU_CALLER}) — bộ dò hỏng.`);
    console.error(`   "0 vi phạm" trên một tập rỗng là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  const bPath = join(repoRoot, BASELINE);
  let baseline = [];
  if (existsSync(bPath)) {
    try {
      baseline = JSON.parse(readFileSync(bPath, "utf8")).callers ?? [];
    } catch (e) {
      console.error(`❌ Không đọc được ${BASELINE}: ${e.message}`);
      process.exit(3);
    }
  }

  const dem = hienTai.reduce((a, c) => ({ ...a, [c.loai]: (a[c.loai] ?? 0) + 1 }), {});
  console.log(
    `Caller /database/query: ${hienTai.length} · ` +
      Object.entries(dem)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  );

  if (viet) {
    const laLanDau = !existsSync(bPath);
    const moi = timMoiNguyHiem(baseline, hienTai);
    if (!laLanDau && moi.length > 0) {
      console.error(`❌ Không chốt baseline khi có ${moi.length} caller GHI mới. Ratchet chỉ đi xuống.`);
      for (const c of moi) console.error(`   + ${c.file} (${c.loai})`);
      process.exit(1);
    }
    const cu = new Map(baseline.map((b) => [b.file, b]));
    writeFileSync(
      bPath,
      JSON.stringify(
        {
          $comment:
            "Danh sách script được phép GHI production qua Management API. Gate: scripts/check-management-api-writes.mjs. Vì sao cần: 07/08/2026 một migration được POST thẳng tới /database/query, bỏ qua toàn bộ lane migrate:forward — không cutoff, không provenance, không digest, KHÔNG BACKUP; với PITR tắt thì đường lùi là ~24 giờ sổ sách. Luật cấm đã có trong Contract từ trước nhưng chỉ là chữ. THÊM DÒNG VÀO ĐÂY LÀ MỘT QUYẾT ĐỊNH: phải ghi `why` nói rõ vì sao script này cần ghi và vì sao không đi qua lane được.",
          updatedAt: new Date().toISOString().slice(0, 10),
          lane: LANE_CHINH_THUC,
          callers: hienTai.map((c) => ({
            ...c,
            why: cu.get(c.file)?.why ?? (c.loai === "read" ? "chỉ đọc catalog" : "CHƯA GHI LÝ DO — phải điền"),
          })),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✅ Đã chốt baseline ở ${hienTai.length} caller.`);
    return;
  }

  let hong = 0;
  const moi = timMoiNguyHiem(baseline, hienTai);
  if (moi.length > 0) {
    console.error(`\n❌ ${moi.length} caller GHI/PASSTHROUGH mới, chưa đăng ký:`);
    for (const c of moi) console.error(`   + ${c.file}  (${c.loai})`);
    console.error(`\n  Đổi schema production PHẢI đi \`npm run migrate:forward\` — lane đó tự chạy backup,`);
    console.error(`  tự kiểm bản dump, và ghi evidence. POST thẳng SQL bỏ qua tất cả.`);
    console.error(`  Nếu script này THẬT SỰ cần ghi và không đi lane được, đăng ký vào ${BASELINE}`);
    console.error(`  kèm \`why\` nói rõ vì sao — bằng \`--write\`.`);
    hong = 1;
  }

  const leo = timLeoThang(baseline, hienTai);
  if (leo.length > 0) {
    console.error(`\n❌ ${leo.length} caller baseline ghi là CHỈ ĐỌC mà nay đã GHI được:`);
    for (const c of leo) console.error(`   ~ ${c.file}  read → ${c.loai}`);
    console.error("  Đây là leo thang âm thầm: một cửa chặn chỉ-đọc biến thành đường ghi production.");
    hong = 1;
  }

  const chuaGhiLyDo = baseline.filter((b) => b.loai !== "read" && /CHƯA GHI LÝ DO/.test(b.why ?? ""));
  if (chuaGhiLyDo.length > 0) {
    console.error(`\n❌ ${chuaGhiLyDo.length} caller GHI chưa có lý do trong ${BASELINE}:`);
    for (const c of chuaGhiLyDo) console.error(`   - ${c.file}`);
    hong = 1;
  }

  // ── Giấy phép khai phải KHỚP MÃ ────────────────────────────────────────────
  //
  // Trường `why` là văn xuôi: nó giải thích cho người đọc nhưng không kiểm được.
  // Đo 11/08/2026: 17 caller `write`, chỉ 2 nhắc tới promotion token, và 6 cái
  // thật ra CHỈ ĐỌC (bị xếp `write` vì SQL của chúng trích văn bản định nghĩa
  // hàm, trong đó có chữ CREATE). Không có gì phân biệt được ba nhóm đó.
  //
  // `giayPhep` là khai báo có cấu trúc, và mỗi giá trị có một phép kiểm trên MÃ.
  // Khai một đằng mà mã một nẻo thì đỏ — đó là điểm khác giữa khai báo và lời hứa.
  const loiGP = [];
  for (const b of baseline.filter((x) => x.loai === "write")) {
    const gp = b.giayPhep;
    if (!gp) {
      loiGP.push(`${b.file}: thiếu \`giayPhep\` (lane · promotion-token · chi-demo · chi-test · giao-dich-rollback · chi-doc · khong-co-cua).`);
      continue;
    }
    let ma = "";
    try {
      ma = readFileSync(join(repoRoot, b.file), "utf8");
    } catch {
      loiGP.push(`${b.file}: khai giayPhep nhưng không đọc được file.`);
      continue;
    }
    const doi = {
      "promotion-token": [/promotion[ _-]?token|PROMOTION_TOKEN/i, "phải thực sự đòi promotion token"],
      "chi-demo": [/dddd0000/, "phải nhắc org DEMO dddd0000 — bằng chứng nó không chạm org THẬT"],
      "chi-test": [/cccc0000/, "phải nhắc org TEST cccc0000"],
      lane: [/apply-reviewed-migration|LOCK_NAME/, "phải là chính lane forward"],
      // Ghi trong transaction rồi ROLLBACK: không dòng nào tồn tại sau khi chạy.
      "giao-dich-rollback": [/\bROLLBACK\b/i, "phải thực sự có ROLLBACK — nếu không thì fixture ở lại production"],
    }[gp];
    if (doi && !doi[0].test(ma)) loiGP.push(`${b.file}: khai \`${gp}\` nhưng ${doi[1]}.`);
  }

  // `khong-co-cua` là thú nhận, không phải giấy phép — nó BẮT BUỘC có khoảng
  // trống đã đăng ký, để một đường ghi production không cửa không thể nằm im.
  const khongCua = baseline.filter((x) => x.giayPhep === "khong-co-cua");
  if (khongCua.length > 0) {
    let gaps = "";
    try {
      gaps = readFileSync(join(repoRoot, "tooling", "known-gaps.yaml"), "utf8");
    } catch {
      /* thiếu file — báo ở dưới */
    }
    if (!/management-api-ghi-khong-cua/.test(gaps)) {
      loiGP.push(
        `${khongCua.length} caller khai \`khong-co-cua\` nhưng chưa có known-gap \`management-api-ghi-khong-cua\`.\n` +
        `      → ${khongCua.map((c) => c.file).join(", ")}`,
      );
    }
  }

  if (loiGP.length > 0) {
    console.error(`\n❌ ${loiGP.length} giấy phép khai không khớp mã:`);
    for (const l of loiGP) console.error(`  - ${l}`);
    hong = 1;
  }

  if (hong) process.exit(1);
  console.log(`✅ Không có đường GHI production mới ngoài lane \`${LANE_CHINH_THUC}\`.`);
  const demGP = new Map();
  for (const b of baseline.filter((x) => x.loai === "write")) demGP.set(b.giayPhep, (demGP.get(b.giayPhep) ?? 0) + 1);
  console.log(`   giấy phép: ${[...demGP].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
