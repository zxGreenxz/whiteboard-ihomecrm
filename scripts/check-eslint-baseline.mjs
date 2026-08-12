#!/usr/bin/env node
// =============================================================================
// Ratchet lint: chặn lỗi ESLint MỚI, ghi nhận nợ cũ thay vì giả vờ không có.
//
// VÌ SAO CẦN
//   Bước "Lint root-owned code" trong ci-gates.yml đòi ESLint sạch tuyệt đối.
//   Đo 12/08/2026 trên đúng bộ ignore của CI: 1714 file được lint, **1201 lỗi**
//   (1179 trong số đó là @typescript-eslint/no-explicit-any) và 156 cảnh báo.
//   Không có PR nào dọn nổi 1201 lỗi, nên cửa đó chỉ có hai kết cục: đỏ vĩnh
//   viễn, hoặc bị tắt. Cả hai đều mất khả năng chặn lỗi mới.
//
//   Và nó ĐANG đỏ vĩnh viễn mà không ai thấy: quality-gates 0/167 lần xanh
//   trong toàn bộ lịch sử GitHub còn giữ cho main (từ 07/08/2026). Bước lint
//   thậm chí chưa từng CHẠY — các bước đứng trước luôn đỏ sớm hơn, và GitHub
//   Actions dừng job ở bước hỏng đầu tiên. Một cửa chưa từng chạy thì con số
//   "đã có cửa chặn" trong tài liệu là lời hứa suông.
//
// CÁCH ĐO — mượn nguyên thiết kế đã được kiểm của scripts/check-ts-baseline.mjs
//   Fingerprint = `<đường dẫn tương đối>|<ruleId>`, giữ dưới dạng MULTISET (tức
//   giữ trùng lặp). Multiset là điểm mấu chốt, không phải chi tiết cài đặt:
//   nếu chỉ giữ tập hợp thì một file đã có sẵn một `no-explicit-any` sẽ cấp
//   phép cho `any` thứ hai, thứ mười trong chính file đó — đúng lỗ hổng mà
//   check-ts-baseline đã phải sửa sau khi đo thấy 20/26 fingerprint của nó là
//   dạng siêu-tổng-quát. Ở đây thêm một `any` làm số lần xuất hiện đổi ⇒ đỏ.
//
//   KHÔNG dùng số dòng/cột trong fingerprint: thêm một dòng trắng ở đầu file sẽ
//   dời toàn bộ và biến một refactor vô hại thành cửa đỏ. Đánh đổi có ý thức:
//   di chuyển một lỗi trong cùng file, cùng rule, là vô hình với cửa này.
//
// SÀN ĐỘ PHỦ
//   Ratchet lỗi KHÔNG tự bảo vệ được phạm vi: thêm một dòng vào `ignores` của
//   eslint.config.js sẽ làm lỗi biến mất và cửa xanh hơn trước. Nên số file
//   được lint được ghi lại và CHỈ ĐƯỢC TĂNG.
//
//   node scripts/check-eslint-baseline.mjs           # kiểm
//   node scripts/check-eslint-baseline.mjs --write   # chốt mức mới (chỉ khi ĐÃ GIẢM)
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(repoRoot, 'eslint-baseline.json');

/**
 * Bộ ignore PHẢI khớp bước "Lint root-owned code" trong ci-gates.yml.
 *
 * Để hai nơi cùng khai là mầm lệch — nhưng lệch ở đây KÊU chứ không im: nếu CI
 * lint rộng hơn thì nó gặp lỗi ngoài baseline và đỏ; nếu CI lint hẹp hơn thì
 * sàn độ phủ dưới đây tụt và cũng đỏ.
 */
export const BO_QUA = [
  'services/**',
  'infra/**',
  'supabase/functions/**',
  '.tmp-openclaw-host/**',
  '.e2e-fleet/**',
];

/** Sàn chống-xanh-rỗng: lint 0 file thì "0 lỗi mới" là câu đúng mà vô nghĩa. */
export const TOI_THIEU_FILE = 500;

/**
 * Dựng multiset fingerprint từ kết quả JSON của ESLint.
 *
 * Tách khỏi I/O để test được bằng dữ liệu dựng tay — cùng lý do
 * check-migration-provenance tách `entryThieuFile`.
 */
export function dungFingerprint(ketQua, goc = repoRoot) {
  const ra = [];
  for (const f of ketQua) {
    const duongDan = relative(goc, f.filePath).split(sep).join('/');
    for (const m of f.messages ?? []) {
      if (m.severity !== 2) continue; // chỉ ratchet ERROR; warning đã là cảnh báo
      ra.push(`${duongDan}|${m.ruleId ?? '(khong-ro-rule)'}`);
    }
  }
  return ra.sort();
}

/** So hai multiset, trả về phần THỪA RA ở mỗi bên (giữ trùng lặp). */
export function soMultiset(hienTai, nen) {
  const dem = new Map();
  for (const k of nen) dem.set(k, (dem.get(k) ?? 0) + 1);
  const moi = [];
  for (const k of hienTai) {
    const n = dem.get(k) ?? 0;
    if (n > 0) dem.set(k, n - 1);
    else moi.push(k);
  }
  const daDon = [];
  for (const [k, n] of dem) for (let i = 0; i < n; i += 1) daDon.push(k);
  return { moi, daDon };
}

function main(argv) {
  const args = ['eslint', '.', '--format', 'json'];
  for (const p of BO_QUA) args.push('--ignore-pattern', p);

  const kq = spawnSync('npx', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });

  // PHÂN BIỆT "KHÔNG CHẠY ĐƯỢC" VỚI "CHẠY RỒI, CÓ LỖI LINT".
  //
  // ESLint thoát 1 khi có lỗi lint và thoát 2 khi chính nó hỏng (config sai,
  // không parse được). Gộp hai cái lại thì một config hỏng sẽ hiện ra dưới dạng
  // "hàng nghìn lỗi lint mới" — buộc tội sai, và chỉ người đọc đi sửa mã trong
  // khi thứ hỏng là cấu hình.
  if (kq.error || kq.status === 2 || !kq.stdout?.trim()) {
    console.error('=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS, CŨNG KHÔNG PHẢI FAIL ===');
    console.error(`  eslint thoát ${kq.status}${kq.error ? ` (${kq.error.message})` : ''}.`);
    console.error(`  ${(kq.stderr ?? '').slice(0, 500)}`);
    process.exit(3);
  }

  let ketQua;
  try {
    ketQua = JSON.parse(kq.stdout);
  } catch (e) {
    console.error(`❌ Không parse được JSON của eslint: ${e.message}`);
    process.exit(3);
  }

  const soFile = ketQua.length;
  if (soFile < TOI_THIEU_FILE) {
    console.error(`❌ Chỉ lint được ${soFile} file (sàn ${TOI_THIEU_FILE}) — phạm vi đã teo, "0 lỗi mới" là vô nghĩa.`);
    process.exit(3);
  }

  const hienTai = dungFingerprint(ketQua);

  if (!existsSync(BASELINE)) {
    if (!argv.includes('--write')) {
      console.error(`❌ Thiếu ${relative(repoRoot, BASELINE)}. Chạy: node scripts/check-eslint-baseline.mjs --write`);
      process.exit(1);
    }
    writeFileSync(
      BASELINE,
      JSON.stringify({ $comment: 'Nợ lint đã khai. CHỈ ĐƯỢC TEO.', soFileToiThieu: soFile, fingerprints: hienTai }, null, 2) + '\n',
    );
    console.log(`✅ Đã chốt baseline: ${hienTai.length} lỗi trên ${soFile} file.`);
    return;
  }

  const nen = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (soFile < (nen.soFileToiThieu ?? 0)) {
    console.error(`❌ Sàn độ phủ tụt: lint ${soFile} file, baseline ghi ${nen.soFileToiThieu}.`);
    console.error('   Có ai đó mở rộng `ignores` hoặc đổi bộ ignore của CI. ĐỪNG hạ sàn để cho qua.');
    process.exit(1);
  }

  const { moi, daDon } = soMultiset(hienTai, nen.fingerprints ?? []);

  if (moi.length > 0) {
    console.error(`❌ ${moi.length} lỗi lint MỚI so với baseline:\n`);
    const gom = new Map();
    for (const k of moi) gom.set(k, (gom.get(k) ?? 0) + 1);
    for (const [k, n] of [...gom].sort()) console.error(`   ${n}× ${k}`);
    console.error('\n   Sửa chúng, đừng thêm vào baseline. Baseline chỉ được teo.');
    process.exit(1);
  }

  console.log(`Lint ratchet: ${hienTai.length} lỗi trên ${soFile} file · baseline ${(nen.fingerprints ?? []).length}`);
  if (daDon.length > 0) {
    console.log(`✅ 0 lỗi mới. Đã dọn được ${daDon.length} — chạy \`--write\` để chốt mức thấp hơn.`);
    if (argv.includes('--write')) {
      writeFileSync(
        BASELINE,
        JSON.stringify({ ...nen, soFileToiThieu: Math.max(soFile, nen.soFileToiThieu ?? 0), fingerprints: hienTai }, null, 2) + '\n',
      );
      console.log(`   Đã chốt: ${hienTai.length} lỗi / sàn ${Math.max(soFile, nen.soFileToiThieu ?? 0)} file.`);
    }
  } else {
    console.log('✅ 0 lỗi mới, không có gì thay đổi.');
  }
  console.log('   CHƯA PHỦ: di chuyển một lỗi trong cùng file, cùng rule (fingerprint không mang số dòng).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
