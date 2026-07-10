// Ratchet lỗi TypeScript: chạy tsc -p tsconfig.app.json, đếm lỗi, so với
// ts-baseline.txt. Fail (exit 1) nếu số lỗi TĂNG so với baseline.
// Nếu số lỗi GIẢM, in nhắc cập nhật baseline (không tự ghi để tránh trôi ngầm).
// Dùng: node scripts/check-ts-baseline.mjs   (hoặc: npm run typecheck:baseline)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const baseline = parseInt(readFileSync(new URL('../ts-baseline.txt', import.meta.url), 'utf8').trim(), 10);

let out = '';
try {
  out = execSync('npx tsc --noEmit -p tsconfig.app.json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
}
const count = (out.match(/error TS/g) || []).length;

if (count > baseline) {
  console.error(`❌ TS errors TĂNG: ${count} > baseline ${baseline}. Sửa lỗi mới trước khi commit.`);
  process.exit(1);
}
if (count < baseline) {
  console.log(`✅ TS errors GIẢM: ${count} < baseline ${baseline}. Cập nhật ts-baseline.txt = ${count}.`);
  process.exit(0);
}
console.log(`✅ TS errors = baseline (${baseline}).`);
