#!/usr/bin/env node
// Gate: mọi commit trên nhánh `production` PHẢI đã có sẵn trên `main`.
//
// VÌ SAO
//   Từ 06/08/2026 Vercel theo dõi nhánh `production`, nên push vào đó = PHÁT HÀNH
//   THẲNG cho người dùng thật. Mô hình đã chốt là promote: main chạy hết gate,
//   rồi production fast-forward tới đúng commit đó.
//
//   Một commit chỉ tồn tại trên `production` là mã CHƯA TỪNG qua CI của main, đang
//   chạy trên dữ liệu tiền thật. Nó không nhất thiết là hành vi xấu — thường là
//   một bản vá gấp lúc nửa đêm — nhưng nó phải ồn ào, không được lặng lẽ.
//
//   Branch protection không bật được: repo private trên GitHub Free (đã đo, ghi ở
//   scripts/check-external-controls.mjs và docs/generated/external-controls.json).
//   Nên cửa chặn duy nhất khả thi là một job CI kêu SAU KHI push. Kêu sau vẫn hơn
//   không biết — nó biến một sự kiện vô hình thành một dòng đỏ có người đọc.
//
//   node scripts/check-production-promotion.mjs
//   node scripts/check-production-promotion.mjs --nhanh production
//
// Cần lịch sử ĐẦY ĐỦ (checkout fetch-depth: 0). Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: repoRoot, encoding: "utf8" }).trim();

/** Nhánh nguồn sự thật — mọi thứ phát hành phải đi qua đây. */
export const NHANH_GOC = "main";

export function docCo(ten, mac) {
  const i = process.argv.indexOf(ten);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : mac;
}

/** Commit có trên `nhanh` mà KHÔNG có trên `goc`. */
export function commitChiCoTrenNhanh(chay, nhanh, goc) {
  return chay("rev-list", `${goc}..${nhanh}`).split(/\r?\n/).filter(Boolean);
}

function main() {
  const nhanh = docCo("--nhanh", "production");

  let shallow;
  try {
    shallow = git("rev-parse", "--is-shallow-repository") === "true";
  } catch (e) {
    console.error(`❌ Không chạy được git: ${e.message}`);
    process.exit(3);
  }
  if (shallow) {
    // Trên checkout nông, `rev-list goc..nhanh` trả kết quả VÔ NGHĨA nhưng KHÔNG
    // báo lỗi — nó chỉ thấy phần lịch sử được tải về. Đó là xanh-rỗng, tệ nhất.
    console.error("❌ Repo đang shallow — không kết luận được về lịch sử.");
    console.error("   Thêm `fetch-depth: 0` vào bước actions/checkout của job này.");
    process.exit(3);
  }

  const co = (r) => {
    try {
      git("rev-parse", "--verify", r);
      return true;
    } catch {
      return false;
    }
  };
  const giaiQuyet = (ten) => (co(`origin/${ten}`) ? `origin/${ten}` : co(ten) ? ten : null);

  const refNhanh = giaiQuyet(nhanh);
  const refGoc = giaiQuyet(NHANH_GOC);
  if (!refNhanh || !refGoc) {
    console.error(`❌ Không tìm thấy ref: ${!refNhanh ? nhanh : NHANH_GOC}.`);
    console.error("   Nếu chạy trên CI, chắc chắn đã fetch cả hai nhánh.");
    process.exit(3);
  }

  const rieng = commitChiCoTrenNhanh((...a) => git(...a), refNhanh, refGoc);
  console.log(`Promote: ${refNhanh} (${git("rev-parse", "--short", refNhanh)}) so với ${refGoc} (${git("rev-parse", "--short", refGoc)})`);

  if (rieng.length > 0) {
    console.error(`\n❌ ${rieng.length} commit chỉ có trên \`${nhanh}\`, KHÔNG có trên \`${NHANH_GOC}\`:`);
    for (const c of rieng.slice(0, 20)) {
      console.error(`   ${git("show", "-s", "--format=%h %an %s", c)}`);
    }
    console.error(`\n  Đây là mã CHƯA TỪNG qua CI của \`${NHANH_GOC}\` mà đang chạy trên dữ liệu tiền thật.`);
    console.error(`  Cách xử: merge/cherry-pick chúng về \`${NHANH_GOC}\`, để gate chạy, rồi promote lại.`);
    process.exit(1);
  }

  const sau = commitChiCoTrenNhanh((...a) => git(...a), refGoc, refNhanh).length;
  console.log(`✅ \`${nhanh}\` không có commit riêng — mọi thứ đang chạy đều đã qua \`${NHANH_GOC}\`.`);
  if (sau > 0) console.log(`   ℹ \`${NHANH_GOC}\` đang đi trước ${sau} commit chưa promote. Bình thường.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
