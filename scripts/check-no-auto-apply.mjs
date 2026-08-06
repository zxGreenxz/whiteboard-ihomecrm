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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(repoRoot, '.github', 'workflows');
// Step `run:` trong composite action chạy trong CI y hệt step của workflow.
// Bản đầu chỉ quét .github/workflows nên một `uses: ./.github/actions/db-apply`
// bọc lệnh apply là hoàn toàn vô hình.
const ACTION_DIR = join(repoRoot, '.github', 'actions');

/**
 * `supabase` có thể kèm version ghim (`npx supabase@2.20.5 db push`) — chuyện
 * thường ngày trong CI. Regex cũ dùng `\bsupabase\s+db` nên vỡ ngay khi gặp `@`:
 * `npx supabase db push` bị bắt, `npx supabase@2.20.5 db push` thì lọt. Đã dựng
 * lại và xác nhận 07/08/2026.
 */
const SB = String.raw`\bsupabase(?:@[\w.\-^~*]+)?\s+`;

// Lệnh thực sự ghi vào database từ CI. `db pull`/`db diff`/`db lint` chỉ đọc.
const FORBIDDEN = [
  { re: new RegExp(`${SB}db\\s+push\\b`), what: 'supabase db push' },
  { re: new RegExp(`${SB}migration\\s+up\\b`), what: 'supabase migration up' },
  // `--linked` và `--db-url` là ĐÚNG một cặp: cả hai đều trỏ lệnh vào database
  // TỪ XA. Bản đầu chỉ liệt kê `--linked`, nên `db reset --db-url "$PROD"` —
  // lệnh drop rồi replay TOÀN BỘ migration lên đúng database đó — đi thẳng qua.
  // Cùng mẫu với `relkind='i'` bỏ sót `'I'`.
  { re: new RegExp(`${SB}db\\s+reset\\b[^\\n]*--(linked|db-url)\\b`), what: 'supabase db reset lên DB từ xa' },
  { re: new RegExp(`${SB}db\\s+push\\b[^\\n]*--db-url\\b`), what: 'supabase db push --db-url' },
];

/**
 * Trích các lệnh shell nằm trong `run:` — bằng YAML PARSER, không đọc từng dòng.
 *
 * Bản đầu tự đọc từng dòng và đẩy MỖI DÒNG THÔ vào kết quả như một đơn vị độc
 * lập, nên chuỗi lệnh mà runner thật sự chạy không bao giờ được dựng lại. Ba
 * cách viết hợp lệ đi thẳng qua (đã dựng và chạy thật 07/08/2026):
 *
 *   run: >                      ← folded scalar: YAML biến newline thành DẤU CÁCH
 *     supabase db                 nên lệnh thật là `supabase db push --linked`.
 *     push --linked               Trớ trêu: regex cũ NHẬN DIỆN `>` là block header
 *                                 rồi vẫn xử lý theo từng dòng.
 *   run: |
 *     supabase \                ← nối dòng bằng backslash: cách viết phổ biến
 *       db push --linked          nhất khi lệnh CI dài kèm env và cờ.
 *
 *   run: supabase db            ← plain multiline scalar: nhánh một-dòng cũ đẩy
 *     push --linked               đúng `supabase db` rồi `continue`.
 *
 * js-yaml trả về đúng chuỗi runner nhận, nên cả ba biến mất cùng lúc. Hai gate
 * khác trong repo (check-known-gaps, check-runtime-matrix) đã dùng js-yaml, nên
 * đây không phải phụ thuộc mới.
 */
export function extractRunLines(source) {
  // YAML hỏng thì NÉM, không nuốt. File không parse được là file không kiểm
  // được, và với gate chặn apply-lên-production thì "không kiểm được" phải bằng
  // ĐỎ chứ không bằng xanh — main() bắt và báo có tiếng.
  const doc = yaml.load(source);
  const out = [];

  const nhatRun = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) nhatRun(x);
      return;
    }
    if (typeof node.run === 'string') out.push(node.run);
    for (const v of Object.values(node)) nhatRun(v);
  };
  nhatRun(doc);

  const ket = [];
  for (const raw of out) {
    // Nối dòng bằng backslash TRƯỚC khi tách, để `supabase \` + `db push` trở
    // lại thành một lệnh.
    const noi = raw.replace(/\\\r?\n\s*/g, ' ');
    for (const dong of noi.split(/\r?\n/)) {
      const text = dong.replace(/#.*$/, '');
      if (text.trim() !== '') ket.push({ line: 0, text });
    }
  }
  return ket;
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

/**
 * Miễn trừ TEXT_ONLY chỉ đúng khi cụm đó THẬT SỰ chỉ in chữ.
 *
 * `echo "$(supabase db push --linked)"` mở đầu bằng `echo` nên bị miễn trừ cả
 * cụm — nhưng command substitution CHẠY THẬT trước khi echo in được gì. Backtick
 * cũng vậy. Có dấu hiệu thực thi lồng thì thôi miễn trừ.
 */
const CO_THUC_THI_LONG = /\$\(|`|\$\{[^}]*\(/;

export function findAutoApply(source, file) {
  const hits = [];
  for (const { line, text } of extractRunLines(source)) {
    const segments = text.split(/&&|\|\||;|(?<!\|)\|(?!\|)/).filter((s) => !(TEXT_ONLY.test(s) && !CO_THUC_THI_LONG.test(s)));
    for (const { re, what } of FORBIDDEN) {
      if (segments.some((s) => re.test(s))) {
        hits.push({ file, line, what, text: text.trim() });
      }
    }
  }
  return hits;
}

/**
 * Mọi file YAML có step `run:` chạy trong CI — KHÔNG chỉ .github/workflows.
 *
 * Composite action (.github/actions/<ten>/action.yml) chạy step `run:` y hệt
 * workflow, nhưng bản đầu dùng readdirSync(WORKFLOW_DIR) nên một
 * `uses: ./.github/actions/db-apply` bọc lệnh apply là hoàn toàn vô hình.
 */
function nguonYaml() {
  const ra = [];
  for (const f of readdirSync(WORKFLOW_DIR)) {
    if (/\.ya?ml$/.test(f)) ra.push(join(WORKFLOW_DIR, f));
  }
  if (existsSync(ACTION_DIR)) {
    for (const e of readdirSync(ACTION_DIR, { recursive: true, withFileTypes: true })) {
      if (e.isFile() && /^action\.ya?ml$/.test(e.name)) {
        ra.push(join(e.parentPath ?? e.path, e.name));
      }
    }
  }
  return ra;
}

function main() {
  const files = nguonYaml();
  const hits = [];
  for (const abs of files) {
    const ten = relative(repoRoot, abs).replace(/\\/g, '/');
    try {
      hits.push(...findAutoApply(readFileSync(abs, 'utf8'), ten));
    } catch (e) {
      console.error(`❌ ${ten}: không parse được YAML — ${e.message}`);
      console.error('   File không kiểm được thì phải ĐỎ. Sửa YAML rồi chạy lại.');
      process.exitCode = 1;
      return;
    }
  }

  if (hits.length > 0) {
    console.error('❌ Workflow đang tự apply migration lên database:\n');
    for (const h of hits) {
      console.error(`  - ${h.file} — ${h.what}`);
      console.error(`      ${h.text}`);
    }
    console.error(
      '\nApply là forward-only qua rollout script có promotion token (PROJECT_CONTRACT.md §4-5).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${files.length} file YAML (workflow + composite action): không có bước nào tự apply migration.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
