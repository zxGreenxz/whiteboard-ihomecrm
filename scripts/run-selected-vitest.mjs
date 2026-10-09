#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectedVitestFiles, assertCollectedSelection, shardSelection } from './lib/selected-vitest.mjs';

export async function runSelectedVitest(argv) {
  const argument = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
  const path = argument('--plan');
  const digest = argument('--selection-digest');
  if (!path || !digest) throw new Error('Required --plan <json> --selection-digest <sha256>');
  // The digest binds the whole selection; a shard runs and proves only its own part.
  const files = shardSelection(selectedVitestFiles(JSON.parse(readFileSync(path, 'utf8')), digest), argv.includes('--shard') ? String(argument('--shard')) : null);
  if (argv.includes('--shard')) console.log(`Vitest phần ${argument('--shard')}: ${files.length} file`);
  const { startVitest } = await import('vitest/node');
  let context;
  try {
    // include is an exact path list, not Vitest's substring CLI filter.
    context = await startVitest('test', [], { include: files, run: true, watch: false });
    if (!context) throw new Error('Vitest did not return a test context');
    assertCollectedSelection(files, context.state.getFiles(), process.cwd());
  } finally { await context?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await runSelectedVitest(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = process.exitCode || 1; }
}
