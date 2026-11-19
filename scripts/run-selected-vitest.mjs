#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { selectedVitestFiles, validateExactVitestFiles, assertCollectedSelection } from './lib/selected-vitest.mjs';

function filesFromArgs(argv) {
  if (argv[0] === '--files') {
    const files = argv.slice(1);
    validateExactVitestFiles(files);
    return files;
  }
  const argument = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
  const path = argument('--plan');
  const digest = argument('--selection-digest');
  if (!path || !digest) throw new Error('Required --plan <json> --selection-digest <sha256>');
  return selectedVitestFiles(JSON.parse(readFileSync(path, 'utf8')), digest);
}

export async function runSelectedVitest(argv) {
  const files = filesFromArgs(argv);
  const { startVitest } = await import('vitest/node');
  let context;
  try {
    // include is an exact path list, not Vitest's substring CLI filter.
    // The CI app job has its own runner. Local runs share the machine with
    // the other gates, including suites that start PostgreSQL.
    const dedicatedAppRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_JOB === 'vitest-tests';
    const maxWorkers = Math.min(files.length, availableParallelism(), dedicatedAppRunner ? 4 : 2);
    console.log(`Vitest: ${files.length} files, up to ${maxWorkers} workers`);
    context = await startVitest('test', [], { include: files, run: true, watch: false, maxWorkers });
    if (!context) throw new Error('Vitest did not return a test context');
    assertCollectedSelection(files, context.state.getFiles(), process.cwd());
  } finally { await context?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await runSelectedVitest(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = process.exitCode || 1; }
}
