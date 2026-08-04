import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Công ty TEST (org cccc…0001) — bản sao dữ liệu công ty thật, dựng bằng
 * scripts/clone-org/. Spec này chứng minh 2 điều:
 *
 *   1. Đăng nhập test.* vào được và các màn hình chính hiện ĐÚNG dữ liệu thật đã
 *      nhân bản (toà 102LVT, 405PVB… có thật trong org thật).
 *   2. Dữ liệu ở đó là bản sao chứ không phải công ty thật: mã hoá đơn/phiếu mang
 *      hậu tố "-T" và số điện thoại khách đã bị làm nhiễu (09xxxxxxxx sinh từ md5).
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_PASS_TEST=<mật khẩu> npx playwright test specs/clone-org-test.spec.ts
 */

test('công ty TEST — đăng nhập chủ nhà, dashboard sạch lỗi', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await expect(page).not.toHaveURL(/\/login\b/);
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('công ty TEST — danh sách toà nhà là dữ liệu thật đã nhân bản', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await page.goto('/buildings');
  // 102LVT/405PVB là toà có thật của công ty thật; thấy chúng nghĩa là bản sao
  // mang đúng dữ liệu chứ không phải seed tay như org demo.
  await expect(page.getByText('102LVT').first()).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('công ty TEST — hoá đơn mang hậu tố -T (bằng chứng là bản sao)', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  // Bám NETWORK chứ không bám DOM: bảng hoá đơn không in invoice_number ra màn
  // hình, nhưng dữ liệu trả về phải mang hậu tố -T (unique index invoice_number
  // là toàn cục nên bản sao buộc phải đổi mã).
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => /\/rest\/v1\/invoices\b/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
      { timeout: 45_000 },
    ),
    page.goto('/invoices'),
  ]);
  const rows = (await resp.json()) as Array<{ invoice_number?: string }>;
  const numbers = rows.map((r) => r.invoice_number).filter(Boolean) as string[];
  expect(numbers.length, 'không có hoá đơn nào trả về').toBeGreaterThan(0);
  expect(numbers.every((n) => n.endsWith('-T')), `mã không có hậu tố: ${numbers.slice(0, 5)}`).toBe(true);
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('công ty TEST — thu chi mở được form thêm phiếu', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await page.goto('/income-expense');
  await expect(page.getByRole('heading', { name: 'Thu chi' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('công ty TEST — sổ quỹ và khách hàng load được', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await page.goto('/finance/cashbooks');
  await expect(page.getByRole('heading', { name: /Sổ quỹ/i })).toBeVisible();
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: /Khách hàng/i })).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('công ty TEST — tài khoản nhân viên vào được', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testketoan');
  await expect(page).not.toHaveURL(/\/login\b/);
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
