#!/usr/bin/env node
// Gate: con số trong supabase/baseline/README.md phải khớp ĐÚNG TRƯỜNG trong
// manifest.json, và phải phân biệt "đã chụp" với "đã restore thử".
//
// VÌ SAO CẦN — có án lệ, phát hiện 11/08/2026
//   README mở đầu bằng: "Đã diễn tập thật ngày 07/08/2026 trên một Supabase
//   project trắng. Kết quả cuối: bảng 439/439 · view 14/14 · policy 1193/1193 ·
//   trigger 493/493."
//
//   Bốn con số đó là `manifest.counts` — số ĐÃ CHỤP TỪ PRODUCTION — chép nguyên
//   vào chỗ mô tả KẾT QUẢ RESTORE. Bản ghi diễn tập duy nhất có thật
//   (`manifest.restoreDrill`, 06/08, PostgreSQL TRẦN) ghi 303 bảng / 948 hàm /
//   803 policy và tự nói "chưa đầy đủ, chưa restore vào Supabase project thật".
//
//   Đây là loại sai đắt nhất trong tài liệu khôi phục: nó không làm gì hỏng hôm
//   nay, nó chỉ làm người đọc tin rằng đường lùi đã được chứng minh — và người ta
//   chỉ phát hiện ra vào đúng lúc cần dùng nó.
//
//   node scripts/check-baseline-doc.mjs          # kiểm (gate CI)
//   node scripts/check-baseline-doc.mjs --fix    # tự dán số từ manifest vào README
//
// --fix thêm 26/08/2026, cùng khuôn check-doc-counts: phép đối chiếu này thuần
// cơ học (trường manifest → con số sau một câu neo trong README) nên bắt người
// chép số bằng tay chỉ tạo vòng sửa-đi-sửa-lại. LƯU Ý --fix chỉ dán SỐ; luật
// văn bản "CHƯA có bản ghi nào" vẫn là gate chặn, không tự sửa được — đúng chủ
// đích, vì câu đó là lời khẳng định con người phải chịu trách nhiệm.
//
// Không cần credential. Thoát 0 · 1 khi lệch · 3 khi KHÔNG ĐỌC ĐƯỢC.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(repoRoot, 'supabase', 'baseline', 'README.md');
const MANIFEST = join(repoRoot, 'supabase', 'baseline', 'manifest.json');

/**
 * Mỗi mục: một con số trong README, và ĐÚNG trường manifest nó phải bằng.
 *
 * Cố ý gắn từng con số với một đường dẫn trường cụ thể, không phải "có mặt đâu đó
 * trong manifest". Chính việc lấy nhầm `counts` làm `restoreDrill.result` là lỗi
 * mà gate này sinh ra để chặn.
 */
export const DOI_CHIEU = [
  { re: /Đã CHỤP:\*\* bảng (\d+)/, truong: 'counts.tables', ten: 'bảng đã chụp' },
  { re: /Đã CHỤP:\*\* bảng \d+ · view (\d+)/, truong: 'counts.views', ten: 'view đã chụp' },
  { re: /Đã CHỤP:.*· policy (\d+)/, truong: 'counts.policies', ten: 'policy đã chụp' },
  { re: /Đã CHỤP:.*· trigger (\d+)/, truong: 'counts.triggers', ten: 'trigger đã chụp' },
  { re: /Đã RESTORE THỬ:\*\* bảng (\d+)/, truong: 'restoreDrill.result.tablesRestored', ten: 'bảng đã restore' },
  { re: /Đã RESTORE THỬ:\*\* bảng \d+ · hàm (\d+)/, truong: 'restoreDrill.result.functionsRestored', ten: 'hàm đã restore' },
  { re: /Đã RESTORE THỬ:.*· policy (\d+)/, truong: 'restoreDrill.result.policiesRestored', ten: 'policy đã restore' },
  { re: /(\d+) lỗi — tất cả do target/, truong: 'restoreDrill.errors.total', ten: 'số lỗi khi restore thử' },
];

export function layTruong(obj, duong) {
  return duong.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function doiChieu(readme, manifest, bang = DOI_CHIEU) {
  const van = [];
  for (const c of bang) {
    const m = c.re.exec(readme);
    if (!m) {
      van.push(`không tìm thấy con số "${c.ten}" trong README — mất neo, gate không kiểm được nó nữa.`);
      continue;
    }
    const that = layTruong(manifest, c.truong);
    if (that === undefined) {
      van.push(`manifest thiếu trường \`${c.truong}\` (cho "${c.ten}").`);
      continue;
    }
    if (Number(m[1]) !== Number(that)) {
      van.push(`"${c.ten}": README ghi ${m[1]}, manifest.${c.truong} là ${that}.`);
    }
  }
  return van;
}

/**
 * Dán số từ manifest vào README theo đúng các neo của DOI_CHIEU.
 * Thuần biến đổi văn bản — test được. Trả { output, daSua: [tên...] }.
 * Neo nào không tìm thấy thì KHÔNG sửa (để gate báo "mất neo" như cũ —
 * fix một neo đã mất là bịa vị trí cho con số).
 */
export function danSo(readme, manifest, bang = DOI_CHIEU) {
  let output = readme;
  const daSua = [];
  for (const c of bang) {
    const that = layTruong(manifest, c.truong);
    if (that === undefined) continue;
    const m = c.re.exec(output);
    if (!m || Number(m[1]) === Number(that)) continue;
    // Thay đúng nhóm bắt (m[1]) trong lần khớp này, giữ nguyên phần còn lại.
    const truoc = m[0];
    const viTriSo = truoc.lastIndexOf(m[1]);
    const sau = truoc.slice(0, viTriSo) + String(that) + truoc.slice(viTriSo + m[1].length);
    output = output.replace(truoc, sau);
    daSua.push(`${c.ten}: ${m[1]} → ${that}`);
  }
  return { output, daSua };
}

function main() {
  let readme;
  let manifest;
  try {
    readme = readFileSync(README, 'utf8');
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC baseline: ${error.message}`);
    process.exit(3);
  }

  if (process.argv.includes('--fix')) {
    const { output, daSua } = danSo(readme, manifest);
    if (daSua.length > 0) {
      writeFileSync(README, output, 'utf8');
      console.log(`✍ Đã dán ${daSua.length} con số từ manifest vào README baseline:`);
      for (const s of daSua) console.log(`    ${s}`);
      readme = output;
    }
  }

  const van = doiChieu(readme, manifest);

  // README phải nói rõ chưa xác minh trên Supabase project thật, CHỪNG NÀO
  // manifest còn ghi `whyNotVerifiedYet`. Gỡ câu đó khỏi README mà không gỡ khỏi
  // manifest là làm tài liệu lạc quan hơn bằng chứng.
  if (manifest.restoreDrill?.whyNotVerifiedYet && !/CHƯA có bản ghi nào/.test(readme)) {
    van.push(
      'manifest còn `restoreDrill.whyNotVerifiedYet` nhưng README không nói rõ CHƯA có bản ghi ' +
      'restore vào Supabase project thật.',
    );
  }

  if (van.length > 0) {
    console.error(`❌ ${van.length} chỗ lệch giữa README baseline và manifest:\n`);
    for (const v of van) console.error(`  - ${v}`);
    console.error('\n  Đây là tài liệu KHÔI PHỤC. Con số sai ở đây không làm gì hỏng hôm nay —');
    console.error('  nó chỉ làm người đọc tin đường lùi đã được chứng minh, và người ta phát hiện');
    console.error('  ra vào đúng lúc cần dùng nó.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${DOI_CHIEU.length} con số trong README baseline khớp đúng trường trong manifest.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
