import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, trackConsoleErrors } from './auth';
import { xacMinhBanBuild } from './buildAttestation';

// Playwright runs with `.e2e-fleet` as cwd; resolve the repo-level contract explicitly.
const GOLDEN = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tooling', 'copilot-golden-eval.json'),
    'utf8',
  ),
);

test('golden readonly lane has an explicit 30-case contract', async ({ page }) => {
  expect(GOLDEN.cases).toHaveLength(30);
  expect(GOLDEN.provenance.lane).toEqual(expect.arrayContaining(['mock', 'real-model']));
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await xacMinhBanBuild(page);
  await page.goto('/apartments');
  await expect(page.getByTestId('copilot-launcher')).toBeVisible({ timeout: 30_000 });
  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toEqual([]);
});
