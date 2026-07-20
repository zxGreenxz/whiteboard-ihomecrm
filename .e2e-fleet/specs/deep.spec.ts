import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

// Fleet browser mở rộng — các trang/flow trọng yếu còn lại. Bám network + heading
// ổn định, không phụ thuộc DOM mong manh. Mục tiêu: chứng minh mọi trang tiền
// render + không có app-exception khi tải, ở nhiều phiên song song.

const PAGES: [string, string, RegExp][] = [
  ['finance-cashbooks', '/finance/cashbooks', /sổ quỹ|Sổ quỹ|Quỹ/i],
  ['invoices', '/invoices', /Hoá đơn|Hóa đơn/i],
  ['income-expense', '/income-expense', /Thu chi/i],
];

for (const [name, path, heading] of PAGES) {
  for (const who of ['chunha', 'ketoan'] as const) {
    test(`page-${name}-${who}`, async ({ page }) => {
      const errs = trackConsoleErrors(page);
      await login(page, who);
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      await page.waitForTimeout(1500); // để các query nền chạy
      expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
    });
  }
}

// Trang lương + báo cáo lợi nhuận (nếu route tồn tại) — chỉ smoke render.
for (const [name, path] of [['salary', '/finance/salary'], ['profit', '/finance/shareholder-profit']] as const) {
  test(`smoke-${name}`, async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, 'chunha');
    const resp = await page.goto(path);
    // route có thể khác — chấp nhận 200 app-shell; chỉ cần không crash JS
    expect(resp?.status() ?? 0, 'http').toBeLessThan(500);
    await page.waitForTimeout(1500);
    expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
  });
}
