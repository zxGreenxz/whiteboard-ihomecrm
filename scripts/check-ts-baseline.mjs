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

// 3) PARSE + fingerprint ỔN ĐỊNH (multiset — giữ trùng lặp).
const DIAG = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.*)$/;
const fingerprints = [];
for (const rawLine of out.split(/\r?\n/)) {
  const m = rawLine.match(DIAG);
  if (!m) continue;
  const { file, code, msg } = m.groups;
  const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
  const normMsg = msg.replace(/'[^']*'/g, "'…'").trim();
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
  const uniqueSorted = [...new Set(fingerprints)].sort();
  writeFileSync(baselinePath, JSON.stringify(uniqueSorted, null, 2) + '\n', 'utf8');
  console.log(`✅ Đã ghi ts-baseline.json: ${uniqueSorted.length} fingerprint (từ ${fingerprints.length} lỗi thô).`);
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

// 5) So SET: new = cur - baseline (exit 1); fixed = baseline - cur (nhắc regen, exit 0).
const baselineSet = new Set(baselineArr);
const curSet = new Set(curSorted);
const newOnes = [...curSet].filter((fp) => !baselineSet.has(fp)).sort();
const fixedOnes = [...baselineSet].filter((fp) => !curSet.has(fp)).sort();

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

console.log(`✅ Tập lỗi TS khớp baseline (${baselineSet.size} fingerprint). Không có gì thay đổi.`);
process.exit(0);
