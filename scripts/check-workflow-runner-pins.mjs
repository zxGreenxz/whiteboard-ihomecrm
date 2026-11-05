#!/usr/bin/env node
// Gate: mọi `runs-on` của workflow phải ghim ảnh cụ thể, không dùng nhãn trôi `*-latest`.
//
// VÌ SAO CẦN
//   `ubuntu-latest` không phải một ảnh mà là con trỏ GitHub tự dời. Khoảng 01:00 UTC 05/11/2026 nó chuyển từ
//   ubuntu-24.04 sang ubuntu-26.04 (không có PostgreSQL, không có setup-python 3.12.10) và làm đỏ quality-gates của
//   main lẫn mọi PR dù không đổi dòng mã nào; PR #394 phải ghim tay 19 chỗ. Contract §4: hạ tầng ghim exact
//   runtime/image. Một nhãn trôi mới lọt vào chỉ lộ ra ở lần GitHub dời con trỏ kế tiếp — gate chặn ngay lúc viết.
//
// PHẠM VI
//   Mọi file .yml/.yaml dưới .github/workflows và .github/actions (nếu có), mọi khoá `runs-on` ở độ sâu bất kỳ.
//   Bắt được:
//     - nhãn đơn, mảng nhãn, `{ group, labels }`;
//     - nhãn nằm trong biểu thức: `${{ cond && 'ubuntu-latest' || 'ubuntu-24.04' }}`;
//     - `${{ matrix.os }}` / `matrix['os']`: đọc đúng khoá đó trong `strategy.matrix` của job, kể cả `include`.
//   GitHub không phân biệt hoa thường với tên context, tên hàm và tên khoá matrix (`Matrix.os`, `Vars.X`, `FromJson(…)` chạy
//   y như viết thường), nên gate đọc chúng cũng không phân biệt.
//   Nhãn không nằm NGUYÊN VẸN trong file thì KHÔNG chứng minh được đã ghim, và gate coi đó là lỗi (mã 1) chứ không lặng im:
//     - đến từ ngoài file: `vars` / `needs` / `inputs` / `secrets` / `github.event.client_payload` /
//       `fromJSON(<không phải chuỗi cố định>)`, hoặc matrix động hay thiếu khoá;
//     - ghép lúc chạy từ nhiều mảnh: `format(…)`, `join(…)`, chữ dính liền trước/sau `${{ }}` (`ubuntu-${{ 'latest' }}`),
//       hay nhiều `${{ }}` trong một nhãn;
//     - nằm trong workflow dùng chung ở repo khác (`jobs.<id>.uses: owner/repo/….yml@ref`): bên kia chọn runner.
//   Muốn chọn runner theo điều kiện thì viết cả hai nhãn cụ thể ngay trong biểu thức; muốn dùng workflow dùng chung thì
//   đặt nó cùng repo (`uses: ./.github/workflows/…`), gate quét cả file đó.
//   Chưa bắt được: gate nhận nguồn ngoài theo tên, không phân tích dòng dữ liệu của biểu thức — trường chữ tự do của
//   `github.*` (head_ref, event.*.title…) đặt thẳng làm nhãn vẫn lọt; `github.*` chỉ nên làm điều kiện.
//
//   node scripts/check-workflow-runner-pins.mjs [--root <thư mục gốc repo>]
//
// Mã thoát: 0 = mọi runs-on đã ghim; 1 = có runs-on trôi hoặc không chứng minh được; 3 = không đo được
// (không parse được file, không thấy workflow nào, hoặc không thấy runs-on nào mà cũng không có gì để báo —
// xanh rỗng là gate nói dối).
// Không cần credential, không đọc database.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const THU_MUC_WORKFLOW = '.github/workflows';
export const THU_MUC_QUET = [THU_MUC_WORKFLOW, '.github/actions'];

/** Nhãn trôi = có đoạn `-latest` đứng riêng: ubuntu-latest, windows-latest, macos-latest-large… Không phân biệt hoa thường. */
export const laNhanTroi = (nhan) => /-latest(?:-|$)/i.test(nhan);

/** Mọi nhãn trôi trong một chuỗi, kể cả khi chuỗi là biểu thức `${{ c && 'ubuntu-latest' || 'ubuntu-24.04' }}`. */
export const timNhanTroi = (chuoi) => (String(chuoi).match(/[\w.-]+/g) ?? []).filter(laNhanTroi);

// Biểu thức `${{ … }}`. Cắt ở `}}` đầu tiên, kể cả `}}` nằm trong chuỗi cố định (`'{"a":{"b":1}}'`): phần còn lại bị tính là chữ
// dính liền và báo đỏ (an toàn). Không đọc theo nháy đơn vì regex lồng nháy backtrack theo cấp số nhân.
const BIEU_THUC = /\$\{\{([\s\S]*?)\}\}/g;
// Chuỗi cố định trong biểu thức dùng nháy đơn; nháy đơn bên trong viết đôi `''`.
const CHUOI_CO_DINH = /'(?:[^']|'')*'/g;
// Khoá viết trong ngoặc vuông (`github.event['client_payload']`) giấu tên khoá trong chuỗi cố định: đọc như `.khoá` trước khi che chuỗi.
const KHOA_NGOAC = /\[\s*'((?:[^']|'')*)'\s*\]/g;
// Các regex đọc tên context / tên hàm dưới đây (và `\bmatrix\b` trong danhGiaRunsOn) đều có cờ `i`: GitHub không phân biệt hoa thường.
// Nhãn đến từ NGOÀI file: biến repo, output job khác, input gọi vào, secret, payload của repository_dispatch, JSON dựng lúc chạy.
// `fromJSON('[…]')` với chuỗi cố định thì nhãn vẫn nằm trong file nên không bị loại.
const NGUON_NGOAI = /\b(?:vars|needs|inputs|secrets|client_payload)\b|\bfromJSON\s*\(\s*(?!')/i;
// Nhãn ghép lúc chạy từ nhiều mảnh: `format('ubuntu-{0}', 'latest')`, `join(fromJSON('["ubuntu","latest"]'), '-')`.
const GHEP_CHUOI = /\b(?:format|join)\s*\(/i;
const THAM_CHIEU_MATRIX = /\bmatrix\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*'([^']+)'\s*\])/gi;

/** Mọi chuỗi lá trong một giá trị YAML (chuỗi, mảng, mapping lồng nhau). */
function gomChuoi(nut, ra = []) {
  if (typeof nut === 'string') ra.push(nut);
  else if (Array.isArray(nut)) for (const v of nut) gomChuoi(v, ra);
  else if (nut && typeof nut === 'object') for (const v of Object.values(nut)) gomChuoi(v, ra);
  return ra;
}

/** Mọi giá trị của khoá `khoa` trong một mapping, không phân biệt hoa thường: context `matrix` của GitHub tra khoá không phân biệt hoa thường. */
const giaTriKhoa = (muc, khoa) => (muc && typeof muc === 'object' && !Array.isArray(muc)
  ? Object.entries(muc).filter(([k]) => k.toLowerCase() === khoa.toLowerCase()).map(([, v]) => v)
  : []);

/**
 * Chuỗi mà `matrix.<khoa>` có thể nhận trong một job; `khoa = null` = cả matrix.
 * `dong` = có phần chỉ biết lúc chạy (matrix là biểu thức, giá trị là biểu thức) hoặc khoá không được khai.
 */
function giaiMatrix(matrix, khoa) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return { chuoi: [], dong: true };
  const include = matrix.include;
  const nguon = khoa === null
    ? [matrix]
    : [...giaTriKhoa(matrix, khoa), ...(Array.isArray(include) ? include.flatMap((muc) => giaTriKhoa(muc, khoa)) : [])];
  const chuoi = gomChuoi(nguon);
  const dong = typeof include === 'string' || chuoi.some((c) => c.includes('${{'))
    || (khoa !== null && nguon.length === 0);
  return { chuoi, dong };
}

/**
 * Đánh giá MỘT giá trị `runs-on`.
 * `job` là mapping chứa nó — nơi tìm `strategy.matrix`.
 * Trả mảng lỗi: `{ loai: 'troi', nhan, nguon? }` hoặc `{ loai: 'ngoai', chiTiet }` (nguồn ngoài file, ghép lúc chạy,
 * matrix không xác định được); rỗng = đã ghim.
 */
export function danhGiaRunsOn(runsOn, job = {}) {
  const loi = [];
  for (const chuoi of gomChuoi(runsOn)) {
    for (const nhan of timNhanTroi(chuoi)) loi.push({ loai: 'troi', nhan });
    const doan = [...chuoi.matchAll(BIEU_THUC)];
    // Chữ dính liền trước/sau `${{ }}` hoặc nhiều `${{ }}` trong một nhãn ⇒ nhãn được ghép lúc chạy, không còn nguyên vẹn trong file.
    if (doan.length > 1 || (doan.length === 1 && chuoi.replace(BIEU_THUC, '').trim() !== '')) {
      loi.push({ loai: 'ngoai', chiTiet: `nhãn ghép lúc chạy từ nhiều mảnh: ${chuoi.trim()}` });
    }
    for (const [, bieuThuc] of doan) {
      const nguyen = '${{ ' + bieuThuc.trim() + ' }}';
      const daChe = bieuThuc.replace(KHOA_NGOAC, '.$1').replace(CHUOI_CO_DINH, "''");
      if (NGUON_NGOAI.test(daChe)) loi.push({ loai: 'ngoai', chiTiet: nguyen });
      if (GHEP_CHUOI.test(daChe)) loi.push({ loai: 'ngoai', chiTiet: `ghép nhãn lúc chạy bằng format/join: ${nguyen}` });
      const khoa = [...bieuThuc.matchAll(THAM_CHIEU_MATRIX)].map((m) => m[1] ?? m[2]);
      // `matrix` đứng riêng hoặc tra khoá tính lúc chạy (`matrix[github.event_name]`, `toJSON(matrix)`) ⇒ xét cả matrix.
      if (/\bmatrix\b/i.test(bieuThuc.replace(THAM_CHIEU_MATRIX, ' ').replace(CHUOI_CO_DINH, "''"))) khoa.push(null);
      for (const k of new Set(khoa)) {
        const { chuoi: giaTri, dong } = giaiMatrix(job?.strategy?.matrix, k);
        for (const nhan of giaTri.flatMap(timNhanTroi)) {
          loi.push({ loai: 'troi', nhan, nguon: k === null ? 'strategy.matrix' : `matrix.${k}` });
        }
        if (dong) loi.push({ loai: 'ngoai', chiTiet: `matrix.${k ?? '*'} không xác định được từ file (matrix động hoặc thiếu khoá)` });
      }
    }
  }
  return [...new Map(loi.map((l) => [JSON.stringify(l), l])).values()];
}

/**
 * Mọi khoá `runs-on` trong một tài liệu YAML đã parse, ở độ sâu bất kỳ.
 * Chỉ khoá thật: `runs-on` nằm trong chuỗi (`run: echo "runs-on: …"`) hay comment không phải khoá nên không bị tính.
 */
export function* duyetRunsOn(nut, duong = []) {
  if (Array.isArray(nut)) {
    for (let i = 0; i < nut.length; i += 1) yield* duyetRunsOn(nut[i], [...duong, i]);
  } else if (nut && typeof nut === 'object') {
    for (const [khoa, giaTri] of Object.entries(nut)) {
      if (khoa === 'runs-on') yield { duong: [...duong, khoa], runsOn: giaTri, job: nut };
      else yield* duyetRunsOn(giaTri, [...duong, khoa]);
    }
  }
}

/**
 * Job gọi workflow dùng chung ở repo khác (`jobs.<id>.uses: owner/repo/.github/workflows/x.yml@ref`): runner do workflow
 * đó chọn nên file này không chứng minh được gì. `uses: ./.github/workflows/x.yml` (cùng repo) không tính vì file đó
 * nằm trong cây được quét; `uses` của bước (`steps[*].uses`, một action) không chọn runner nên cũng không tính.
 */
export function* duyetUsesNgoai(doc) {
  const jobs = doc && typeof doc === 'object' ? doc.jobs : null;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return;
  for (const [id, job] of Object.entries(jobs)) {
    const uses = job && typeof job === 'object' ? job.uses : null;
    if (typeof uses === 'string' && !uses.trim().startsWith('./')) yield { duong: ['jobs', id, 'uses'], uses: uses.trim() };
  }
}

function* fileYaml(thuMuc) {
  const muc = readdirSync(thuMuc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const m of muc) {
    const duong = join(thuMuc, m.name);
    if (m.isDirectory()) yield* fileYaml(duong);
    else if (/\.ya?ml$/i.test(m.name)) yield duong;
  }
}

/**
 * Quét `.github/workflows` và `.github/actions` (nếu có) dưới `goc`.
 * Trả `{ soFile, soRunsOn, loi, khongDo }`: `loi` là runs-on trôi / không chứng minh được (kể cả job gọi workflow ở repo
 * khác), `khongDo` là việc đo hỏng.
 */
export function quetThuMuc(goc = repoRoot) {
  const ketQua = { soFile: 0, soRunsOn: 0, loi: [], khongDo: [] };
  if (!existsSync(join(goc, THU_MUC_WORKFLOW))) {
    ketQua.khongDo.push(`không thấy thư mục ${THU_MUC_WORKFLOW} dưới ${goc}`);
    return ketQua;
  }
  for (const thuMuc of THU_MUC_QUET.filter((d) => existsSync(join(goc, d)))) {
    for (const file of fileYaml(join(goc, thuMuc))) {
      const ten = relative(goc, file).replace(/\\/g, '/');
      let tailieu;
      try {
        tailieu = yaml.loadAll(readFileSync(file, 'utf8'));
      } catch (error) {
        ketQua.khongDo.push(`${ten}: không parse được YAML (${String(error.message).split('\n')[0]})`);
        continue;
      }
      ketQua.soFile += 1;
      for (const doc of tailieu) {
        for (const { duong, runsOn, job } of duyetRunsOn(doc)) {
          ketQua.soRunsOn += 1;
          for (const l of danhGiaRunsOn(runsOn, job)) ketQua.loi.push({ file: ten, viTri: duong.join('.'), ...l });
        }
        for (const { duong, uses } of duyetUsesNgoai(doc)) {
          ketQua.loi.push({
            file: ten,
            viTri: duong.join('.'),
            loai: 'ngoai',
            chiTiet: `job gọi workflow ở repo khác, runner do bên kia chọn (dùng \`./.github/workflows/…\` cùng repo): ${uses}`,
          });
        }
      }
    }
  }
  return ketQua;
}

const moTa = (l) => (l.loai === 'troi'
  ? `nhãn trôi \`${l.nhan}\`${l.nguon ? ` (từ ${l.nguon})` : ''}`
  : `không chứng minh được đã ghim — ${l.chiTiet}`);

function layGoc(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return repoRoot;
  if (!argv[i + 1]) {
    console.error('❌ --root cần một đường dẫn.');
    process.exit(3);
  }
  return resolve(argv[i + 1]);
}

function main() {
  const { soFile, soRunsOn, loi, khongDo } = quetThuMuc(layGoc(process.argv));
  if (khongDo.length > 0) {
    for (const k of khongDo) console.error(`❌ KHÔNG ĐO ĐƯỢC: ${k}`);
    process.exit(3);
  }
  // Có gì bị báo (vd job gọi workflow ở repo khác, vốn không có runs-on) thì phép đo vẫn chạy: báo lỗi, không phải "không đo được".
  if (soFile === 0 || (soRunsOn === 0 && loi.length === 0)) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: đọc ${soFile} file YAML nhưng thấy ${soRunsOn} runs-on — phép đo hỏng, không phải "không có gì để kiểm".`);
    process.exit(3);
  }
  if (loi.length > 0) {
    console.error(`❌ ${loi.length} runs-on chưa ghim ảnh cụ thể:\n`);
    for (const l of loi) console.error(`  - ${l.file} › ${l.viTri}: ${moTa(l)}`);
    console.error('\n  → `*-latest` là con trỏ GitHub tự dời (05/11/2026: ubuntu-latest sang 26.04, thiếu PostgreSQL ⇒ CI cả repo đỏ, PR #394).');
    console.error('    Ghim ảnh cụ thể (vd ubuntu-24.04, windows-2025-vs2026) đúng dòng `Image:` ở log job; nhãn hợp lệ nằm trong README actions/runner-images.');
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${soRunsOn} runs-on trong ${soFile} file YAML đều ghim ảnh cụ thể.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
