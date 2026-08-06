#!/usr/bin/env node
// Gate: ba file rule của agent không được mâu thuẫn nhau, và không được tái xuất
// hiện các chỉ dẫn đã từng gây hỏng thật.
//
// Vì sao cần: repo có CLAUDE.md, AGENTS.md và AI_RULES.md cùng nói về một hệ
// thống. Mỗi lần chúng lệch nhau là một lần agent làm sai theo hướng dẫn CHÍNH
// THỨC. Hai ca đã xảy ra:
//   - AGENTS.md dạy `npm run gen:types > types.ts`. Shell cắt trắng file trước
//     khi generator chạy; generator lỗi thì types.ts chỉ còn một dòng banner.
//     CI đã biết và ghi rõ cách đúng, nhưng file rule thì không ai sửa.
//   - CLAUDE.md coi "chưa push main = việc chưa xong" trong khi main deploy
//     thẳng production, biến mọi commit thành một lần phát hành.
//
//   node scripts/check-agent-contract.mjs
//
// Không cần credential, không đọc database.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'docs/engineering/PROJECT_CONTRACT.md';
const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'AI_RULES.md'];

// Mỗi mục là một chỉ dẫn ĐÃ gây hỏng thật, kèm lý do để người đọc lỗi hiểu ngay
// vì sao nó bị cấm chứ không phải "vì gate nói thế".
// Pattern viết dạng KHÔNG DẤU và so trên bản đã bỏ dấu: repo này viết tiếng
// Việt lẫn lộn có dấu / không dấu, một regex có dấu sẽ bỏ lọt ngay khi ai đó gõ
// nhanh. Ca đó đã bị bắt bằng đột biến trước khi sửa.
const FORBIDDEN = [
  {
    id: 'gen-types-redirect',
    re: /gen:types\s*>/,
    why: 'Redirect cắt trắng types.ts TRƯỚC khi generator chạy. Dùng `npm run gen:types` (script tự ghi atomic + tự chèn header).',
  },
  {
    id: 'push-equals-done',
    re: /chua push\s*=\s*(viec\s*)?chua xong/i,
    why: '`main` không phải production. Phát hành là bước promote riêng sau khi gate xanh (PROJECT_CONTRACT §3).',
  },
  {
    id: 'git-add-all',
    re: /^\s*[-*]?\s*(dung|use|chay|run)?\s*`?git add (-A|\.)`?\s*$/im,
    why: 'Cây làm việc repo này thường có file dở dang từ phiên khác; phải stage tên file cụ thể.',
  },
];

const deaccent = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

export function findForbidden(text, file) {
  const haystack = deaccent(stripQuotedWarnings(text));
  return FORBIDDEN
    .filter(({ re }) => re.test(haystack))
    .map(({ id, why }) => ({ file, id, why }));
}

/**
 * Bỏ các dòng ĐANG CẢNH BÁO về chỉ dẫn xấu trước khi soi.
 *
 * Nếu không làm vậy thì chính câu "ĐỪNG chạy gen:types > file" sẽ kích gate —
 * đúng lỗi mà guard `db push` cũ mắc phải: nó cấm luôn việc viết ra rằng điều
 * đó bị cấm. Dấu hiệu nhận biết: dòng có từ phủ định hoặc nằm trong blockquote
 * cảnh báo.
 */
function stripQuotedWarnings(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/(KHÔNG|ĐỪNG|không được|GOTCHA|phá file|cấm|thay bằng|footgun|>\s*⚠)/i.test(line))
    .join('\n');
}

function main() {
  const problems = [];
  const read = (f) => {
    try { return readFileSync(join(repoRoot, f), 'utf8'); } catch { return null; }
  };

  const contract = read(CONTRACT);
  if (contract === null) {
    console.error(`❌ Thiếu ${CONTRACT} — đây là nguồn luật chung, mọi file rule phải trỏ về nó.`);
    process.exitCode = 1;
    return;
  }

  for (const file of AGENT_FILES) {
    const text = read(file);
    if (text === null) continue; // file có thể đã được rút gọn/xoá có chủ đích

    problems.push(...findForbidden(text, file));

    if (!text.includes('PROJECT_CONTRACT.md')) {
      problems.push({
        file,
        id: 'missing-contract-pointer',
        why: `Không trỏ về ${CONTRACT}. Ba file rule phải cùng một nguồn luật, nếu không chúng sẽ lệch nhau lần nữa.`,
      });
    }
  }

  // Contract phải giữ được các invariant đắt nhất — nếu ai đó rút gọn nó quá
  // tay thì tri thức rơi mất mà không ai thấy.
  // Danh sách này là ĐIỀU KIỆN để rút ba file rule thành adapter mỏng: mỗi mục
  // là một tri thức đã trả giá để có. Nếu ai đó rút gọn Contract quá tay, gate
  // này là thứ duy nhất phát hiện — vì tri thức mất đi không làm test nào đỏ.
  const MUST_MENTION = [
    ['ts-baseline.json', 'ratchet TypeScript theo fingerprint'],
    ['check-view-invoker', 'gate view security_invoker'],
    ['check-stable-fn-locks', 'gate hàm STABLE lấy khoá dòng'],
    ['25006', 'mã lỗi khi hàm STABLE lấy khoá dòng qua PostgREST'],
    ['VOLATILE', 'hàm lấy khoá dòng phải khai VOLATILE'],
    ['reconcile-money', 'đối chiếu tiền'],
    ['cap-1000', 'bug tổng chỉ 1000 dòng đầu'],
    ['CLAUDE.local.md', 'credential vault'],
    ['promotion token', 'ghi database production cần token nhập tại chỗ'],
    ['hide_sandbox_admin', 'policy chặn org TEST lọt vào org thật'],
    ['deadlock', 'await supabase.* trong callback auth gây treo im lặng'],
    ['FLEET_PASS', 'mật khẩu E2E không nằm trong repo'],
    ['2.9.4', 'phiên bản Deno đã xác minh'],
    ['gen:types', 'quy trình regen types (không redirect)'],
    ['backup-before-schema', 'PITR tắt nên phải dump trước thao tác schema'],
    ['migration-policy.json', 'cutoff và luật forward-only'],
  ];
  for (const [needle, what] of MUST_MENTION) {
    if (!contract.includes(needle)) {
      problems.push({ file: CONTRACT, id: 'contract-lost-invariant', why: `Mất phần "${what}" (không còn nhắc \`${needle}\`).` });
    }
  }

  if (problems.length > 0) {
    console.error('❌ Hợp đồng agent có vấn đề:\n');
    for (const p of problems) console.error(`  - ${p.file} [${p.id}]\n      ${p.why}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${AGENT_FILES.length} file rule cùng trỏ về ${CONTRACT}; không có chỉ dẫn nguy hiểm tái xuất hiện.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
