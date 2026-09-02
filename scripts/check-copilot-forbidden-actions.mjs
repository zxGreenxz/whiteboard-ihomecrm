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
  }

  const forever = policy?.l6Forever;
  if (!Array.isArray(forever) || forever.length === 0) problems.push('l6Forever must be a non-empty array');
  else {
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
      let executionKind = 'guidance';
      const explicit = block.match(/\bexecutionKind\s*:\s*['"]([^'"]+)['"]/iu);
      if (explicit) executionKind = explicit[1];
      else {
        for (const action of FORBIDDEN_COPILOT_ACTIONS) {
          if (ACTION_PATTERNS[action].test(executable)) {
            executionKind = action;
            break;
          }
        }
        if (/\b(?:preview|draft|nonce|confirmation)\b/iu.test(executable)) executionKind = 'draft';
      }
      tools.push({ name: matches[index][1], file, executionKind });
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
