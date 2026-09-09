import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

// Read-only smoke against deployed RPCs with the DEMO owner. The two new writer
// RPCs are blocked in the browser; isolated integration tests exercise writes.
test.use({ serviceWorkers: 'block' });
test('DEMO: reservation ledger, live preview and cancel without money writes', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const moneyWrites: string[] = [];
  await page.route(/\/rest\/v1\/rpc\/(settle_reservation_deposit_v1|pay_reservation_refund_v1)/, async (route) => {
    moneyWrites.push(new URL(route.request().url()).pathname);
    await route.abort('blockedbyclient');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, 'chunha');
  const ledgerResponse = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname.endsWith('/income_expenses') &&
      (url.searchParams.get('select') || '').includes('reservation_deposit_settlements');
  });
  await page.goto('/deposits');
  if (process.env.FLEET_EXPECT_BUILD_SHA) {
    await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content', process.env.FLEET_EXPECT_BUILD_SHA);
  }
  expect((await ledgerResponse).status()).toBe(200);
  await page.getByRole('button', { name: /^Sổ cọc đầy đủ/ }).click();
  await page.getByRole('tab', { name: 'Phiếu giữ chỗ', exact: true }).click();
  const settleButton = page.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).first();
  await expect(settleButton).toBeVisible();
  const previewResponse = page.waitForResponse((res) => res.url().includes('/rpc/preview_reservation_settlement_v1'));
  await settleButton.click();
  expect((await previewResponse).status()).toBe(200);
  const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
  await expect(dialog.getByText('Cọc thực nhận:', { exact: false })).toBeVisible();
  await expect(dialog.getByLabel('Hoàn lại khách', { exact: true })).toHaveValue('0');
  await expect(dialog.getByText('Giữ lại → doanh thu', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(moneyWrites).toEqual([]);
  expect(errors).toEqual([]);
});
