import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

const root = new URL('../../', import.meta.url);
let bundleDir;
let danhGiaTienDeBatch;

test.before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'copilot-batch-preflight-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: fileURLToPath(new URL('../specs/copilotBatchPreflight.ts', import.meta.url)),
      outDir: bundleDir,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'copilotBatchPreflight.mjs' } },
    },
  });
  ({ danhGiaTienDeBatch } = await import(
    pathToFileURL(join(bundleDir, 'copilotBatchPreflight.mjs')).href
  ));
});

test.after(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

test('batch preflight accepts either supported ceiling for the real sysadmin actor', () => {
  for (const maxDirectRisk of ['L4', 'L5']) {
    assert.deepEqual(
      danhGiaTienDeBatch({ maxDirectRisk, allowedRoles: ['superadmin'] }, { status: 200 }),
      { dat: true, lyDo: '' },
    );
  }
});

test('batch preflight fails closed for unsupported ceilings and a disallowed sysadmin', () => {
  assert.match(
    danhGiaTienDeBatch({ maxDirectRisk: 'L3', allowedRoles: ['superadmin'] }, { status: 200 }).lyDo,
    /L3.*L4.*L5/,
  );
  assert.match(
    danhGiaTienDeBatch({ maxDirectRisk: 'L5', allowedRoles: ['owner'] }, { status: 200 }).lyDo,
    /superadmin.*owner/,
  );
});

test('batch preflight reports the real DEMO action preview failure', () => {
  assert.match(
    danhGiaTienDeBatch(
      { maxDirectRisk: 'L5', allowedRoles: ['superadmin'] },
      { status: 403, detail: 'income_expenses.create not permitted' },
    ).lyDo,
    /DEMO.*403.*income_expenses\.create not permitted/,
  );
});
