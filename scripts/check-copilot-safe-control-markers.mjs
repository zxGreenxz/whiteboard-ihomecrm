#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function validateSafeControlMarkers(contracts, sourceByFile) {
  const expected = new Set();
  for (const page of contracts ?? []) {
    for (const controlId of page.safeControlIds ?? []) expected.add(`${page.key}.${controlId}`);
  }

  const seen = new Map();
  const problems = [];
  for (const [file, source] of sourceByFile) {
    const re = /data-ai-safe\s*=\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(re)) {
      const marker = match[1];
      if (!expected.has(marker)) problems.push(`${file}: unknown marker ${marker}`);
      const previous = seen.get(marker);
      if (previous) problems.push(`duplicate marker ${marker}: ${previous} and ${file}`);
      seen.set(marker, file);
    }
  }
  for (const marker of expected) {
    if (!seen.has(marker)) problems.push(`missing marker ${marker}`);
  }
  return problems;
}

function loadContracts(repoRoot) {
  const source = [
    "import { COPILOT_PAGE_CONTRACTS } from '../src/app/capabilities/registry';",
    'console.log(JSON.stringify(COPILOT_PAGE_CONTRACTS));',
  ].join('\n');
  // Keep the importer in this checkout; node_modules may be junctioned to a
  // different worktree and would otherwise resolve the wrong registry.
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot_safe_contracts.mts');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source, 'utf8');
  try {
    const result = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_safe_contracts.mts'], {
      cwd: repoRoot, encoding: 'utf8', shell: true, timeout: 120_000,
    });
    const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const contracts = loadContracts(repoRoot);
  if (!contracts) {
    console.error('Unable to load Copilot page contracts');
    process.exitCode = 3;
    return;
  }
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = join(repoRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir)) {
      const relative = join(relativeDir, entry);
      const absolute = join(repoRoot, relative);
      if (statSync(absolute).isDirectory()) visit(relative);
      else if (/\.(?:tsx?|jsx?)$/u.test(entry)) files.push(relative);
    }
  };
  visit('src/pages');
  visit('src/components');
  const sourceByFile = new Map(files.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
  const problems = validateSafeControlMarkers(contracts, sourceByFile);
  if (problems.length) {
    console.error(`Copilot safe-control markers: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot safe-control markers: ${[...sourceByFile.values()].join('').match(/data-ai-safe\s*=/g)?.length ?? 0} marker(s) valid.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
