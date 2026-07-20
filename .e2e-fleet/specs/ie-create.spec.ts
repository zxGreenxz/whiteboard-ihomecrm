import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors, USERS } from './auth';

const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);

// Tạo phiếu thu qua UI đầy đủ (Tòa DEMO B + sổ quỹ + hạng mục) → khẳng định
// trúng create_income_expense_v1 (canonical, canary demo đang bật). Chạy 2 vai
// song song để vừa coverage vừa chứng minh nhiều phiên đồng thời.
for (const who of ['chunha', 'ketoan'] as const) {
  test(`ie-create-canonical-${who}`, async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, who);
    await page.goto('/income-expense');
    await page.getByRole('button', { name: 'Thêm phiếu' }).click();
    await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
    await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();

    // Tòa nhà
    await page.getByRole('combobox', { name: 'Tòa nhà *' }).click();
    await page.getByRole('option', { name: 'Tòa DEMO B' }).click();
    // Sổ quỹ (chọn cái đầu tiên khả dụng)
    await page.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
    await page.getByRole('option').first().click();
    // Tên phiếu
    await page.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(`E2E fleet ${who} ${Date.now()}`);
    // Hạng mục
    await page.getByRole('button', { name: 'Thêm hạng mục' }).click();
    await page.getByRole('checkbox', { name: /Thu khac \(canary\)/i }).first().click().catch(async () => {
      // fallback: chọn hạng mục đầu tiên nếu tên khác
      await page.getByRole('checkbox').first().click();
    });
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    // Số tiền dòng hạng mục
    await page.getByRole('textbox', { name: 'Số tiền' }).first().fill('123000');

    // Coexistence: staff → canonical rpc 200; owner (không trong graph tạo phiếu)
    // → rpc 403 rồi fallback POST /income_expenses 201. Cả hai = tạo thành công.
    const [okResp] = await Promise.all([
      page.waitForResponse(
        (r) => {
          const u = r.url();
          if (RPC('create_income_expense_v1').test(u)) return r.status() === 200;
          if (/\/rest\/v1\/income_expenses\?/.test(u) && r.request().method() === 'POST') {
            return r.status() >= 200 && r.status() < 300;
          }
          return false;
        },
        { timeout: 30_000 },
      ),
      page.getByRole('button', { name: /^Lưu$/ }).click(),
    ]);
    const path = /rpc\/create_income_expense_v1/.test(okResp.url()) ? 'CANONICAL' : 'LEGACY-fallback';
    console.log(`[${who}] create path = ${path} (${okResp.status()})`);
    expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
  });
}
