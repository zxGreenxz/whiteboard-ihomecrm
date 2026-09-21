// =============================================================================
// Page /thanh-toan after the contract-settlement cutover.
//
// Desktop owns the wide "Hợp đồng & quyết toán" workbench. Mobile deliberately
// keeps the compact payment overview and does not mount the wide workbench.
// =============================================================================

import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

async function chooseSettlement(page: Page) {
  await page.evaluate(() => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('hop_dong'));
    sessionStorage.setItem('flt:thu-tien:month', JSON.stringify('2026-09'));
  });
  await page.goto('/thanh-toan');
}

test('deep-link desktop opens the wide contract-settlement workbench without the phone surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await chooseSettlement(page);

  await expect(page.locator('.ptt-settlement-panel')).toBeVisible();
  await expect(page.locator('.ptt-title')).toContainText('Hợp đồng & quyết toán');
  await expect(page.locator('.contract-settlement')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Khoản chi' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tt-phone-col')).toBeHidden();
  const frame = await page.locator('.ptt-settlement-panel').boundingBox();
  expect(frame).not.toBeNull();
  expect(frame!.width).toBeCloseTo(1180, 0);
  expect(frame!.x).toBeCloseTo(130, 0);
  expect(frame!.y).toBeCloseTo(24, 0);

  await page.locator('.ptt-trigger').click();
  await expect(page.getByRole('button', { name: 'Hợp đồng & quyết toán', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Chi thanh lý/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Thưởng sale/ })).toHaveCount(0);
  expect(errors, 'console errors').toEqual([]);
});

test('mobile keeps a safe overview and omits the unsupported settlement workbench', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await chooseSettlement(page);

  await expect(page.locator('.ptt-panel')).toBeHidden();
  await expect(page.locator('.tt-phone-col .ptt-sheet')).toBeVisible();
  await expect(page.locator('.tt-phone-col .ptt-m-lbltxt')).toContainText('Tổng quan kỳ');
  await expect(page.locator('.tt-phone-col .contract-settlement')).toHaveCount(0);

  await page.locator('.tt-phone-col .ptt-m-trigger').click();
  await expect(page.locator('.tt-phone-col .ptt-picker')).toHaveClass(/show/);
  await expect(page.locator('.tt-phone-col .ptt-picker').getByText('Hợp đồng & quyết toán')).toHaveCount(0);
  expect(errors, 'console errors').toEqual([]);
});

test('back from a direct settlement deep-link returns to Thu tiền', async ({ page }) => {
  await login(page, 'chunha');
  await chooseSettlement(page);

  await page.locator('.ptt-panel .ud-back').click();
  await expect(page).toHaveURL(/\/thu-tien$/);
  await expect(page.locator('.tt-manage')).toBeVisible();
});

test('Thanh toán remains available from the mobile finance launcher', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'chunha');
  await page.goto('/');

  const tile = page.locator('a[href="/thanh-toan"]');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('Thanh toán');
  const section = page.locator('section.lsec', { has: tile });
  await expect(section).toContainText('Tài chính');
});
