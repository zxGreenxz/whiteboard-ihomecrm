import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { cleanupFleetCashbook } from './accounting-admin';

// Mỗi test() = 1 worker = 1 trình duyệt song song. Chiến lược: đăng nhập demo,
// vào đúng trang, kích flow, và KHẲNG ĐỊNH request trúng canonical RPC (waitForResponse)
// + 0 app-console-error. Không phụ thuộc chi tiết DOM mong manh — bám vào network.

const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);

// ── 1. Đăng nhập 3 vai (chứng minh 3 phiên browser độc lập song song) ──
for (const who of ['chunha', 'ketoan', 'quanly'] as const) {
  test(`login-${who}`, async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, who);
    // Bám baseURL thay vì hard-code ptcrm.vercel.app: spec phải chạy được cả khi
    // FLEET_BASE_URL trỏ vào bản build local (xác minh trước khi deploy).
    await expect(page).not.toHaveURL(/\/login\b/);
    await expect(page).toHaveURL(/^https?:\/\//);
    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  });
}

// ── 2. Phiếu thu/chi: mở form Thêm phiếu lẻ (chứng minh trang + form render) ──
test('income-expense-open-form', async ({ page }) => {
  await login(page, 'chunha');
  await page.goto('/income-expense');
  await expect(page.getByRole('heading', { name: 'Thu chi' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();
});

// ── 3. Hoá đơn: trang load + có bảng ──
test('invoices-page-loads', async ({ page }) => {
  await login(page, 'chunha');
  await page.goto('/invoices');
  await expect(page.getByRole('heading', { name: /Hoá đơn|Hóa đơn/i })).toBeVisible();
});

// ── 4. Sổ quỹ: tạo sổ mới qua UI → khẳng định trúng create_cashbook_v1 ──
test('cashbook-create-canonical', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const name = `E2E Fleet ${Date.now()}`;
  try {
    await login(page, 'chunha');
    await page.goto('/finance/cashbooks');
    await page.getByRole('button', { name: /Thêm sổ quỹ/i }).click();
    await page.getByRole('textbox', { name: /Tên sổ quỹ/i }).fill(name);
    const [resp] = await Promise.all([
      page.waitForResponse(RPC('create_cashbook_v1'), { timeout: 30_000 }),
      page.getByRole('button', { name: /^Lưu$/ }).click(),
    ]);
    expect(resp.status(), 'create_cashbook_v1 status').toBeLessThan(300);
    expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    // Bài này từng bỏ lại sổ quỹ trong org DEMO mỗi lần chạy (6 sổ rác tính tới
    // 26/07). finally: dọn cả khi assertion fail — sổ vẫn có thể đã được tạo.
    await cleanupFleetCashbook(name);
  }
});

// ── 5. Phiếu thu/chi: xem danh sách + đổi tab trạng thái (UI ổn định) ──
test('income-expense-list-tabs', async ({ page }) => {
  await login(page, 'ketoan');
  await page.goto('/income-expense');
  await expect(page.getByRole('tab', { name: 'Tất cả' })).toBeVisible();
  await page.getByRole('tab', { name: 'Tất cả' }).click();
  // chỉ cần không văng lỗi + bảng/empty-state hiện
  await expect(page.getByRole('heading', { name: 'Thu chi' })).toBeVisible();
});
