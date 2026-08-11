#!/usr/bin/env node
// Gate: lỗ hổng phụ thuộc phải được PHÂN TẦNG THEO TẦM VỚI, và mỗi lỗ hổng còn
// sống phải có người ký nhận kèm HẠN.
//
// VÌ SAO KHÔNG DÙNG THẲNG `npm audit`
//   `npm audit` đếm advisory, không nói cái nào chạm được tới người dùng. Đo
//   11/08/2026: 19 advisory tổng, `--omit=dev` còn 13. Nhưng 8 trong 13 cái
//   "production" đó (brace-expansion, glob, minimatch, nanoid, picomatch,
//   postcss, yaml, và một phần lodash) chỉ tới được qua chuỗi
//   `tailwindcss-animate → tailwindcss → …`. Tailwind là công cụ BUILD; npm xếp
//   nó vào production chỉ vì `tailwindcss-animate` nằm trong `dependencies`.
//   Không một byte nào của chúng vào trình duyệt.
//
//   Hệ quả nếu tin con số trần: 13 "lỗ hổng production" đọc như 13 mối nguy cho
//   người dùng, trong khi con số thật nhỏ hơn nhiều — và cái NGUY THẬT bị chôn
//   lẫn trong đám không nguy. Gate đếm to mà chỉ sai chỗ thì tệ hơn không có
//   gate: nó dạy người đọc bỏ qua màu đỏ.
//
// BA TẦNG, ĐO ĐƯỢC
//   co-the-vao-bundle  Có trong cây production VÀ chuỗi phụ thuộc bắt đầu từ một
//                 gói mà `src/` thật sự import (kể cả `import()` động).
//                 CÓ THỂ, không phải CHẮC CHẮN: gate suy từ đồ thị phụ thuộc,
//                 mà tree-shaking cắt được nhánh không dùng. Đo 11/08/2026:
//                 `ws` bắt rễ từ `@supabase/supabase-js` nên rơi vào tầng này,
//                 nhưng không chunk nào trong `dist/` chứa dấu vết của nó —
//                 bản Node bị cắt sạch, trình duyệt dùng WebSocket sẵn có.
//                 Muốn biết CHẮC thì phải soi `dist/`, và điều đó cần một lượt
//                 build; gate này cố ý không phụ thuộc build để còn chạy được
//                 khi chưa build. Bằng chứng soi bundle ghi vào `lyDo` từng mục.
//   cai-dat-prod  Có trong cây production nhưng không gói gốc nào được `src/`
//                 import → nằm trên đĩa lúc build/deploy, không vào bundle.
//   chi-dev       Chỉ có trong cây đầy đủ → chạy trên máy dev và CI.
//
//   BẪY đã dính khi viết gate này: tìm `from 'xlsx'` trong `src/` ra 0 kết quả
//   nên suýt kết luận xlsx là phụ thuộc chết. Thật ra nó được nạp bằng
//   `import('xlsx')` ĐỘNG ở 5 file, và Vite tách thành chunk riêng
//   `dist/assets/xlsx-*.js` nặng 420KB. Bộ dò import ở đây bắt cả ba dạng
//   (`from`, `require`, `import()`), vì bỏ sót một dạng là hạ nhầm tầng của
//   đúng cái nguy hiểm nhất.
//
// RATCHET TRÊN TẬP, KHÔNG PHẢI SỐ ĐẾM
//   `tooling/dependency-audit-baseline.json` giữ TẬP vân tay `<tầng>|<gói>|<mức>`.
//   Đếm số thì vá một lỗ và nhận một lỗ mới sẽ hoà — gate im lặng trong khi bề
//   mặt tấn công đã đổi. Mỗi mục baseline bắt buộc có `lyDo` và `hetHan`; quá
//   hạn là đỏ, để "chấp nhận tạm" không âm thầm thành vĩnh viễn.
//
//   node scripts/check-dependency-audit.mjs
//   node scripts/check-dependency-audit.mjs --write   # ghi lại baseline
//
// PHẠM VI: chỉ lỗ hổng. Phần LICENSE của P2-24 chưa làm — chưa có chính sách
// license nào được chốt, và gate đoán chính sách thay người thì vô nghĩa.
//
// Thoát 0 · 1 khi có vân tay mới / baseline quá hạn / baseline thừa · 3 khi
// KHÔNG ĐO ĐƯỢC (mạng, npm lỗi, JSON hỏng, cây rỗng).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_BASELINE = join(repoRoot, 'tooling', 'dependency-audit-baseline.json');

/** Dưới ngần này gói trong cây thì phép đo hỏng, không phải "cây sạch". */
export const SAN_SO_GOI = 200;

export const TANG = {
  CO_THE_VAO_BUNDLE: 'co-the-vao-bundle',
  CAI_DAT_PROD: 'cai-dat-prod',
  CHI_DEV: 'chi-dev',
};

/** Tầng nào phải được ký nhận tường minh; tầng nào chỉ ghi nhận. */
export const TANG_BAT_BUOC_KY = new Set([TANG.CO_THE_VAO_BUNDLE, TANG.CAI_DAT_PROD]);

/**
 * Mọi gói mà `src/` nạp trực tiếp — `from 'x'`, `require('x')`, `import('x')`.
 * Bắt cả ba dạng vì Vite tách `import()` động thành chunk riêng: bỏ sót dạng
 * này là xếp nhầm một gói ĐANG chạy trên trình duyệt xuống tầng vô hại.
 */
export function goiDuocSrcNap(vanBanTheoFile) {
  const ra = new Set();
  const mau = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const noiDung of vanBanTheoFile) {
    for (const m of noiDung.matchAll(mau)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) continue;
      // `@scope/ten/sau` → `@scope/ten`; `ten/sau` → `ten`.
      const phan = spec.split('/');
      ra.add(spec.startsWith('@') ? phan.slice(0, 2).join('/') : phan[0]);
    }
  }
  return ra;
}

/**
 * Với mỗi gói trong cây, tập TÊN GÓI CẤP MỘT dẫn tới nó. Đi theo `dependencies`
 * lồng nhau của `npm ls --json`, ghi nhớ gốc của nhánh đang đi.
 */
export function gocCapMot(cayLs) {
  const theoGoi = new Map();
  const di = (nut, goc) => {
    for (const [ten, con] of Object.entries(nut?.dependencies ?? {})) {
      const g = goc ?? ten;
      if (!theoGoi.has(ten)) theoGoi.set(ten, new Set());
      theoGoi.get(ten).add(g);
      di(con, g);
    }
  };
  di(cayLs, null);
  return theoGoi;
}

/** Xếp tầng cho một gói có lỗ hổng. */
export function xepTang(ten, { trongCayProd, gocProd, srcNap }) {
  if (!trongCayProd.has(ten)) return TANG.CHI_DEV;
  const goc = gocProd.get(ten) ?? new Set();
  for (const g of goc) if (srcNap.has(g)) return TANG.CO_THE_VAO_BUNDLE;
  return TANG.CAI_DAT_PROD;
}

export const vanTay = (tang, ten, muc) => `${tang}|${ten}|${muc}`;

/**
 * So tập hiện tại với baseline. Ba loại lệch, mỗi loại một nghĩa khác nhau:
 * `moi` = bề mặt tấn công vừa rộng ra; `thua` = đã vá, phải bỏ khỏi baseline
 * kẻo nó che lần tái phát sau; `hetHan` = lời hứa "tạm chấp nhận" đã quá hạn.
 */
export function soSanhBaseline(hienTai, baseline, nowMs) {
  const cheDo = new Map(baseline.map((b) => [b.vanTay, b]));
  const moi = hienTai.filter((v) => !cheDo.has(v));
  const thua = baseline.filter((b) => !hienTai.includes(b.vanTay)).map((b) => b.vanTay);
  const hetHan = baseline
    .filter((b) => hienTai.includes(b.vanTay))
    .filter((b) => {
      const t = Date.parse(b.hetHan);
      return Number.isNaN(t) || t < nowMs;
    })
    .map((b) => b.vanTay);
  return { moi, thua, hetHan };
}

function chayNpm(args) {
  // `npm audit` thoát khác 0 khi CÓ lỗ hổng — đó là kết quả bình thường, không
  // phải lỗi chạy. Chỉ coi là hỏng khi stdout không parse được thành JSON.
  let out;
  try {
    out = execFileSync('npm', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (e) {
    out = String(e.stdout ?? '');
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function docSrc() {
  const ra = [];
  const di = (thuMuc) => {
    for (const e of readdirSync(thuMuc, { withFileTypes: true })) {
      const p = join(thuMuc, e.name);
      if (e.isDirectory()) di(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) ra.push(readFileSync(p, 'utf8'));
    }
  };
  di(join(repoRoot, 'src'));
  return ra;
}

function main() {
  const ghi = process.argv.includes('--write');

  const auditDay = chayNpm(['audit', '--json']);
  const auditProd = chayNpm(['audit', '--json', '--omit=dev']);
  const lsProd = chayNpm(['ls', '--omit=dev', '--all', '--json']);

  if (!auditDay || !auditProd || !lsProd) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: npm không trả JSON đọc được.');
    console.error('   Thường là mất mạng hoặc registry chặn — đừng đọc thành "không có lỗ hổng".');
    process.exit(3);
  }

  const soGoi = auditDay.metadata?.dependencies?.total ?? 0;
  if (soGoi < SAN_SO_GOI) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${soGoi} gói trong cây (sàn ${SAN_SO_GOI}).`);
    console.error('   node_modules chưa cài đủ — kết quả "sạch" ở đây là rỗng, không phải an toàn.');
    process.exit(3);
  }

  const gocProd = gocCapMot(lsProd);
  const trongCayProd = new Set(gocProd.keys());
  const srcNap = goiDuocSrcNap(docSrc());
  if (srcNap.size === 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: không dò được import nào trong src/ — bộ dò hỏng.');
    process.exit(3);
  }

  const loHong = auditDay.vulnerabilities ?? {};
  const ten = Object.keys(loHong);
  if (ten.length === 0 && (auditProd.metadata?.vulnerabilities?.total ?? 0) > 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: audit đầy đủ trả 0 lỗ hổng nhưng audit production lại có.');
    process.exit(3);
  }

  const theoTang = { [TANG.CO_THE_VAO_BUNDLE]: [], [TANG.CAI_DAT_PROD]: [], [TANG.CHI_DEV]: [] };
  const hienTai = [];
  for (const t of ten.sort()) {
    const muc = loHong[t].severity;
    const tang = xepTang(t, { trongCayProd, gocProd, srcNap });
    theoTang[tang].push({ ten: t, muc, goc: [...(gocProd.get(t) ?? [])] });
    if (TANG_BAT_BUOC_KY.has(tang)) hienTai.push(vanTay(tang, t, muc));
  }

  console.log(`Đã soi ${soGoi} gói · ${ten.length} advisory · ${srcNap.size} gói được src/ nạp\n`);
  for (const [tang, ds] of Object.entries(theoTang)) {
    console.log(`  ${tang}: ${ds.length}`);
    for (const d of ds) {
      const qua = d.goc.length && !srcNap.has(d.ten) ? ` (qua ${d.goc.join(', ')})` : '';
      console.log(`     ${d.muc.padEnd(8)} ${d.ten}${qua}`);
    }
  }
  console.log('');

  if (ghi) {
    const cu = existsSync(FILE_BASELINE)
      ? JSON.parse(readFileSync(FILE_BASELINE, 'utf8')).chapNhan ?? []
      : [];
    const theoVanTay = new Map(cu.map((b) => [b.vanTay, b]));
    const moi = hienTai.map(
      (v) => theoVanTay.get(v) ?? { vanTay: v, lyDo: 'CHƯA GIẢI TRÌNH — điền trước khi commit', hetHan: '' },
    );
    writeFileSync(
      FILE_BASELINE,
      JSON.stringify({ $comment: 'Xem đầu scripts/check-dependency-audit.mjs', chapNhan: moi }, null, 2) + '\n',
    );
    console.log(`✅ Đã ghi ${moi.length} vân tay vào ${FILE_BASELINE}`);
    return;
  }

  if (!existsSync(FILE_BASELINE)) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: thiếu ${FILE_BASELINE}. Chạy với --write để tạo.`);
    process.exit(3);
  }
  // Baseline hỏng là KHÔNG ĐO ĐƯỢC, không phải VI PHẠM. Để `JSON.parse` ném ra
  // thì Node thoát 1 — đọc y hệt "có lỗ hổng mới", và người sửa sẽ đi tìm lỗ
  // hổng không tồn tại thay vì sửa file hỏng.
  let baseline;
  try {
    const doc = JSON.parse(readFileSync(FILE_BASELINE, 'utf8'));
    baseline = doc.chapNhan;
    if (!Array.isArray(baseline)) throw new Error('thiếu mảng `chapNhan`');
  } catch (e) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: ${FILE_BASELINE} không đọc được — ${e.message}`);
    process.exit(3);
  }
  const chuaGiaiTrinh = baseline.filter((b) => !b.lyDo || !b.hetHan);
  const { moi, thua, hetHan } = soSanhBaseline(hienTai, baseline, Date.now());

  const van = [];
  for (const v of moi) van.push(`MỚI, chưa ai ký nhận: ${v}`);
  for (const v of hetHan) van.push(`QUÁ HẠN — ký nhận đã hết hiệu lực: ${v}`);
  for (const v of thua) van.push(`ĐÃ VÁ, phải bỏ khỏi baseline kẻo che lần tái phát: ${v}`);
  for (const b of chuaGiaiTrinh) van.push(`THIẾU lyDo hoặc hetHan: ${b.vanTay}`);

  if (van.length > 0) {
    console.error(`❌ ${van.length} vấn đề:\n`);
    for (const v of van) console.error(`  - ${v}`);
    console.error('\n  Sửa baseline bằng tay (kèm lyDo + hetHan), hoặc --write rồi điền.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ ${hienTai.length} lỗ hổng chạm production đều có ký nhận còn hạn ` +
    `· ${theoTang[TANG.CHI_DEV].length} lỗ hổng chỉ-dev không cần ký.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
