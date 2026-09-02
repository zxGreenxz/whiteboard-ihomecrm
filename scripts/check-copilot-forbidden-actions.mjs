#!/usr/bin/env node
/**
 * Build gate for the Copilot L5/L6 boundary.
 *
 * Copilot may explain the normal human workflow, or create an UNAPPROVED
 * draft through the nonce-protected finance path. It must never expose an
 * executable approval, posting, deletion, permission, SQL, secret, or deploy
 * action. This module is intentionally data-driven so unit tests can exercise
 * the gate without importing the Vite application.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const POLICY_FILE = join(repoRoot, 'tooling', 'copilot-action-policy.json');

/** Verdicts a policy may assign to an action kind. Anything else fails closed. */
export const POLICY_VERDICTS = Object.freeze(['forbidden', 'step_up_required']);

/**
 * L6 membership is anchored in CODE, not read back from the file being checked.
 *
 * Đo 02/09/2026: bản trước chỉ kiểm "những gì ĐANG có trong l6Forever phải là
 * forbidden" — một bất biến vòng tròn. Xoá bớt phần tử khỏi mảng JSON thì mảng
 * còn lại vẫn thoả, validate PASS, và ba ranh giới vĩnh viễn teo đi mà không
 * test nào đỏ. Một hằng số trong mã là thứ duy nhất mà file dữ liệu không sửa
 * được: policy phải khớp ĐÚNG tập này, không thiếu và không thừa.
 */
export const L6_FOREVER = Object.freeze(['deploy', 'secret', 'sql']);

/**
 * Regex per action kind. A kind declared in the policy but missing here would be
 * a word with no detector behind it, so validateActionPolicy() rejects that.
 *
 * `decide_financial_request` is listed explicitly: it is THE approval RPC of this
 * codebase (src/hooks/useApprovals.ts) and its name contains none of the generic
 * approve/duyệt fragments — a blind spot measured on 2026-09-02.
 */
export const ACTION_PATTERNS = Object.freeze({
  approval: /(?:approve|approval|duyet|duyệt|decide_financial_request)[a-z0-9_]*(?:\s*\(|['"])/iu,
  posting: /(?:post|posting|ghi_so|ghiso|vao_so|vào_sổ)[a-z0-9_]*(?:\s*\(|['"])/iu,
  delete: /(?:delete|remove|xoa|xóa)[a-z0-9_]*(?:\s*\(|['"])|\.delete\s*\(/iu,
  permission: /(?:grant|revoke|set|change)[a-z0-9_]*(?:permission|permissions|quyen|quyền|role|roles)[a-z0-9_]*(?:\s*\(|['"])/iu,
  sql: /(?:run|execute|query)[a-z0-9_]*sql[a-z0-9_]*(?:\s*\(|['"])/iu,
  secret: /(?:secret|api[_-]?key|credential)[a-z0-9_]*\s*[:(=]/iu,
  deploy: /(?:deploy|release|vercel|migration)[a-z0-9_]*(?:\s*\(|['"])/iu,
});

/**
 * Validate a parsed action policy. THROWS instead of returning problems: a policy
 * that cannot be trusted must stop the gate, not degrade it into a softer gate.
 * Mutating `sql` to anything but "forbidden" is exactly the change this catches.
 */
export function validateActionPolicy(policy) {
  const problems = [];
  if (policy?.schemaVersion !== 1) problems.push('schemaVersion must be 1');

  const kinds = policy?.kinds;
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds) || Object.keys(kinds).length === 0) {
    problems.push('kinds must be a non-empty object');
  } else {
    for (const [kind, verdict] of Object.entries(kinds)) {
      if (!POLICY_VERDICTS.includes(verdict)) {
        problems.push(`${kind}: verdict "${verdict}" is not one of ${POLICY_VERDICTS.join('/')}`);
      }
      if (!ACTION_PATTERNS[kind]) {
        problems.push(`${kind}: no detector in ACTION_PATTERNS — a kind nobody can detect is a kind that does not exist`);
      }
    }
    // CHIỀU NGƯỢC — thứ mà bản trước thiếu. FORBIDDEN_COPILOT_ACTIONS suy ra từ
    // `Object.keys(kinds)` và chính nó là danh sách dùng để dò mã nguồn: xoá một
    // dòng khỏi JSON làm gate MÙ với loại hành động đó (đo 02/09/2026: bỏ
    // "delete" thì `.delete().eq(...)` bị chấm "guidance", problems rỗng, gate
    // XANH). Một bộ dò tồn tại mà không kind nào gọi tới là một cửa đã tháo.
    for (const kind of Object.keys(ACTION_PATTERNS)) {
      if (!Object.hasOwn(kinds, kind)) {
        problems.push(`${kind}: ACTION_PATTERNS has a detector but policy dropped the kind — the gate would go blind to it`);
      }
    }
  }

  const forever = policy?.l6Forever;
  if (!Array.isArray(forever)) problems.push('l6Forever must be an array');
  else {
    // So khớp HAI CHIỀU với hằng số trong mã: thiếu một mục là mất một ranh giới
    // vĩnh viễn, thừa một mục là policy nói về thứ hằng số không công nhận.
    const thuc = [...forever].map(String).sort();
    const mong = [...L6_FOREVER].sort();
    if (JSON.stringify(thuc) !== JSON.stringify(mong)) {
      const thieu = mong.filter((kind) => !thuc.includes(kind));
      const thua = thuc.filter((kind) => !mong.includes(kind));
      problems.push(
        `l6Forever must be exactly [${mong.join(', ')}] (anchored in code)` +
          `${thieu.length ? `; missing: ${thieu.join(', ')}` : ''}` +
          `${thua.length ? `; unexpected: ${thua.join(', ')}` : ''}`,
      );
    }
    for (const kind of forever) {
      if (!kinds || !Object.hasOwn(kinds, kind)) problems.push(`${kind}: listed in l6Forever but absent from kinds`);
      else if (kinds[kind] !== 'forbidden') {
        problems.push(`${kind}: l6Forever entries must stay "forbidden" (found "${kinds[kind]}")`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`tooling/copilot-action-policy.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return policy;
}

/** Read + validate the on-disk policy. */
export function readActionPolicy(file = POLICY_FILE) {
  return validateActionPolicy(JSON.parse(readFileSync(file, 'utf8')));
}

const ACTION_POLICY = readActionPolicy();

export const FORBIDDEN_COPILOT_ACTIONS = Object.freeze(Object.keys(ACTION_POLICY.kinds));

// Canonical aliases used by the provider-policy gate and external CI checks.
// Keep these names stable even though the source validator uses human-readable
// execution kinds above.
export const FORBIDDEN_ACTIONS = new Set([
  'approve',
  'post',
  'delete',
  'change_permissions',
  'run_sql',
  'manage_secrets',
  'deploy',
]);

const EXECUTION_KINDS = new Set([
  'draft',
  'guidance',
  ...FORBIDDEN_COPILOT_ACTIONS,
]);

function normalizeKind(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Validate a normalized tool inventory. Returns human-readable build errors. */
export function validateCopilotActionInventory(tools) {
  const problems = [];
  if (!Array.isArray(tools)) return ['tool inventory must be an array'];

  const names = new Set();
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (!name) {
      problems.push('tool requires a non-empty name');
      continue;
    }
    if (names.has(name)) problems.push(`duplicate tool name: ${name}`);
    names.add(name);

    const kind = normalizeKind(tool.executionKind);
    if (!kind || !EXECUTION_KINDS.has(kind)) {
      problems.push(`${name}: unknown execution kind "${tool.executionKind ?? ''}"`);
      continue;
    }
    // TODO(2026-09-02, G3): kinds marked `step_up_required` fail here EXACTLY like
    // `forbidden` ones, because the second factor they would require does not exist
    // yet — the registry action carrying `consent_required='step_up'` is G3 work.
    // When that table lands, this branch gains one condition (a step-up-consented
    // declaration is allowed) and `forbidden`/`l6Forever` keep failing outright.
    // Until then the policy verdict is documentation, not a weaker gate.
    // Lời khai lệch với bộ dò là một problem RIÊNG, không phải chuyện nội bộ của
    // parser. Nó nói lên một trong hai điều, và cả hai đều cần người đọc: hoặc
    // tool thật sự làm việc bị cấm mà tự khai là nháp, hoặc bộ dò báo động giả và
    // ACTION_PATTERNS cần sửa. Nuốt im lặng bên nào cũng sai.
    if (tool.declaredKind !== undefined) {
      const khai = normalizeKind(tool.declaredKind);
      if (khai !== kind) {
        problems.push(
          `${name}: khai executionKind "${tool.declaredKind}" nhung bo do thay "${kind}" trong than execute — loi khai khong duoc phep de len bo do`,
        );
      }
    }
    if (FORBIDDEN_COPILOT_ACTIONS.includes(kind)) {
      problems.push(`${name}: forbidden executable action "${kind}" (policy: ${ACTION_POLICY.kinds[kind]})`);
    }
  }
  return problems;
}

function stripComments(source) {
  return source
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract tool descriptors from Copilot source without importing browser-only
 * modules. The parser only inspects the executable portion of each declaration
 * so words in descriptions/comments cannot accidentally fail the gate.
 */
export function inventoryFromCopilotSource(sourceByFile) {
  const tools = [];
  for (const [file, raw] of Object.entries(sourceByFile ?? {})) {
    const source = stripComments(String(raw));
    const matches = [...source.matchAll(/\bname\s*:\s*['"]([a-z][a-z0-9_]*)['"]/giu)];
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index ?? 0;
      const end = matches[index + 1]?.index ?? source.length;
      const block = source.slice(start, end);
      const executeIndex = block.indexOf('execute:');
      const executable = executeIndex >= 0 ? block.slice(executeIndex) : '';
      // THỨ TỰ QUYẾT ĐỊNH — bộ dò THẮNG, chú thích chỉ là gợi ý.
      //
      // Bản trước (đo 02/09/2026) có hai đường vòng, và cả hai đều mở bằng cách
      // THÊM chữ chứ không phải xoá gì:
      //   (1) heuristic nháp chạy SAU vòng lặp cấm rồi GHI ĐÈ nó. Một tool
      //       `execute: async () => approve_income_expense_v1({ nonce })` bị chấm
      //       'approval' đúng một dòng, rồi chữ `nonce` kéo nó về 'draft' và gate
      //       XANH. Chữ "nonce" ở đây thậm chí là thật — nó vẫn là một lời gọi
      //       DUYỆT có thật.
      //   (2) `executionKind: 'draft'` khai tường minh thì nhảy qua cả vòng lặp
      //       cấm. Tức là tự khai mình vô hại là đủ để không bị soi — đúng thứ
      //       một cửa như thế này sinh ra để không tin.
      //
      // Nay: dò trước. Dò thấy hành động cấm thì đó là kết luận, bất kể chú thích
      // nói gì; chú thích lệch được GIỮ LẠI (`declaredKind`) để validator báo
      // thành một problem riêng — lệch giữa lời khai và mã là tín hiệu cần người
      // đọc, không phải thứ nuốt im lặng.
      let daDo = null;
      for (const action of FORBIDDEN_COPILOT_ACTIONS) {
        if (ACTION_PATTERNS[action].test(executable)) {
          daDo = action;
          break;
        }
      }
      const explicit = block.match(/\bexecutionKind\s*:\s*['"]([^'"]+)['"]/iu);
      const khai = explicit ? explicit[1] : null;

      let executionKind;
      if (daDo) executionKind = daDo;
      else if (khai) executionKind = khai;
      // Heuristic nháp chỉ chạy khi KHÔNG dò ra gì và cũng KHÔNG ai khai: nó là
      // phỏng đoán cuối cùng, không phải quyền phủ quyết.
      else if (/\b(?:preview|draft|nonce|confirmation)\b/iu.test(executable)) executionKind = 'draft';
      else executionKind = 'guidance';

      const tool = { name: matches[index][1], file, executionKind };
      if (daDo && khai && normalizeKind(khai) !== daDo) tool.declaredKind = khai;
      tools.push(tool);
    }
  }
  return tools;
}

/** Directories scanned by the gate, relative to the repo root. */
export const SCAN_ROOTS = Object.freeze([
  join('src', 'copilot', 'tools'),
  join('src', 'copilot', 'plan'),
]);

/**
 * Every `.ts` file under `roots`, recursively, minus `__tests__`.
 *
 * Replaces three hand-copied paths (2026-09-02). Those paths meant a FOURTH tool
 * file — or the whole `src/copilot/plan/` tree that later phases create — would
 * be invisible to this gate while the gate still reported green. A missing root
 * is not an error: `src/copilot/plan` does not exist yet and must not break CI.
 */
export function collectCopilotSourceFiles(roots) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(join(dir, entry.name));
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

function main() {
  const files = collectCopilotSourceFiles(SCAN_ROOTS.map((root) => join(repoRoot, root)));
  if (files.length === 0) {
    // Zero files means the scan is broken (renamed directory, wrong cwd), not that
    // the Copilot suddenly has no tools. A gate that measures nothing must say so.
    console.error(`Copilot forbidden-action gate: scanned ${SCAN_ROOTS.join(', ')} and found no source file — measurement is broken, not clean.`);
    process.exitCode = 1;
    return;
  }
  const sourceByFile = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const tools = inventoryFromCopilotSource(sourceByFile);
  const problems = validateCopilotActionInventory(tools);
  if (problems.length) {
    console.error(`Copilot forbidden-action gate: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot forbidden-action gate: ${tools.length} executable declaration(s) checked in ${files.length} file(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
