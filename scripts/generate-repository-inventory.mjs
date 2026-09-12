#!/usr/bin/env node
// Kiểm kê: test nào ĐỌC FILE NGUỒN bằng fs thay vì import nó.
//
// VÌ SAO CẦN (plan §51, chặn §0.2/C10)
//   Một test đọc `src/App.tsx` rồi khẳng định trên VĂN BẢN của nó không kiểm hành
//   vi — nó kiểm cách viết. Refactor không đổi hành vi vẫn làm nó đỏ; tệ hơn,
//   refactor có đổi hành vi vẫn để nó xanh nếu chuỗi được tìm còn nguyên. Repo này
//   đã có hai ca `not.toContain` trên App.tsx trở thành rỗng nghĩa sau khi route
//   dời đi nơi khác — assertion vẫn xanh, và nó xanh vì không còn gì để tìm.
//
//   Việc chuyển chúng sang data-driven cần biết CHÚNG LÀ NHỮNG FILE NÀO trước đã.
//   Cho tới nay chưa có công cụ nào liệt kê, nên con số "86 file" trong plan là
//   một lần đếm tay không ai lặp lại được.
//
// PHÉP ĐO NÀY CÓ GIỚI HẠN, VÀ NÓ NÓI RA
//   255/302 lời gọi readFileSync dùng BIẾN chứ không phải chuỗi (đo 11/08/2026),
//   nên quét chữ thuần mù 84%. Script giải biến trong cùng file (tối đa 3 tầng) và
//   ĐẾM RIÊNG phần không giải được. Con số "không phân loại được" là một phần của
//   kết quả, không phải thứ để làm tròn xuống.
//
//   node scripts/generate-repository-inventory.mjs            # in tóm tắt
//   node scripts/generate-repository-inventory.mjs --write    # ghi docs/generated/
//   node scripts/generate-repository-inventory.mjs --json
//   node scripts/generate-repository-inventory.mjs --check [--nguon-index]
//
// Stage input test của task trước khi chạy. JSON đo blob trong index; WIP chỉ cảnh báo.
// Thoát 0 · 1 khi JSON cũ · 3 khi thiếu input/artifact hoặc Git hỏng.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(repoRoot, 'docs', 'generated', 'repository-inventory.json');

const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/;
const BO_QUA = [/node_modules/, /zalouser-bridge[\\/]upstream[\\/]/];

/** Phân loại theo thứ tự NGHIÊM → NHẸ; ca đầu tiên khớp là kết luận. */
const LOAI = [
  ['ma-nguon', /\.(tsx?|mjs|cjs|jsx)\b/, 'Đọc mã nguồn rồi khẳng định trên văn bản — thứ cần chuyển sang data-driven.'],
  ['sql', /\.sql\b/, 'Đọc migration/SQL. Thường hợp lệ: SQL không import được, và nội dung CHÍNH LÀ hợp đồng.'],
  ['powershell', /\.ps1\b/, 'Đọc script PowerShell. Hợp lệ vì lý do như SQL.'],
  ['manifest', /\.(json|ya?ml|toml)\b/, 'Đọc manifest/cấu hình. Hợp lệ: đây đúng là dữ liệu, và lệch manifest là thứ cần canh.'],
  ['tai-lieu', /\.(md|txt|html|css)\b/, 'Đọc tài liệu/asset.'],
];

/**
 * Rút mọi chuỗi ký tự trong một biểu thức, có giải biến trong cùng file.
 *
 * Không dùng AST là có chủ đích: gate này phải chạy được ở mọi runner mà không
 * kéo thêm parser TypeScript. Đổi lại là nó KHÔNG chính xác tuyệt đối — nên phần
 * không giải được phải được báo cáo chứ không được im.
 */
export function giaiChuoi(bieuThuc, nguon, tang = 0) {
  const chuoi = [...bieuThuc.matchAll(/['"`]([^'"`\n]{2,120})['"`]/g)].map((m) => m[1]);
  if (chuoi.length > 0 || tang >= 3) return chuoi;

  // Không có chuỗi nào ⇒ thử tra định danh đầu tiên trong biểu thức.
  const dinhDanh = bieuThuc.match(/\b([A-Za-z_$][\w$]*)\b/)?.[1];
  if (!dinhDanh) return [];
  const khai = nguon.match(
    new RegExp(`\\b(?:const|let|var)\\s+${dinhDanh}\\s*=\\s*([^;\\n]{0,400})`),
  );
  if (!khai) return [];
  return giaiChuoi(khai[1], nguon, tang + 1);
}

export function xepLoai(chuoi) {
  const gop = chuoi.join(' ');
  for (const [ten, re] of LOAI) if (re.test(gop)) return ten;
  return null;
}

/**
 * Rút ĐỐI SỐ ĐẦU TIÊN của một lời gọi, cân bằng ngoặc.
 *
 * Bản đầu dùng regex lười dừng ở `,` hoặc `)` gần nhất. Với
 * `readFileSync(resolve(dir, 'a', 'b.ts'))` nó cắt ngay sau `resolve(dir` — mất
 * sạch chuỗi, và lời gọi rơi vào nhóm "không phân loại được". Đo 11/08/2026: đó
 * là phần lớn của 314 chỗ không rõ, tức con số ấy nói về lỗi của phép đo chứ
 * không phải về repo.
 */
export function doiSoDau(nguon, tuVitri) {
  let sau = 0;
  let i = tuVitri;
  for (; i < nguon.length && i < tuVitri + 600; i++) {
    const c = nguon[i];
    if (c === '(') sau++;
    else if (c === ')') {
      if (sau === 0) break;
      sau--;
    } else if (c === ',' && sau === 0) break;
    else if (c === ';') break;
  }
  return nguon.slice(tuVitri, i);
}

export function quetMotFile(nguon) {
  const goi = [...nguon.matchAll(/\bread(?:FileSync|File)\s*\(/g)].map((m) => ({
    bieuThuc: doiSoDau(nguon, m.index + m[0].length),
  }));
  const loai = new Map();
  let khongRo = 0;
  for (const m of goi) {
    const chuoi = giaiChuoi(m.bieuThuc, nguon);
    const l = xepLoai(chuoi);
    if (!l) {
      khongRo++;
      continue;
    }
    loai.set(l, (loai.get(l) ?? 0) + 1);
  }
  return { soGoi: goi.length, loai, khongRo };
}

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const testPaths = (out) => out.split('\0').filter((p) => p && TEST_FILE.test(p) && !BO_QUA.some((re) => re.test(p)));

function docInputTest() {
  const chuaStage = [...new Set([
    ...testPaths(git(['ls-files', '--others', '--exclude-standard', '-z'])),
    ...testPaths(git(['diff', '--name-only', '-z'])),
  ])];
  if (chuaStage.length) {
    console.warn(`⚠ WIP test chưa stage: ${chuaStage.join(', ')}. Chỉ kiểm blob trong index, không tính các thay đổi này; stage đúng file của task bằng git add nếu cần đưa vào commit.`);
  }
  const files = testPaths(git(['ls-files', '--cached', '-z']));
  if (files.length < 200) {
    throw new Error(`Chỉ thấy ${files.length} file test — dưới sàn 200, không đủ bằng chứng kiểm kê.`);
  }
  // Một lượt Git cho toàn bộ blob: vừa đúng index vừa tránh hàng trăm process.
  if (files.some((p) => /[\r\n]/.test(p))) throw new Error('Đường dẫn test chứa xuống dòng, không đọc được bằng Git batch.');
  const blobs = git(['cat-file', '--batch'], { encoding: null, input: files.map((p) => `:0:${p}\n`).join('') });
  let offset = 0;
  return files.map((file) => {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('utf8');
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    if (end < 0 || !match) throw new Error(`Không đọc được blob test trong index: ${file}`);
    const size = Number(match[1]);
    const start = end + 1;
    if (!Number.isSafeInteger(size) || start + size >= blobs.length || blobs[start + size] !== 10) {
      throw new Error(`Blob test thiếu nội dung: ${file}`);
    }
    offset = start + size + 1;
    return [file, blobs.subarray(start, start + size).toString('utf8')];
  });
}

function dungInventory() {
  const inputs = docInputTest();
  const theoLoai = new Map();
  const chiTiet = [];
  let tongGoi = 0;
  let tongKhongRo = 0;

  for (const [p, source] of inputs) {
    const kq = quetMotFile(source);
    if (kq.soGoi === 0) continue;
    tongGoi += kq.soGoi;
    tongKhongRo += kq.khongRo;
    for (const [l, n] of kq.loai) {
      if (!theoLoai.has(l)) theoLoai.set(l, []);
      theoLoai.get(l).push(p);
      void n;
    }
    chiTiet.push({
      file: p,
      soGoi: kq.soGoi,
      loai: Object.fromEntries(kq.loai),
      khongPhanLoaiDuoc: kq.khongRo,
    });
  }

  const maNguon = [...new Set(theoLoai.get('ma-nguon') ?? [])].sort();
  return {
    $comment:
      'Sinh bởi scripts/generate-repository-inventory.mjs. Con số khongPhanLoaiDuoc là MỘT PHẦN CỦA KẾT QUẢ: quét không dùng AST nên có phần không giải được biến, và làm tròn nó xuống sẽ biến "chưa đo" thành "không có".',
    generatedFrom: 'git ls-files (không phụ thuộc thời điểm chạy)',
    tongSoFileTest: inputs.length,
    soFileDocBangFs: chiTiet.length,
    tongLoiGoi: tongGoi,
    khongPhanLoaiDuoc: tongKhongRo,
    theoLoai: Object.fromEntries(
      [...theoLoai].map(([l, ds]) => [l, { soFile: new Set(ds).size, moTa: LOAI.find((x) => x[0] === l)[2] }]),
    ),
    testDocMaNguon: maNguon,
    chiTiet: chiTiet.sort((a, b) => b.soGoi - a.soGoi),
  };
}

export function kiemTraInventory({ nguonIndex = false } = {}) {
  const expected = dungInventory();
  const raw = nguonIndex
    ? git(['show', ':0:docs/generated/repository-inventory.json'])
    : readFileSync(OUT, 'utf8');
  return isDeepStrictEqual(JSON.parse(raw), expected);
}

function main(argv) {
  if (argv.includes('--check')) {
    if (argv.includes('--write') || argv.includes('--json')) throw new Error('--check không đi cùng --write/--json.');
    if (!kiemTraInventory({ nguonIndex: argv.includes('--nguon-index') })) {
      console.error('❌ Inventory JSON đã cũ. Stage input test rồi chạy node scripts/generate-repository-inventory.mjs --write và node scripts/generate-docs-views.mjs; stage cả JSON/MD.');
      process.exitCode = 1;
    } else {
      console.log('✅ Inventory JSON khớp toàn bộ input test trong index.');
    }
    return;
  }
  if (argv.includes('--nguon-index')) throw new Error('--nguon-index chỉ dùng cùng --check.');
  const ketQua = dungInventory();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(ketQua, null, 2));
    return;
  }

  if (argv.includes('--write')) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(ketQua, null, 2) + '\n');
    console.log(`Đã ghi ${OUT.replace(repoRoot, '.')}`);
  }

  console.log(`Kiểm kê ${ketQua.tongSoFileTest} file test — ${ketQua.soFileDocBangFs} file đọc file bằng fs (${ketQua.tongLoiGoi} lời gọi)\n`);
  for (const [l, detail] of Object.entries(ketQua.theoLoai).sort((a, b) => b[1].soFile - a[1].soFile)) {
    console.log(`  ${String(detail.soFile).padStart(4)} file  ${l}`);
    console.log(`             ${detail.moTa}`);
  }
  console.log(`\n  ${String(ketQua.khongPhanLoaiDuoc).padStart(4)} lời gọi KHÔNG PHÂN LOẠI ĐƯỢC (đường dẫn dựng lúc chạy).`);
  console.log('             Đây là giới hạn của phép đo, không phải "không có gì".');

  console.log(`\n▸ ${ketQua.testDocMaNguon.length} file test đọc MÃ NGUỒN — đây là danh sách §0.2/C10 cần:`);
  for (const f of ketQua.testDocMaNguon.slice(0, 25)) console.log(`    ${f}`);
  if (ketQua.testDocMaNguon.length > 25) console.log(`    … còn ${ketQua.testDocMaNguon.length - 25}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv); } catch (error) {
    console.error(`❌ Không kiểm kê được: ${error.message}`);
    process.exitCode = 3;
  }
}
