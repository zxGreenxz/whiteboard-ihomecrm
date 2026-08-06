// Ratchet lỗi TypeScript theo TẬP fingerprint (không đếm số nữa).
// Chạy tsc -p tsconfig.app.json bằng spawnSync (deterministic, không qua npx),
// parse từng dòng diagnostic → fingerprint ỔN ĐỊNH (bỏ line/col, chuẩn hoá 'literal').
// So tập hiện tại với ts-baseline.json:
//   - Có fingerprint MỚI (không nằm trong baseline) → exit 1, liệt kê.
//   - Baseline có mà nay ĐÃ SỬA → in nhắc regen (--write), exit 0.
//   - Trùng khớp → exit 0.
// PROVE tsc thật sự chạy: nếu không có res.error, không parse được 'Found N errors'
// và output không nhận dạng được → exit 2 (KHÔNG bao giờ coi 'không đọc được' = 0 lỗi).
// Cross-check: số fingerprint parse được phải == N trong 'Found N errors', lệch → exit 2.
// Dùng:
//   node scripts/check-ts-baseline.mjs           (kiểm tra; npm run typecheck:baseline)
//   node scripts/check-ts-baseline.mjs --write    (regen ts-baseline.json từ tập hiện tại)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repoRoot, 'ts-baseline.json');
const WRITE = process.argv.includes('--write');

// 1) INVOKE DETERMINISTICALLY — chạy thẳng local tsc, KHÔNG qua npx/shell.
// Lưu ý Windows/Node>=20: spawn .cmd với shell:false ném EINVAL (chặn sau
// CVE-2024-27980). Nên gọi node lên đúng JS entrypoint của tsc — vẫn tất định,
// shell:false, không phụ thuộc PATH. Fallback .bin/tsc.cmd|tsc nếu thiếu entry.
const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const useJsEntry = existsSync(tscJs);
const bin = useJsEntry
  ? process.execPath
  : path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const args = useJsEntry
  ? [tscJs, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.app.json']
  : ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.app.json'];
const res = spawnSync(
  bin,
  args,
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false }
);
const out = (res.stdout || '') + '\n' + (res.stderr || '');

// 2) PROVE TSC RAN — ENOENT / không thấy summary và output không nhận dạng được.
const foundMatch = out.match(/Found (\d+) errors?/);
const looksLikeRun = foundMatch !== null || /error TS\d+:/.test(out);
if (res.error) {
  console.error(`❌ Không chạy được tsc (${bin}): ${res.error.message}`);
  console.error('   Kiểm tra node_modules đã cài chưa (npm ci).');
  process.exit(2);
}
if (!foundMatch && !looksLikeRun) {
  console.error('❌ tsc không cho ra kết quả đọc được (không thấy "Found N errors").');
  console.error('   KHÔNG coi đây là 0 lỗi. Output nhận được:');
  console.error(out.slice(0, 2000));
  process.exit(2);
}

// 2b) SÀN ĐỘ PHỦ — ratchet lỗi KHÔNG thay thế được phép kiểm này.
//
// Ratchet chỉ so TẬP LỖI. Nó không biết gì về việc tsc đã soi BAO NHIÊU file.
// Thu hẹp phạm vi (đổi `include`, thêm `exclude`) làm một số lỗi baseline biến
// mất, và gate phản ứng bằng "✅ 1 lỗi baseline đã được SỬA — chạy --write".
// Nghe theo lời khuyên đó là khoá vĩnh viễn phần mất phủ: từ đó lỗi mới trong
// vùng bị bỏ sẽ không bao giờ xuất hiện, mà cũng chẳng ai thấy điều gì đã đổi.
//
// Đo 07/08/2026: tsconfig.app.json phủ 1222 file trong src/; thêm
// `"exclude": ["src/hooks"]` còn 1190. Con số ĐỌC ĐƯỢC, nên canh được.
//
// (Ghi chú trung thực: `exclude` KHÔNG chặn được file đi vào qua import, nên
// một mình nó chưa giấu được lỗi. Phép kiểm này nhắm cái nguy hiểm hơn — phạm
// vi teo dần rồi được chốt lại bằng --write.)
const covPath = path.join(repoRoot, 'tooling', 'ts-coverage-baseline.json');
const listArgs = useJsEntry
  ? [tscJs, '--listFilesOnly', '-p', 'tsconfig.app.json']
  : ['--listFilesOnly', '-p', 'tsconfig.app.json'];
const listRes = spawnSync(bin, listArgs, {
  cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false,
});
const soFile = ((listRes.stdout || '').match(/[/\\]src[/\\]/g) || []).length;

if (WRITE) {
  writeFileSync(
    covPath,
    JSON.stringify({
      $comment: 'Sàn độ phủ typecheck: số file trong src/ mà tsconfig.app.json thực sự soi. CHỈ ĐƯỢC TĂNG. Giảm ⇒ phạm vi đã teo lại, và ratchet lỗi KHÔNG phát hiện được điều đó. Sinh bởi scripts/check-ts-baseline.mjs --write.',
      files: soFile,
    }, null, 2) + '\n',
    'utf8',
  );
} else if (existsSync(covPath)) {
  const san = JSON.parse(readFileSync(covPath, 'utf8')).files ?? 0;
  if (soFile < san) {
    console.error(`❌ Phạm vi typecheck TEO LẠI: ${soFile} file trong src/ (sàn ${san}).`);
    console.error('   Ratchet lỗi không thấy được điều này — nó chỉ so tập lỗi, không biết tsc soi bao nhiêu file.');
    console.error('   Kiểm tra include/exclude trong tsconfig.app.json. ĐỪNG hạ sàn để cho qua.');
    process.exit(1);
  }
}

// 3) PARSE + fingerprint ỔN ĐỊNH (multiset — giữ trùng lặp).
const DIAG = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.*)$/;
const fingerprints = [];
for (const rawLine of out.split(/\r?\n/)) {
  const m = rawLine.match(DIAG);
  if (!m) continue;
  const { file, code, msg } = m.groups;
  const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
  // GIỮ chuỗi trong nháy ĐẦU TIÊN — đó là tên property/biến bị than phiền.
  //
  // Bản đầu xoá SẠCH mọi thứ trong nháy đơn, nên
  //   Property 'zzzKhongHeCo' does not exist on type '{ a: number; b: number; }'
  // co lại thành đúng `Property '…' does not exist on type '…'.` — trùng khít
  // fingerprint baseline sẵn có của cùng file đó. Kết quả: MỘT lỗi cũ cấp phép
  // cho lỗi MỚI bất kỳ cùng dạng trong cùng file. Đo 07/08/2026: gieo lỗi
  // TS2339 thật vào RoomDetailDialog.tsx ⇒ tsc thấy rõ ở dòng 298, gate vẫn in
  // "khớp baseline, không có gì thay đổi" và exit 0.
  //
  // 20/26 fingerprint baseline thuộc dạng siêu-tổng-quát này, trải trên 15 file
  // gồm cả code tiền (invoiceHelpers, useQuickCollect, GenerateInvoiceDialog) —
  // tức 15 vùng miễn kiểm tra không giới hạn cho đúng loại lỗi ratchet sinh ra
  // để chặn.
  //
  // Vẫn chuẩn hoá các chuỗi SAU (hình dạng type) vì chúng đổi theo refactor vô
  // hại — đó là lý do ban đầu phải chuẩn hoá.
  let soNhay = 0;
  const normMsg = msg.replace(/'[^']*'/g, (khop) => (++soNhay === 1 ? khop : "'…'")).trim();
  fingerprints.push(`${relPath}|${code}|${normMsg}`);
}

// 4) CROSS-CHECK — số fingerprint parse được phải khớp N trong 'Found N errors'.
if (foundMatch) {
  const declared = parseInt(foundMatch[1], 10);
  if (fingerprints.length !== declared) {
    console.error(`❌ parser drift: parse được ${fingerprints.length} dòng lỗi nhưng tsc báo "Found ${declared} errors".`);
    console.error('   Regex diagnostic có thể lệch định dạng tsc — dừng để tránh baseline sai.');
    process.exit(2);
  }
} else if (fingerprints.length === 0) {
  // Không có 'Found N' và cũng không parse ra dòng nào dù có "error TS" đâu đó → nghi ngờ.
  console.error('❌ Có dấu hiệu lỗi TS nhưng không parse được dòng nào — dừng (exit 2).');
  console.error(out.slice(0, 2000));
  process.exit(2);
}

const curSorted = [...fingerprints].sort();

// 7) --write: regen baseline từ tập hiện tại (SET đã sort, unique).
if (WRITE) {
  // GIỮ TRÙNG LẶP. Comment ở mục 3 hứa "multiset — giữ trùng lặp" nhưng cả
  // --write lẫn phép so đều bóp về Set, nên bội số biến mất: 1 lỗi cũ và 27 lỗi
  // mới cùng dạng cho ra CÙNG một phần tử. Ghi nguyên bội số thì thêm một lỗi
  // nữa cùng dạng cũng làm số đếm vượt baseline ⇒ đỏ.
  const sorted = [...fingerprints].sort();
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`✅ Đã ghi ts-baseline.json: ${sorted.length} fingerprint (giữ bội số).`);
  process.exit(0);
}

// 6) baseline PHẢI tồn tại + là JSON array hợp lệ.
if (!existsSync(baselinePath)) {
  console.error(`❌ Thiếu ts-baseline.json (${baselinePath}). Chạy: node scripts/check-ts-baseline.mjs --write`);
  process.exit(2);
}
let baselineArr;
try {
  baselineArr = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (e) {
  console.error(`❌ ts-baseline.json không parse được JSON: ${e.message}`);
  process.exit(2);
}
if (!Array.isArray(baselineArr)) {
  console.error('❌ ts-baseline.json không phải JSON array.');
  process.exit(2);
}

// 5) So BỘI SỐ, không so tập hợp.
//
// So bằng Set là chỗ hỏng thứ hai (chỗ thứ nhất là chuẩn hoá xoá tên định
// danh): 1 lỗi cũ và 27 lỗi mới cùng dạng cho ra CÙNG một phần tử, nên gate
// xanh. Đếm số lần xuất hiện thì thêm một lỗi nữa cùng dạng cũng vượt baseline.
const dem = (arr) => arr.reduce((m, fp) => m.set(fp, (m.get(fp) ?? 0) + 1), new Map());
const baselineDem = dem(baselineArr);
const curDem = dem(curSorted);

const newOnes = [];
for (const [fp, n] of curDem) {
  const cu = baselineDem.get(fp) ?? 0;
  if (n > cu) newOnes.push(cu === 0 ? fp : `${fp}   (${cu} → ${n} lần)`);
}
const fixedOnes = [];
for (const [fp, n] of baselineDem) {
  const nay = curDem.get(fp) ?? 0;
  if (nay < n) fixedOnes.push(nay === 0 ? fp : `${fp}   (${n} → ${nay} lần)`);
}
newOnes.sort();
fixedOnes.sort();

if (newOnes.length > 0) {
  console.error(`❌ ${newOnes.length} lỗi TS MỚI (không có trong baseline). Sửa trước khi commit:`);
  for (const fp of newOnes) console.error(`   + ${fp}`);
  if (fixedOnes.length > 0) {
    console.error(`\n   (Ghi chú: ${fixedOnes.length} lỗi cũ đã sửa — sau khi xử lý lỗi mới, chạy --write để regen.)`);
  }
  process.exit(1);
}

if (fixedOnes.length > 0) {
  console.log(`✅ Không có lỗi TS mới. ${fixedOnes.length} lỗi baseline đã được SỬA:`);
  for (const fp of fixedOnes) console.log(`   - ${fp}`);
  console.log('   Chạy: node scripts/check-ts-baseline.mjs --write để cập nhật ts-baseline.json.');
  process.exit(0);
}

console.log(`✅ Tập lỗi TS khớp baseline (${baselineArr.length} fingerprint, đã tính bội số). Không có gì thay đổi.`);
process.exit(0);
