import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectionDigest, selectedVitestFiles, assertCollectedSelection, shardSelection } from '../lib/selected-vitest.mjs';
import { getGate } from '../lib/gate-registry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = join(root, 'scripts/run-selected-vitest.mjs');
const planFor = (files) => ({ environment: 'ci', suiteSelections: [{ id: 'app-unit', mode: 'all', files }] });

test('selection digest is order independent and rejects changed/empty/duplicate/unsafe selection', () => {
  const files = ['src/b.test.ts', 'src/a.test.ts'];
  assert.equal(selectionDigest(files), selectionDigest([...files].reverse()));
  assert.deepEqual(selectedVitestFiles(planFor(files), selectionDigest(files)), [...files].sort());
  assert.throws(() => selectedVitestFiles(planFor(files), 'other'), /digest/);
  for (const invalid of [[], ['src/a.test.ts', 'src/a.test.ts'], ['../x.test.ts'], ['/x.test.ts'], ['src/*.test.ts'], ['C:/x.test.ts']]) {
    assert.throws(() => selectedVitestFiles(planFor(invalid), 'unused'), /selection|path|duplicate/i);
  }
  assert.throws(() => assertCollectedSelection(['src/a.test.ts'], [], root), /not collected/);
  assert.throws(() => assertCollectedSelection(['src/a.test.ts'], [{ filepath: join(root, 'src/a.test.ts') }, { filepath: join(root, 'src/extra.test.ts') }], root), /unexpected/i);
});

test('parts are disjoint, balanced and together exactly the selection; a bad or empty part fails', () => {
  const files = Array.from({ length: 1023 }, (_, i) => `src/dir-${i % 7}/f${i}.test.ts`).reverse();
  const parts = [1, 2, 3].map((k) => shardSelection(files, `${k}/3`));
  assert.deepEqual(parts.flat().sort(), [...files].sort());
  assert.equal(new Set(parts.flat()).size, files.length);
  assert.deepEqual(parts.map((part) => part.length), [341, 341, 341]);
  assert.deepEqual(shardSelection(files, `2/3`), shardSelection([...files].reverse(), '2/3'));
  assert.equal(shardSelection(files, null), files);
  for (const invalid of ['0/3', '4/3', '1/1', '1', 'undefined', '1/x']) assert.throws(() => shardSelection(files, invalid), /Invalid --shard/);
  assert.throws(() => shardSelection(['src/a.test.ts'], '2/2'), /no files/);
});

test('full app suite launches with bounded argv and binds the complete selection', () => {
  const files = Array.from({ length: 1500 }, (_, i) => `src/deep/component-${i}/behavior.test.ts`);
  const gate = getGate('suite:app-unit', planFor(files));
  assert.ok(gate.args.join(' ').length < 300);
  assert.deepEqual(gate.args.slice(0, 3), ['scripts/run-selected-vitest.mjs', '--plan', '.gate-evidence/plan.json']);
  assert.equal(gate.args.at(-1), selectionDigest(files));
  assert.equal(getGate('suite:app-unit', { ...planFor(files), environment: 'local' }).args[2], '.cache/gate-receipts/plan.json');
});

test('real installed Vitest runs exact selected file, retains failure and rejects uncollected selection', (t) => {
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(join(cache, 'selected-vitest-'));
  t.after(() => {
    assert.equal(dirname(resolve(fixture)), resolve(cache));
    rmSync(fixture, { recursive: true, force: true });
  });
  mkdirSync(join(fixture, 'src'));
  writeFileSync(join(fixture, 'vite.config.mjs'), `export default { test: { maxWorkers: 1, fileParallelism: false, exclude: ['src/excluded.test.mjs'] } };`);
  // Dynamic imports keep generated fixture imports distinct from this node:test file's imports.
  writeFileSync(join(fixture, 'src/chosen.test.mjs'), `const { test, expect } = await import('vitest'); test('selected pass', () => expect(1).toBe(1));`);
  writeFileSync(join(fixture, 'src/chosen-other.test.mjs'), `const { test, expect } = await import('vitest'); test('unselected failure', () => expect(1).toBe(2));`);
  writeFileSync(join(fixture, 'src/excluded.test.mjs'), `const { test } = await import('vitest'); test('excluded', () => {});`);
  const run = (files, extra = []) => {
    const path = join(fixture, 'plan.json');
    writeFileSync(path, JSON.stringify(planFor(files)));
    return spawnSync(process.execPath, [launcher, '--plan', path, '--selection-digest', selectionDigest(files), ...extra], { cwd: fixture, encoding: 'utf8', timeout: 20_000 });
  };
  // Sorted: chosen-other (fails) is part 1/2, chosen (passes) is part 2/2.
  const both = ['src/chosen.test.mjs', 'src/chosen-other.test.mjs'];
  const secondPart = run(both, ['--shard', '2/2']);
  assert.equal(secondPart.status, 0, secondPart.stdout + secondPart.stderr);
  assert.doesNotMatch(secondPart.stdout + secondPart.stderr, /unselected failure/);
  const firstPart = run(both, ['--shard', '1/2']);
  assert.equal(firstPart.status, 1, firstPart.stdout + firstPart.stderr);
  const noValue = run(both, ['--shard']);
  assert.equal(noValue.status, 1, noValue.stdout + noValue.stderr);
  assert.match(noValue.stderr, /Invalid --shard/);
  // The joined spelling selects the same part; it never falls back to the whole selection.
  const joined = run(both, ['--shard=2/2']);
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  assert.doesNotMatch(joined.stdout + joined.stderr, /unselected failure/);
  const joinedBad = run(both, ['--shard=3/2']);
  assert.equal(joinedBad.status, 1, joinedBad.stdout + joinedBad.stderr);
  assert.match(joinedBad.stderr, /Invalid --shard/);
  const passed = run(['src/chosen.test.mjs']);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.doesNotMatch(passed.stdout + passed.stderr, /unselected failure/);
  const failed = run(['src/chosen-other.test.mjs']);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const missing = run(['src/chosen.test.mjs', 'src/excluded.test.mjs']);
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /not collected/);
});
