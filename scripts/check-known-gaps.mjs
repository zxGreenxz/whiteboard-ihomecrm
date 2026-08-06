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

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAPS_PATH = join(repoRoot, 'tooling', 'known-gaps.yaml');

const REQUIRED = ['id', 'expires_at', 'why', 'exit_condition'];

/**
 * Mọi chỗ CI cố ý không-gating phải khai gap id ngay tại chỗ.
 *
 * Header file này nêu `continue-on-error: true` làm lý do nó tồn tại, nhưng bản
 * đầu KHÔNG hề quét workflow — nên luật chỉ là mong muốn: ai cũng thêm được một
 * `continue-on-error` mới mà chẳng cần đăng ký, và nó thành vĩnh viễn đúng như
 * điều file này cảnh báo.
 *
 * Đo 06/08/2026: 2 chỗ non-gating, 1 chỗ CHƯA có trong sổ (nhánh cross-tenant),
 * dù đã có comment giải thích tử tế ngay tại chỗ. Giải thích không thay được hạn.
 *
 * Cách khai: đặt `# known-gap: <id>` trong 3 dòng ngay trước chỗ non-gating.
 */
const KHONG_GATING = [
  { re: /continue-on-error:\s*true/, ten: 'continue-on-error: true' },
  { re: /\|\|\s*\{?\s*$|\|\|\s*\{\s*$/, ten: '|| { … } nuốt lỗi' },
  { re: /::warning::/, ten: '::warning:: thay cho lỗi' },
];

export function timChoKhongGating(noiDung) {
  const dong = noiDung.split(/\r?\n/);
  const ra = [];
  for (let i = 0; i < dong.length; i += 1) {
    const khop = KHONG_GATING.find((k) => k.re.test(dong[i]));
    if (!khop) continue;
    const truoc = dong.slice(Math.max(0, i - 3), i).join('\n');
    const id = /#\s*known-gap:\s*([a-z0-9-]+)/.exec(truoc)?.[1] ?? null;
    ra.push({ dong: i + 1, loai: khop.ten, id, noiDungDong: dong[i].trim().slice(0, 90) });
  }
  return ra;
}

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

  // Luật này trước đây chỉ nằm trong comment đầu file; nay thi hành được.
  const idHopLe = new Set(gaps.map((g) => g.id));
  const chuaKhai = [];
  const idSai = [];
  const wfDir = join(repoRoot, '.github', 'workflows');
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    for (const c of timChoKhongGating(readFileSync(join(wfDir, f), 'utf8'))) {
      if (!c.id) chuaKhai.push(`${f}:${c.dong} — ${c.loai}: ${c.noiDungDong}`);
      else if (!idHopLe.has(c.id)) idSai.push(`${f}:${c.dong} — known-gap: ${c.id} (không có trong sổ)`);
    }
  }

  if (chuaKhai.length > 0 || idSai.length > 0) {
    console.error('❌ Có chỗ CI cố ý KHÔNG-GATING mà chưa đăng ký khoảng trống:\n');
    for (const c of chuaKhai) console.error(`  - ${c}`);
    for (const c of idSai) console.error(`  - ${c}`);
    console.error('\n  Thêm `# known-gap: <id>` trong 3 dòng ngay trước, và tạo mục tương ứng');
    console.error('  trong tooling/known-gaps.yaml KÈM expires_at + exit_condition.');
    console.error('  Một quyết định non-gating có giải thích nhưng KHÔNG có hạn sẽ thành vĩnh viễn —');
    console.error('  đó chính là điều file known-gaps.yaml được lập ra để ngăn.');
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
