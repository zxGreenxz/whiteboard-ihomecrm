#!/usr/bin/env node
// Gate: các "đảo strict" phải LUÔN 0 lỗi dưới `strict: true`, và danh sách đảo
// chỉ được PHÌNH RA, không được teo lại.
//
// VÌ SAO KHÔNG BẬT strict CHO CẢ REPO
//   Đo thật 07/08/2026: 246/337 file .ts đã sạch, 91 file còn lỗi. Bật toàn cục
//   là 91 file đỏ ngay, và cách duy nhất để CI xanh trở lại sẽ là tắt strict —
//   tức là đúng cái rule "bật strict mode" mà Contract §13 đã ghi nhận là SAI và
//   đã bỏ một lần rồi. Ratchet đi ngược lại: khoá phần đã sạch, để phần chưa sạch
//   dọn dần, và chặn đường thoái lui.
//
// VÌ SAO RATCHET LÀ TẬP TÊN FILE, KHÔNG PHẢI SỐ ĐẾM
//   Với số đếm, xoá một đảo rồi thêm một đảo khác là hoà — và cái bị xoá thường
//   là cái vừa đỏ. Repo này đã có án lệ đúng kiểu đó ở ratchet any-cast.
//
// ĐIỂM MÙ CÒN LẠI, ghi thẳng ra đây: gate này KHÔNG bắt được việc dập lỗi bằng
// `@ts-expect-error` / `@ts-nocheck` bên trong một đảo. Cửa chặn riêng cho việc
// đó là `npm run gate:ts-suppressions`; hai gate phải cùng chạy mới kín.
//
//   node scripts/check-strict-islands.mjs            # kiểm
//   node scripts/check-strict-islands.mjs --write    # chốt mức mới (chỉ khi TĂNG)
//
// Thoát: 0 đạt · 1 vi phạm · 3 không kiểm được.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSCONFIG = "tsconfig.strict-islands.json";
const BASELINE = join("tooling", "strict-islands-baseline.json");

/**
 * Sàn chống rỗng-vô-nghĩa.
 *
 * "0 lỗi strict" trên 3 file là câu đúng mà vô nghĩa. Nếu ai đó cắt include
 * xuống còn vài dòng VÀ chạy --write để hạ baseline theo, ratchet tập-tên không
 * còn gì để so. Con số này là mức đã đo được (246) trừ biên an toàn cho vài file
 * bị xoá/đổi tên hợp lệ.
 */
const TOI_THIEU_DAO = 200;

const doc = (p) => readFileSync(join(repoRoot, p), "utf8");

/**
 * Cờ phải CÓ HIỆU LỰC sau khi hợp nhất extends — không phải "có mặt trong file".
 *
 * Bản đầu của gate này chỉ đặt `strict: true` ở tsconfig con và tin rằng thế là
 * đủ. Không đủ: tsconfig.app.json đặt TƯỜNG MINH `noImplicitAny: false`, mà giá
 * trị tường minh của cha thắng cái mặc-định-suy-từ-`strict` của con. Nên "đảo
 * strict" chạy suốt mà KHÔNG hề bắt implicit any — đúng loại lỗi phổ biến nhất.
 * Đột biến "thêm tham số không kiểu vào một đảo" là thứ phát hiện ra, gate xanh.
 *
 * Vì vậy phép kiểm phải hỏi tsc kết quả HỢP NHẤT (`--showConfig`), không đọc
 * JSON bằng mắt.
 */
export const CO_BAT_BUOC = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/** Cờ bắt buộc mà giá trị hợp nhất không phải true. */
export function timCoBiTat(hopNhat) {
  return CO_BAT_BUOC.filter((k) => hopNhat[k] !== true);
}

/** Bỏ comment `//` và `/* *​/` để JSON.parse đọc được tsconfig (JSONC). */
export function doJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .trim();
}

/** Đảo = mọi entry include trừ file khai kiểu môi trường. */
export function locDao(include) {
  return include.map((p) => p.replace(/\\/g, "/")).filter((p) => !p.endsWith(".d.ts"));
}

/** Đảo có trong baseline mà KHÔNG còn trong include ⇒ thoái lui. */
export function timDaoBiRut(baseline, hienTai) {
  const co = new Set(hienTai);
  return baseline.filter((p) => !co.has(p)).sort();
}

function main() {
  const viet = process.argv.includes("--write");

  let include;
  try {
    include = JSON.parse(doJsonc(doc(TSCONFIG))).include;
  } catch (e) {
    console.error(`❌ Không đọc được ${TSCONFIG}: ${e.message}`);
    process.exit(3);
  }
  if (!Array.isArray(include) || include.length === 0) {
    console.error(`❌ ${TSCONFIG} không có mảng include — không kiểm được.`);
    process.exit(3);
  }

  const dao = locDao(include);

  // Đảo trỏ tới file không còn tồn tại: tsc lặng lẽ bỏ qua, nên tập đảo teo đi
  // mà không ai thấy. Bắt ở đây, KHÔNG để tsc quyết định.
  const mat = dao.filter((p) => !existsSync(join(repoRoot, p)));
  if (mat.length > 0) {
    console.error(`❌ ${mat.length} đảo trỏ tới file không tồn tại:`);
    for (const p of mat.slice(0, 15)) console.error(`   - ${p}`);
    console.error("   Xoá file thì phải xoá khỏi include VÀ baseline có chủ ý, không để trôi.");
    process.exit(1);
  }

  if (dao.length < TOI_THIEU_DAO) {
    console.error(`❌ Chỉ còn ${dao.length} đảo (sàn ${TOI_THIEU_DAO}) — phép đo hỏng hoặc danh sách bị cắt.`);
    console.error(`   "0 lỗi strict" trên vài file là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  // ---- Ratchet: baseline phải là TẬP CON của include ----
  let baseline = [];
  const baselinePath = join(repoRoot, BASELINE);
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8")).islands ?? [];
    } catch (e) {
      console.error(`❌ Không đọc được ${BASELINE}: ${e.message}`);
      process.exit(3);
    }
  }
  const biRut = timDaoBiRut(baseline, dao);

  // ---- Cờ strict phải CÒN HIỆU LỰC sau khi hợp nhất extends ----
  const cfg = spawnSync("npx", ["tsc", "--showConfig", "-p", TSCONFIG], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    timeout: 5 * 60 * 1000,
  });
  let hopNhat;
  try {
    hopNhat = JSON.parse(cfg.stdout).compilerOptions ?? {};
  } catch {
    console.error("❌ Không đọc được cấu hình hợp nhất từ `tsc --showConfig`.");
    console.error((cfg.stderr || cfg.stdout || "").slice(0, 600));
    process.exit(3);
  }
  const coBiTat = timCoBiTat(hopNhat);
  if (coBiTat.length > 0) {
    console.error(`❌ ${coBiTat.length} cờ strict KHÔNG còn hiệu lực sau khi hợp nhất extends:`);
    for (const k of coBiTat) console.error(`   - ${k} = ${JSON.stringify(hopNhat[k])}`);
    console.error("   Cha đặt tường minh sẽ thắng mặc-định-suy-từ-`strict` của con.");
    console.error("   Vùng khoá này không còn strict thật ⇒ mọi kết quả bên dưới là vô nghĩa.");
    process.exit(1);
  }

  // ---- Phép đo chính: tsc phải trả 0 lỗi ----
  // npx trên Windows là npx.cmd — Node từ chối spawn .cmd khi shell:false (vá
  // CVE-2024-27980), mà shell:true lại không bọc nháy đối số; đường dẫn repo này
  // có dấu cách nên phải dùng đường dẫn TƯƠNG ĐỐI. Cùng bẫy với ba gate khác.
  const r = spawnSync("npx", ["tsc", "-p", TSCONFIG, "--noEmit"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    timeout: 20 * 60 * 1000,
  });
  if (r.error) {
    console.error(`❌ Không chạy được tsc: ${r.error.message}`);
    process.exit(3);
  }
  const loi = (r.stdout || "").split(/\r?\n/).filter((l) => /error TS/.test(l));

  // tsc thoát khác 0 mà KHÔNG in dòng "error TS" nào = hỏng ở tầng khác (config
  // sai, hết bộ nhớ). Không được đọc là "có lỗi kiểu", cũng không được đọc là đạt.
  if (r.status !== 0 && loi.length === 0) {
    console.error(`❌ tsc thoát ${r.status} nhưng không in lỗi kiểu nào — hỏng ở tầng cấu hình.`);
    console.error((r.stderr || r.stdout || "").slice(0, 800));
    process.exit(3);
  }

  console.log(`Đảo strict: ${dao.length} file · baseline ${baseline.length} · lỗi ${loi.length}`);

  if (loi.length > 0) {
    console.error(`\n❌ ${loi.length} lỗi strict trong vùng đã khoá:`);
    for (const l of loi.slice(0, 25)) console.error("   " + l);
    if (loi.length > 25) console.error(`   … và ${loi.length - 25} dòng nữa`);
    console.error("\n  Sửa code cho sạch. KHÔNG gỡ file khỏi include để cho xanh —");
    console.error("  ratchet dưới đây chặn đúng đường thoát đó.");
    process.exitCode = 1;
  }

  if (biRut.length > 0) {
    console.error(`\n❌ ${biRut.length} đảo BỊ RÚT khỏi vùng khoá (thoái lui):`);
    for (const p of biRut.slice(0, 15)) console.error(`   - ${p}`);
    console.error("  Đã sạch rồi thì không được quay lại. Muốn rút thật phải sửa cả baseline có chủ ý.");
    process.exitCode = 1;
  }

  if (process.exitCode) process.exit(process.exitCode);

  const them = dao.filter((p) => !baseline.includes(p));
  if (viet) {
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          $comment:
            "Mức ratchet của đảo strict: TẬP TÊN FILE, không phải số đếm — với số đếm thì xoá một đảo rồi thêm đảo khác là hoà, mà cái bị xoá thường là cái vừa đỏ. Chốt mức mới: npm run gate:strict-islands -- --write",
          updatedAt: new Date().toISOString().slice(0, 10),
          islands: dao,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✅ Đã chốt baseline ở ${dao.length} đảo (+${them.length} so với trước).`);
    return;
  }

  if (them.length > 0) {
    console.log(`✅ 0 lỗi. Có ${them.length} đảo MỚI chưa chốt — chạy \`npm run gate:strict-islands -- --write\` để khoá lại.`);
  } else {
    console.log(`✅ 0 lỗi strict trên ${dao.length} đảo đã khoá.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
