import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMockGoldenEval } from '../run-copilot-golden-eval.mjs';

test('real CLI refuses an inferred array; lane relabelling cannot make mock output real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'real-cli-'));
  try {
    const golden = JSON.parse(readFileSync(new URL('../../tooling/copilot-golden-eval.json', import.meta.url)));
    const path = join(dir, 'old.json'); writeFileSync(path, JSON.stringify(runMockGoldenEval(golden)));
    const result = spawnSync(process.execPath, ['scripts/run-copilot-golden-eval.mjs','--lane','real-model','--build-sha','a'.repeat(40),'--provider-model','9router:cx/gpt-5.6-luna(max)','--results',path], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /browser evidence schema v2/);
    assert.equal(result.stdout.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy generator rejects scope truncation without making any network request', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-copilot-golden-real-results.mjs','--limit','1','--results-out','unused.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /full-corpus/);
});

test('explicit case selection rejects empty, unknown and duplicate IDs before browser setup', () => {
  for (const value of ['', 'C31,C31','C99','C31,',' C31','C31, C32']) {
    const result = spawnSync(process.execPath,['scripts/generate-copilot-golden-real-results.mjs','--case-ids',value,'--results-out','unused.json','--attestation','missing.json'], { encoding:'utf8' });
    assert.equal(result.status,2); assert.match(result.stderr,/Invalid --case-ids selection/); assert.equal(result.stdout.trim(),'');
  }
});
test('known explicit selection proceeds only to required attestation preflight', () => {
  const result = spawnSync(process.execPath,['scripts/generate-copilot-golden-real-results.mjs','--case-ids','C31,C32,C33','--results-out','unused.json','--attestation','missing.json'], { encoding:'utf8' });
  assert.equal(result.status,2); assert.match(result.stderr,/Missing --results-out or --attestation/); assert.equal(result.stdout.trim(),'');
});
