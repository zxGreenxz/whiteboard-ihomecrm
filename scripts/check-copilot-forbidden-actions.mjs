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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_COPILOT_ACTIONS = Object.freeze([
  'approval',
  'posting',
  'delete',
  'permission',
  'sql',
  'secret',
  'deploy',
]);

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

const ACTION_PATTERNS = Object.freeze({
  approval: /(?:approve|approval|duyet|duyệt)[a-z0-9_]*(?:\s*\(|['"])/iu,
  posting: /(?:post|posting|ghi_so|ghiso|vao_so|vào_sổ)[a-z0-9_]*(?:\s*\(|['"])/iu,
  delete: /(?:delete|remove|xoa|xóa)[a-z0-9_]*(?:\s*\(|['"])|\.delete\s*\(/iu,
  permission: /(?:grant|revoke|set|change)[a-z0-9_]*(?:permission|permissions|quyen|quyền|role|roles)[a-z0-9_]*(?:\s*\(|['"])/iu,
  sql: /(?:run|execute|query)[a-z0-9_]*sql[a-z0-9_]*(?:\s*\(|['"])/iu,
  secret: /(?:secret|api[_-]?key|credential)[a-z0-9_]*\s*[:(=]/iu,
  deploy: /(?:deploy|release|vercel|migration)[a-z0-9_]*(?:\s*\(|['"])/iu,
});

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
    if (FORBIDDEN_COPILOT_ACTIONS.includes(kind)) {
      problems.push(`${name}: forbidden executable action "${kind}"`);
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

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    join(repoRoot, 'src', 'copilot', 'tools', 'registry.ts'),
    join(repoRoot, 'src', 'copilot', 'tools', 'nghiepVuTools.ts'),
    join(repoRoot, 'src', 'copilot', 'tools', 'writeTools.ts'),
  ];
  const sourceByFile = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const tools = inventoryFromCopilotSource(sourceByFile);
  const problems = validateCopilotActionInventory(tools);
  if (problems.length) {
    console.error(`Copilot forbidden-action gate: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot forbidden-action gate: ${tools.length} executable declaration(s) checked.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
