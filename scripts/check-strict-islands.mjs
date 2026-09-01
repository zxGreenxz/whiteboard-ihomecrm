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

/**
 * Bảng đảo. Mỗi dòng là một VÙNG KHOÁ với mức cờ riêng.
 *
 * VÌ SAO NHIỀU TẦNG CHỨ KHÔNG MỘT
 *   `noUncheckedIndexedAccess` đắt hơn hẳn phần còn lại của `strict`: đo
 *   12/08/2026 trên đúng 1025 file của tầng 1 thì nó thêm **953 lỗi** — gấp
 *   nhiều lần toàn bộ chi phí mở tầng 1. Nhét nó vào tầng 1 là ép chọn giữa
 *   "khoá 1025 file ở mức thấp" và "khoá vài trăm file ở mức cao". Hai tầng cho
 *   cả hai, và mỗi tầng vẫn là ratchet một chiều của riêng nó.
 *
 * `conCua` giữ bất biến: tầng con phải là TẬP CON của tầng cha. Không có nó thì
 * một file có thể rơi khỏi tầng 1 mà vẫn nằm ở tầng 2, và câu "tầng 2 nghiêm hơn
 * tầng 1" thành sai mà không ai thấy.
 */
export const DAO = [
  {
    ten: "strict",
    tsconfig: "tsconfig.strict-islands.json",
    baseline: join("tooling", "strict-islands-baseline.json"),
    /**
     * Sàn chống rỗng-vô-nghĩa: "0 lỗi strict" trên 3 file là câu đúng mà vô
     * nghĩa. Mức đã đo (1023) trừ biên cho vài file bị xoá/đổi tên hợp lệ.
     */
    toiThieu: 900,
    coThem: [],
    conCua: null,
  },
  {
    ten: "strict+noUncheckedIndexedAccess",
    tsconfig: "tsconfig.strict-islands-nuia.json",
    baseline: join("tooling", "strict-islands-nuia-baseline.json"),
    toiThieu: 500,
    coThem: ["noUncheckedIndexedAccess"],
    conCua: "tsconfig.strict-islands.json",
  },
];

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

/** Cờ bắt buộc mà giá trị hợp nhất không phải true. `coThem` là cờ riêng của tầng. */
export function timCoBiTat(hopNhat, coThem = []) {
  return [...CO_BAT_BUOC, ...coThem].filter((k) => hopNhat[k] !== true);
}

/**
 * Đảo con phải nằm gọn trong đảo cha.
 *
 * Trả về danh sách file có ở CON mà không có ở CHA — mỗi cái là một chỗ câu
 * "tầng dưới nghiêm hơn tầng trên" bị phá: file đó đang bị khoá ở mức cao mà
 * không hề bị khoá ở mức thấp, nên gỡ nó khỏi tầng cha sẽ không ai báo.
 */
export function timConNgoaiCha(daoCon, daoCha) {
  const cha = new Set(daoCha);
  return daoCon.filter((p) => !cha.has(p)).sort();
}

/** Bỏ comment `//` và `/* *​/` để JSON.parse đọc được tsconfig (JSONC). */
export function doJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .trim();
}

/** Đọc danh sách đảo từ `files` hoặc `include` mà không để tsc tự mở rộng glob. */
export function docDao(text) {
  const config = JSON.parse(doJsonc(text));
  const entries = Array.isArray(config.files) ? config.files : config.include;
  return Array.isArray(entries) ? entries : [];
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

function kiemMotDao(caiDao, viet) {
  const TSCONFIG = caiDao.tsconfig;
  const BASELINE = caiDao.baseline;
  const TOI_THIEU_DAO = caiDao.toiThieu;
  console.log(`\n── Đảo "${caiDao.ten}" · ${TSCONFIG}`);

  let include;
  try {
    include = docDao(doc(TSCONFIG));
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
  let banHopNhat;
  try {
    banHopNhat = JSON.parse(cfg.stdout);
    hopNhat = banHopNhat.compilerOptions ?? {};
  } catch {
    console.error("❌ Không đọc được cấu hình hợp nhất từ `tsc --showConfig`.");
    console.error((cfg.stderr || cfg.stdout || "").slice(0, 600));
    process.exit(3);
  }

  // ---- Root set của tsc phải LÀ danh sách đảo ----
  // `files` của con KHÔNG ghi đè `include` của cha (extends chỉ đè khoá CÙNG TÊN).
  // 31/08/2026: hai tsconfig đảo đổi include→files, include:["src"] của
  // tsconfig.app.json sống lại, tsc lặng lẽ đo 1297 file thay vì 603 — tầng NUIA
  // đỏ 1101 lỗi mà 0 lỗi nào thuộc vùng khoá. Mọi kết quả đo trên root set sai
  // đều vô nghĩa (kể cả ratchet --write), nên khẳng định TRƯỚC khi đo.
  const chuanHoa = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const includeHopNhat = Array.isArray(banHopNhat.include) ? banHopNhat.include : [];
  if (includeHopNhat.length > 0) {
    console.error(`❌ Cấu hình hợp nhất còn include=${JSON.stringify(includeHopNhat)} — vùng khoá không còn là vùng khoá.`);
    console.error(`   Thêm "include": [] vào ${TSCONFIG} để chặn include kế thừa qua extends.`);
    process.exit(1);
  }
  const rootSet = new Set((Array.isArray(banHopNhat.files) ? banHopNhat.files : []).map(chuanHoa));
  const khai = new Set(include.map(chuanHoa));
  const thua = [...rootSet].filter((p) => !khai.has(p));
  const thieu = [...khai].filter((p) => !rootSet.has(p));
  if (thua.length > 0 || thieu.length > 0) {
    console.error(`❌ tsc đang đo ${rootSet.size} file nhưng danh sách đảo khai ${khai.size} — vùng khoá không còn là vùng khoá.`);
    for (const p of thua.slice(0, 10)) console.error(`   + ngoài danh sách: ${p}`);
    for (const p of thieu.slice(0, 10)) console.error(`   - khai mà không đo: ${p}`);
    process.exit(1);
  }
  // ---- Đảo con phải nằm gọn trong đảo cha ----
  if (caiDao.conCua) {
    let daoCha;
    try {
      daoCha = locDao(docDao(doc(caiDao.conCua)));
    } catch (e) {
      console.error(`❌ Không đọc được đảo cha ${caiDao.conCua}: ${e.message}`);
      process.exit(3);
    }
    const ngoai = timConNgoaiCha(dao, daoCha);
    if (ngoai.length > 0) {
      console.error(`❌ ${ngoai.length} file ở đảo "${caiDao.ten}" mà KHÔNG có trong đảo cha ${caiDao.conCua}:`);
      for (const p of ngoai.slice(0, 15)) console.error(`   - ${p}`);
      console.error("   Tầng con phải nghiêm hơn tầng cha, nên nó phải là TẬP CON.");
      console.error("   Ngược lại thì gỡ file khỏi tầng cha sẽ không ai báo.");
      process.exit(1);
    }
  }

  const coBiTat = timCoBiTat(hopNhat, caiDao.coThem);
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

  console.log(`   ${dao.length} file · baseline ${baseline.length} · lỗi ${loi.length}`);

  if (loi.length > 0) {
    console.error(`\n❌ ${loi.length} lỗi trong vùng đã khoá "${caiDao.ten}":`);
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
          $comment: `Mức ratchet của đảo "${caiDao.ten}": TẬP TÊN FILE, không phải số đếm — với số đếm thì xoá một đảo rồi thêm đảo khác là hoà, mà cái bị xoá thường là cái vừa đỏ. Chốt mức mới: npm run gate:strict-islands -- --write`,
          updatedAt: new Date().toISOString().slice(0, 10),
          islands: dao,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`   ✅ Đã chốt baseline ở ${dao.length} đảo (+${them.length} so với trước).`);
    return;
  }

  if (them.length > 0) {
    console.log(`   ✅ 0 lỗi. Có ${them.length} đảo MỚI chưa chốt — chạy \`npm run gate:strict-islands -- --write\` để khoá lại.`);
  } else {
    console.log(`   ✅ 0 lỗi trên ${dao.length} đảo đã khoá.`);
  }
}

function main() {
  const viet = process.argv.includes("--write");
  // Chống-xanh-rỗng ở mức BẢNG: bảng rỗng thì vòng lặp không chạy lần nào và
  // gate im lặng trả 0 — đúng kiểu "xanh vì không đo gì".
  if (DAO.length === 0) {
    console.error("❌ Bảng đảo rỗng — không có vùng nào để kiểm.");
    process.exit(3);
  }
  for (const caiDao of DAO) kiemMotDao(caiDao, viet);
  console.log(`\n✅ ${DAO.length} đảo đều đạt.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
