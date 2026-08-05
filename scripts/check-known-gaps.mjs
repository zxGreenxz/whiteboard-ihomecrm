#!/usr/bin/env node
// Gate: khoảng trống đã biết phải có ngày hết hạn, và quá hạn thì phải bị nhìn thấy.
//
// Vì sao cần: `continue-on-error: true` và các suite "chỉ chạy được trên Windows"
// đều là quyết định hợp lý tại thời điểm đó. Không có ngày hết hạn thì chúng
// thành vĩnh viễn, và sau vài tháng không ai phân biệt được đâu là quyết định
// còn đâu là thứ bị bỏ quên.
//
//   node scripts/check-known-gaps.mjs            # cảnh báo khi quá hạn
//   node scripts/check-known-gaps.mjs --strict   # exit 1 khi quá hạn
//
// Mặc định KHÔNG fail: một gate đỏ vì ngày tháng sẽ bị gia hạn theo nghi thức
// hoặc bị tắt, và khi ấy mất luôn tín hiệu. Dùng --strict khi rà định kỳ.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAPS_PATH = join(repoRoot, 'tooling', 'known-gaps.yaml');

const REQUIRED = ['id', 'expires_at', 'why', 'exit_condition'];

export function validateGaps(doc, today = new Date()) {
  const problems = [];
  const expired = [];
  const seen = new Set();

  const gaps = doc?.gaps;
  if (!Array.isArray(gaps)) return { problems: ['known-gaps.yaml thiếu mảng `gaps`.'], expired: [], gaps: [] };

  for (const gap of gaps) {
    const id = gap?.id ?? '(thiếu id)';
    for (const field of REQUIRED) {
      if (!gap?.[field]) problems.push(`${id}: thiếu \`${field}\`.`);
    }
    if (seen.has(id)) problems.push(`${id}: id trùng.`);
    seen.add(id);

    if (gap?.expires_at) {
      const when = new Date(gap.expires_at);
      if (Number.isNaN(when.getTime())) {
        problems.push(`${id}: expires_at không phải ngày hợp lệ (${gap.expires_at}).`);
      } else if (when < today) {
        expired.push({ id, expires_at: gap.expires_at, days: Math.floor((today - when) / 86_400_000) });
      }
    }
    // exit_condition phải mô tả ĐIỀU KIỆN ĐÓNG, không phải "sẽ xem sau".
    if (typeof gap?.exit_condition === 'string' && gap.exit_condition.trim().length < 20) {
      problems.push(`${id}: exit_condition quá mơ hồ — phải nói rõ điều gì xảy ra thì gap này đóng.`);
    }
  }

  return { problems, expired, gaps };
}

function main(argv) {
  const strict = argv.includes('--strict');
  const doc = yaml.load(readFileSync(GAPS_PATH, 'utf8'));
  const { problems, expired, gaps } = validateGaps(doc);

  if (problems.length > 0) {
    console.error('❌ known-gaps.yaml không hợp lệ:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${gaps.length} khoảng trống đã biết, tất cả đều có ngày hết hạn và điều kiện đóng.`);

  if (expired.length > 0) {
    console.warn(`\n⚠ ${expired.length} khoảng trống QUÁ HẠN:`);
    for (const e of expired) console.warn(`   - ${e.id} (quá ${e.days} ngày, hạn ${e.expires_at})`);
    console.warn('   Cách xử: ĐÓNG nó, hoặc gia hạn KÈM lý do mới. Không xoá dòng cho yên.');
    if (strict) process.exitCode = 1;
    return;
  }

  const soon = gaps
    .map((g) => ({ id: g.id, days: Math.floor((new Date(g.expires_at) - new Date()) / 86_400_000) }))
    .filter((g) => g.days <= 30)
    .sort((a, b) => a.days - b.days);
  if (soon.length > 0) {
    console.log(`\n⏳ Sắp tới hạn: ${soon.map((s) => `${s.id} (${s.days} ngày)`).join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
