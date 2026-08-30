import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateCopilotE2eFiles } from '../check-copilot-e2e-files.mjs';

test('required Copilot E2E specs cannot be omitted', () => {
  const problems = validateCopilotE2eFiles('C:/repo', ['.e2e-fleet/specs/copilot-readonly-smoke.spec.ts']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /required E2E spec is missing/);
});

test('Copilot E2E specs must attest the build and track console health', () => {
  const root = mkdtempSync(join(tmpdir(), 'copilot-e2e-gate-'));
  const file = '.e2e-fleet/specs/copilot-readonly-smoke.spec.ts';
  const path = join(root, file);
  const source = "import { test } from '@playwright/test'; test('smoke', async () => {});";
  mkdirSync(join(root, '.e2e-fleet/specs'), { recursive: true });
  writeFileSync(path, source);
  const problems = validateCopilotE2eFiles(root, [file]);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /build attestation/);
  assert.match(problems.join('\n'), /console tracking/);
});
