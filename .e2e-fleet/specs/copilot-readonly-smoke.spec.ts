import { expect, test } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { xacMinhBanBuild } from './buildAttestation';

test('Copilot readonly smoke stays on the contracted surface', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await xacMinhBanBuild(page);
  await page.goto('/apartments');
  await expect(page.getByTestId('copilot-launcher')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('copilot-launcher').click();
  await expect(page.getByTestId('copilot-input')).toBeVisible();
  await page.getByTestId('copilot-input').fill('Phòng nào đang trống?');
  await page.getByTestId('copilot-send').click();
  await expect(page.getByTestId('copilot-panel')).toContainText(/phòng|trống/i, { timeout: 60_000 });
  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toEqual([]);
});
