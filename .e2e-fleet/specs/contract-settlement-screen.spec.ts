import { test, expect } from '@playwright/test';
import { login } from './auth';

// Đọc bằng vai DEMO; không ghi dữ liệu thật. Phạm vi chỉ màn Hợp đồng & quyết toán.
for (const role of ['chunha', 'ketoan'] as const) {
  test(`${role}: mở màn, đổi tab/kỳ và modal không lỗi console`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
    });
    await login(page, role);
    await page.goto('/thanh-toan');
    await page.locator('.ptt-panel .ptt-trigger').click();
    const start = Date.now();
    await page.locator('.ptt-panel .ptt-menu-item').filter({ hasText: 'Hợp đồng & quyết toán' }).click();
    const screen = page.locator('.cs-wrap');
    await expect(screen.locator('.cs-surface')).toBeVisible();
    await expect(screen.locator('.cs-fail')).toHaveCount(0);
    const cold = Date.now() - start;
    await screen.getByRole('button', { name: 'Biến động', exact: true }).click();
    await expect(screen.locator('.cs-surface')).toBeVisible();
    await screen.getByLabel('Phạm vi kỳ').selectOption('all');
    await expect(screen.locator('.cs-load')).toHaveCount(0);
    const events = screen.getByRole('button', { name: 'Xem hồ sơ', exact: true });
    await expect(events.first(), 'DEMO phải có biến động đã tải xong').toBeVisible();
    const count = await events.count();
    expect(count, 'DEMO cần có biến động để thực sự kiểm modal').toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(50);
    await events.first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('Ghi chú gốc của phiếu');
    await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
    await screen.getByRole('button', { name: 'Khoản chi', exact: true }).click();
    await expect(screen.locator('.cs-surface')).toBeVisible();
    const month = page.locator('.ptt-panel .ud-ky');
    const value = await month.inputValue();
    const previous = `${Number(value.slice(0, 4)) - 1}${value.slice(4)}`;
    await month.fill(previous);
    await expect(screen.getByLabel('Phạm vi kỳ')).toHaveValue('current');
    await expect(screen.locator('.cs-fail')).toHaveCount(0);
    expect(errors, 'console/page errors').toEqual([]);
    await info.attach('local-observation.json', { body: JSON.stringify({ role, coldMs: cold, visibleEvents: count }), contentType: 'application/json' });
  });
}
