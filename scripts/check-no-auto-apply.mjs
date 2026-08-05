#!/usr/bin/env node
// Gate: không workflow nào được tự apply migration lên database.
//
// Trước file này có HAI guard grep khác nhau, khác cả độ chặt:
//   - supabase-migrate.yml:  grep -RInE 'run:[^#]*supabase[[:space:]]+db[[:space:]]+push'
//   - network-center-validation.yml:  grep -rn "supabase db push"
// Bản thứ hai là so chuỗi trần nên nổ cả khi cụm từ nằm trong comment hoặc
// thông báo lỗi — tức là nó cấm luôn việc VIẾT RA rằng điều đó bị cấm. Bản thứ
// nhất lại chỉ bắt đúng một dòng `run:`, nên bỏ lọt biến thể xuống dòng:
//
//   run: |
//     supabase db push
//
// Checker này parse theo khối `run:` (kể cả block scalar nhiều dòng), bỏ qua
// comment, và bắt cả `supabase db push` lẫn `supabase migration up --linked`.
//
//   node scripts/check-no-auto-apply.mjs
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(repoRoot, '.github', 'workflows');

// Lệnh thực sự ghi vào database từ CI. `db pull`/`db diff`/`db lint` chỉ đọc.
const FORBIDDEN = [
  { re: /\bsupabase\s+db\s+push\b/, what: 'supabase db push' },
  { re: /\bsupabase\s+migration\s+up\b/, what: 'supabase migration up' },
  { re: /\bsupabase\s+db\s+reset\s+--linked\b/, what: 'supabase db reset --linked' },
];

/**
 * Trích các dòng shell nằm trong `run:` của một workflow.
 *
 * Không dùng YAML parser để tránh thêm dependency vào một gate phải chạy được ở
 * mọi runner; bù lại chỉ cần đúng hai dạng mà GitHub Actions cho phép:
 * `run: <lệnh>` một dòng, và `run: |` / `run: >` kèm khối thụt lề.
 */
export function extractRunLines(source) {
  const lines = source.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    // Tách rõ hai dạng bằng cách cắt phần sau "run:" rồi mới quyết định.
    // KHÔNG dùng lookahead kiểu `run:\s*(?![|>])`: `\s*` backtrack về rỗng để
    // lookahead nhìn thấy dấu cách thay vì `|`, nên `run: |` lọt vào nhánh
    // một-dòng và cả khối lệnh bên dưới bị bỏ qua. Bug đó đã được dựng lại
    // bằng đột biến trước khi sửa.
    const m = /^(\s*)-?\s*run:(.*)$/.exec(lines[i]);
    if (!m) continue;

    const rest = m[2].trim();
    if (rest !== '' && !/^[|>][-+]?\d*$/.test(rest)) {
      out.push({ line: i + 1, text: rest });
      continue;
    }
    if (rest === '') continue; // `run:` rỗng — không phải block scalar hợp lệ

    const baseIndent = m[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j];
      if (raw.trim() === '') continue;
      const indent = raw.length - raw.trimStart().length;
      if (indent <= baseIndent) break;
      out.push({ line: j + 1, text: raw });
    }
  }

  // Bỏ phần comment shell để câu chữ nói về lệnh cấm không tự kích hoạt gate.
  return out
    .map((entry) => ({ ...entry, text: entry.text.replace(/#.*$/, '') }))
    .filter((entry) => entry.text.trim() !== '');
}

/**
 * Tách một dòng shell thành các lệnh con theo `&&`, `||`, `;`, `|`.
 *
 * Lý do: `echo "supabase db push bị cấm"` KHÔNG phải auto-apply — nó là câu văn
 * nói về lệnh. Guard cũ của network-center-validation.yml so chuỗi trần nên cấm
 * luôn việc viết ra rằng điều đó bị cấm. Nhưng `bash -c "supabase db push"` thì
 * vẫn là apply thật, nên không thể chỉ đơn giản bỏ mọi thứ trong dấu nháy —
 * chỉ bỏ lệnh con nào mở đầu bằng lệnh in văn bản.
 */
// echo/printf in văn bản; grep/rg NHẬN pattern làm văn bản. Cả hai nhóm đều chỉ
// "nói về" lệnh chứ không chạy nó — chính guard grep cũ đã tự khớp vào mình vì
// không phân biệt được điều này.
const TEXT_ONLY = /^\s*(echo|printf|grep|rg|ag)\b/;

export function findAutoApply(source, file) {
  const hits = [];
  for (const { line, text } of extractRunLines(source)) {
    const segments = text.split(/&&|\|\||;|(?<!\|)\|(?!\|)/).filter((s) => !TEXT_ONLY.test(s));
    for (const { re, what } of FORBIDDEN) {
      if (segments.some((s) => re.test(s))) {
        hits.push({ file, line, what, text: text.trim() });
      }
    }
  }
  return hits;
}

function main() {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  const hits = files.flatMap((f) =>
    findAutoApply(readFileSync(join(WORKFLOW_DIR, f), 'utf8'), f),
  );

  if (hits.length > 0) {
    console.error('❌ Workflow đang tự apply migration lên database:\n');
    for (const h of hits) {
      console.error(`  - .github/workflows/${h.file}:${h.line} — ${h.what}`);
      console.error(`      ${h.text}`);
    }
    console.error(
      '\nApply là forward-only qua rollout script có promotion token (PROJECT_CONTRACT.md §4-5).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${files.length} workflow: không có bước nào tự apply migration.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
