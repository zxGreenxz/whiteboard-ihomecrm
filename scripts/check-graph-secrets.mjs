#!/usr/bin/env node
// Gate: artifact graph tri thức không được mang secret hay PII khách hàng.
//
// VÌ SAO CẦN (PROJECT_CONTRACT §12; plan mục 50 dòng 2939 + mục 31)
//   `.ua/knowledge-graph.json` là 8 MB văn bản do LLM sinh ra sau khi ĐỌC toàn bộ
//   repo — kể cả file seed, fixture test, migration có dữ liệu mẫu. Nó được commit
//   và push công khai. Không có gì bảo đảm một summary không chép nguyên một token
//   hay một số điện thoại khách ra ngoài, và diff 8 MB JSON thì không ai review nổi
//   bằng mắt. `gate:graph-hygiene` chỉ kiểm hộ chiếu khớp artifact — nó không mở
//   file ra xem bên trong có gì.
//
//   Trước gate này, phép kiểm duy nhất là "người nhớ chạy gitleaks bằng tay". Chạy
//   tay không phải phép kiểm: lần refresh sau không có gì cưỡng chế.
//
// HAI PHÉP KIỂM, VÀ VÌ SAO PHẢI CÓ CẢ HAI
//   (1) SECRET — gitleaks, cùng version ghim như CI. Bắt token/key theo bộ luật đã
//       được kiểm chứng, không tự chế lại.
//   (2) PII — gitleaks KHÔNG bắt số điện thoại khách. Đo thật ngày 08/08/2026:
//       gitleaks trả "no leaks found" trên `.ua/`, trong khi quét thô tìm được 11
//       chuỗi trông như số điện thoại VN.
//
// BÀI HỌC ĐÃ TRẢ GIÁ — VÌ SAO KHÔNG QUÉT THÔ TOÀN FILE
//   Cả 11 chuỗi đó là DƯƠNG TÍNH GIẢ: chúng là 10 chữ số thập phân nằm bên trong
//   `contentHash` sha256 (hex 0-9a-f nên chuỗi số dài xuất hiện thường xuyên). Một
//   gate đỏ ngay ngày đầu vì lý do không có thật sẽ bị tắt, và phép kiểm thật chết
//   theo nó. Nên gate này KHÔNG regex trên byte thô: nó bóc đúng những trường do
//   NGƯỜI/LLM viết (summary, name, description, tags, languageNotes, title) và chỉ
//   quét chỗ đó. Hash, id, filePath, lineRange không bao giờ chứa PII thật.
//
//   node scripts/check-graph-secrets.mjs
//   GITLEAKS_BIN=/path/to/gitleaks node scripts/check-graph-secrets.mjs
//
// Không cần credential DB. Thoát 0 đạt · 1 vi phạm · 3 KHÔNG KIỂM ĐƯỢC (≠ đạt).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = join(repoRoot, ".ua");

/**
 * Sàn chống-xanh-rỗng.
 *
 * Một graph thật của repo này có hàng nghìn trường văn bản. Nếu bóc ra được ít hơn
 * ngần này thì hoặc schema đã đổi, hoặc file hỏng — và khi ấy "không tìm thấy PII"
 * là câu nói dối, không phải kết luận. Đỏ bằng exit 3, không phải exit 0.
 */
export const TOI_THIEU_TRUONG_VAN_BAN = 500;

/** Trường do người/LLM viết. Mọi trường khác (hash, id, path, số) KHÔNG quét. */
export const TRUONG_VAN_BAN = new Set([
  "summary",
  "description",
  "name",
  "title",
  "languageNotes",
  "languageLesson",
  "tags",
]);

/**
 * Mẫu PII. Cố ý HẸP: mỗi mẫu phải là thứ không thể xuất hiện tình cờ trong văn xuôi
 * kỹ thuật tiếng Việt. Thà bỏ sót một dạng còn hơn đỏ giả rồi bị tắt.
 */
export const MAU_PII = [
  { ten: "số điện thoại VN", re: /(?<![0-9+])(?:0|\+84)[35789][0-9]{8}(?![0-9])/g },
  { ten: "email", re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z])/g },
];

/**
 * Email xuất hiện hợp lệ trong văn bản kỹ thuật — không phải PII khách hàng.
 * Giữ danh sách NGẮN và tường minh; mỗi mục là một quyết định có lý do.
 */
export const EMAIL_MIEN_TRU = [
  /@example\.(com|org|net)$/i,
  /@noreply\./i,
  /noreply@/i,
  /@users\.noreply\.github\.com$/i,
  /@test\.local$/i,
];

/**
 * Bóc mọi trường văn bản do người viết ra khỏi một cây JSON bất kỳ.
 * Trả về [{ duong, truong, text }] — `duong` để báo lỗi chỉ đúng chỗ.
 */
export function bocVanBanNguoi(root) {
  const ra = [];
  const di = (nut, duong) => {
    if (nut === null || nut === undefined) return;
    if (Array.isArray(nut)) {
      nut.forEach((x, i) => di(x, `${duong}[${i}]`));
      return;
    }
    if (typeof nut !== "object") return;
    for (const [k, v] of Object.entries(nut)) {
      const d = duong ? `${duong}.${k}` : k;
      if (TRUONG_VAN_BAN.has(k)) {
        if (typeof v === "string") ra.push({ duong: d, truong: k, text: v });
        else if (Array.isArray(v)) v.forEach((x, i) => typeof x === "string" && ra.push({ duong: `${d}[${i}]`, truong: k, text: x }));
        // mảng tag có thể lồng object — vẫn đi tiếp bên dưới
      }
      if (typeof v === "object") di(v, d);
    }
  };
  di(root, "");
  return ra;
}

/** Tìm PII trong MỘT chuỗi. Trả [{ loai, khop }]. */
export function timPII(text) {
  const ra = [];
  for (const { ten, re } of MAU_PII) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (ten === "email" && EMAIL_MIEN_TRU.some((x) => x.test(m[0]))) continue;
      ra.push({ loai: ten, khop: m[0] });
    }
  }
  return ra;
}

/** Che giá trị khi in ra — báo cáo không được tự nó thành chỗ rò. */
export function che(s) {
  if (s.length <= 6) return s[0] + "…";
  return s.slice(0, 4) + "…" + s.slice(-2);
}

/** Tìm binary gitleaks. Trả null nếu không có — người gọi phải xử là exit 3. */
export function timGitleaks() {
  if (process.env.GITLEAKS_BIN && existsSync(process.env.GITLEAKS_BIN)) return process.env.GITLEAKS_BIN;
  for (const ung of ["/tmp/gitleaks.exe", "/tmp/gitleaks", "gitleaks"]) {
    try {
      execFileSync(ung, ["version"], { stdio: "pipe" });
      return ung;
    } catch {
      /* thử cái tiếp */
    }
  }
  return null;
}

function main() {
  const artifacts = ["knowledge-graph.json", "fingerprints.json", "meta.json"].map((f) => join(UA, f));

  // ── Chống-xanh-rỗng: không có artifact thì KHÔNG kết luận là sạch ──────────
  const thieu = artifacts.filter((p) => !existsSync(p));
  if (thieu.length) {
    console.error(`❌ Không thấy ${thieu.length} artifact trong .ua/ — không kiểm được, KHÔNG phải sạch.`);
    for (const p of thieu) console.error(`   ${p.replace(repoRoot, ".")}`);
    process.exit(3);
  }

  // ── (1) SECRET — gitleaks ──────────────────────────────────────────────────
  const bin = timGitleaks();
  if (!bin) {
    console.error("❌ Không tìm thấy binary gitleaks — KHÔNG KIỂM ĐƯỢC, không được tính là đạt.");
    console.error("   CI cài bản ghim v8.30.1 (xem .github/workflows/ci-gates.yml).");
    console.error("   Máy dev: tải cùng version rồi đặt GITLEAKS_BIN=<đường dẫn>.");
    process.exit(3);
  }
  let rori = false;
  try {
    execFileSync(bin, ["detect", "--source", UA, "--no-git", "--redact", "--no-banner", "--config", join(repoRoot, ".gitleaks.toml")], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch (e) {
    // gitleaks thoát 1 khi TÌM THẤY rò; thoát khác là hỏng công cụ.
    if (e.status === 1) rori = true;
    else {
      console.error(`❌ gitleaks lỗi bất thường (exit ${e.status}) — không kiểm được.`);
      console.error(String(e.stderr ?? e.message).slice(0, 500));
      process.exit(3);
    }
  }

  // ── (2) PII — chỉ trên trường văn bản do người viết ────────────────────────
  let truong = [];
  for (const p of artifacts) {
    let j;
    try {
      j = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`❌ ${p.replace(repoRoot, ".")} không parse được: ${e.message} — không kiểm được.`);
      process.exit(3);
    }
    truong.push(...bocVanBanNguoi(j).map((x) => ({ ...x, file: p.replace(repoRoot + "\\", "").replace(repoRoot + "/", "") })));
  }

  if (truong.length < TOI_THIEU_TRUONG_VAN_BAN) {
    console.error(
      `❌ Chỉ bóc được ${truong.length} trường văn bản (sàn ${TOI_THIEU_TRUONG_VAN_BAN}) — schema đã đổi hoặc artifact hỏng. ` +
        `"Không thấy PII" ở mức này là vô nghĩa.`,
    );
    process.exit(3);
  }

  const dinh = [];
  for (const t of truong) {
    for (const p of timPII(t.text)) dinh.push({ ...t, ...p });
  }

  console.log(
    `Quét artifact graph: ${artifacts.length} file · ${truong.length} trường văn bản do người viết · gitleaks ${bin === "gitleaks" ? "(PATH)" : bin}`,
  );

  if (rori || dinh.length) {
    if (rori) console.error("\n❌ gitleaks TÌM THẤY secret trong .ua/ — chạy lại lệnh dưới để xem chi tiết:");
    if (rori) console.error(`   ${bin} detect --source .ua --no-git --redact --config .gitleaks.toml`);
    if (dinh.length) {
      console.error(`\n❌ ${dinh.length} chỗ nghi PII trong trường văn bản của graph:`);
      for (const d of dinh.slice(0, 20)) console.error(`   [${d.loai}] ${che(d.khop)}  ·  ${d.file} → ${d.duong}`);
      if (dinh.length > 20) console.error(`   … còn ${dinh.length - 20}`);
      console.error("\n   Graph được commit và push công khai. Sửa nguồn (file bị mô tả) rồi dựng lại graph;");
      console.error("   ĐỪNG sửa tay knowledge-graph.json — lần refresh sau sẽ sinh lại y nguyên.");
    }
    process.exit(1);
  }

  console.log("✅ Artifact graph sạch — 0 secret (gitleaks), 0 PII trong trường văn bản.");
  console.log("   CHƯA KIỂM: trường hash/id/path (theo thiết kế — chúng không chứa PII thật, và quét thô ở đó");
  console.log("   cho dương tính giả: 10 chữ số trong sha256 trông y hệt số điện thoại).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
