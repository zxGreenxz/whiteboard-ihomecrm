import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

async function openSettlement(page: Page) {
  await login(page, 'chunha');
  await page.evaluate(() => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('hop_dong'));
    sessionStorage.setItem('flt:thu-tien:month', JSON.stringify('2026-09'));
  });
  await page.goto('/thanh-toan');
  await expect(page.locator('.ptt-settlement-panel')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Khoản chi' })).toBeVisible();
}

test('Khoản chi follows the approved 3-card/4-card design and exposes the full filters', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openSettlement(page);

  await expect(page.getByTestId('settlement-stat')).toHaveCount(3);
  await expect(page.getByText('Cần rà soát', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Chờ Duyệt và Chi', { exact: true })).toBeVisible();
  await expect(page.getByText('Đã chi', { exact: true }).first()).toBeVisible();

  await page.getByRole('checkbox', { name: 'Gộp Chờ duyệt và Chi' }).uncheck();
  await expect(page.getByTestId('settlement-stat')).toHaveCount(4);
  await expect(page.getByText('Chờ duyệt', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Chờ chi', { exact: true }).first()).toBeVisible();

  await expect(page.getByRole('textbox', { name: 'Tìm khoản chi' })).toBeVisible();
  await page.getByRole('button', { name: 'Bộ lọc' }).click();
  await expect(page.getByRole('combobox', { name: 'Nguồn' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Người nhận' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Trạng thái' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Vướng mắc' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Theo ngày' })).toBeVisible();
  expect(errors, 'console errors').toEqual([]);
});

test('Biến động shows all five lifecycle groups and keeps the payment tab separate', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openSettlement(page);

  await page.getByRole('tab', { name: 'Biến động' }).click();
  await expect(page.getByRole('tab', { name: 'Biến động' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('event-stat')).toHaveCount(5);
  for (const label of ['Ký mới', 'Gia hạn', 'Thanh lý', 'Bỏ cọc', 'Giữ chỗ']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('table', { name: 'Danh sách biến động' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Danh sách khoản chi' })).toBeHidden();
  expect(errors, 'console errors').toEqual([]);
});

test('a real DEMO settlement row opens the large lifecycle and voucher detail modal', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openSettlement(page);

  await page.getByRole('button', { name: 'Bộ lọc' }).click();
  await page.getByRole('combobox', { name: 'Trạng thái' }).selectOption('all');
  const rows = page.getByRole('table', { name: 'Danh sách khoản chi' }).locator('.cs-grid-row:not(.cs-grid-head)');
  await expect.poll(() => rows.count(), { message: 'DEMO phải có ít nhất một khoản quyết toán để kiểm modal' }).toBeGreaterThan(0);
  await rows.first().getByRole('button').last().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Vòng đời hợp đồng của phòng' })).toBeVisible();
  await expect(dialog.locator('.cs-lifecycle-lane').first()).toBeVisible();
  await expect(dialog.getByRole('complementary', { name: 'Thông tin phiếu và xử lý' })).toBeVisible();
  await expect(dialog.getByText(/Đối chiếu hợp đồng & dòng tiền/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Lập phiếu chờ duyệt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Chuyển chờ duyệt' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Đóng hồ sơ' })).toBeVisible();
  expect(errors, 'console errors').toEqual([]);
});
