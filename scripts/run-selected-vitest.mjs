#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { selectedVitestFiles, assertCollectedSelection } from './lib/selected-vitest.mjs';

export async function runSelectedVitest(argv) {
  const argument = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
  const path = argument('--plan');
  const digest = argument('--selection-digest');
  if (!path || !digest) throw new Error('Required --plan <json> --selection-digest <sha256>');
  const files = selectedVitestFiles(JSON.parse(readFileSync(path, 'utf8')), digest);
  const { startVitest } = await import('vitest/node');
  let context;
  try {
    // include is an exact path list, not Vitest's substring CLI filter.
    // The gate can run beside other native suites. A worker per host CPU
    // oversubscribes the DOM/embedded-Postgres tests on developer machines.
    // Bound resources, while retaining the complete selection and its deadlines.
    context = await startVitest('test', [], { include: files, run: true, watch: false,
      maxWorkers: Math.min(2, availableParallelism()) });
    if (!context) throw new Error('Vitest did not return a test context');
    assertCollectedSelection(files, context.state.getFiles(), process.cwd());
  } finally { await context?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await runSelectedVitest(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = process.exitCode || 1; }
}
