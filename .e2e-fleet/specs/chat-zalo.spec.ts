import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Đường khói Chat Zalo (org-scoped) — chạy trên org DEMO, KHÔNG ghi gì ngoài
 * thao tác UI thuần client (mở dialog, gõ ô input rồi đóng).
 *
 * Org DEMO chưa kết nối tài khoản Zalo nào → giá trị của spec này là chứng
 * minh: (1) trang dựng xong với dữ liệu RỖNG của đúng org mình (không thấy
 * dữ liệu org khác — tách bạch công ty), (2) khung soạn tin mới validate SĐT,
 * (3) không có lỗi console app-level.
 */
test.describe('Chat Zalo — khu chat của công ty', () => {
  test('trang dựng xong, dữ liệu org DEMO rỗng, không lộ org khác', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/chat-zalo');

    // Khung cột 1 dựng xong
    await expect(page.getByRole('heading', { name: 'Hội thoại' })).toBeVisible({ timeout: 30_000 });

    // Org DEMO chưa có hội thoại nào — đếm tổng phải là 0 (org THẬT có ~1.8k;
    // thấy số > 0 ở đây nghĩa là RỎ RỈ CHÉO CÔNG TY).
    await expect(page.locator('text=Hội thoại').locator('..').locator('span', { hasText: /^0$/ })).toBeVisible({ timeout: 15_000 });

    // Empty state của khung chat (desktop)
    await expect(page.getByText('Chưa có hội thoại — kết nối Zalo để bắt đầu')).toBeVisible();

    expect(errs, `Console errors: ${errs.join(' | ')}`).toHaveLength(0);
  });

  test('soạn tin mới: validate SĐT, không gọi gì khi số sai', async ({ page }) => {
    await login(page, 'chunha');
    await page.goto('/chat-zalo');
    await expect(page.getByRole('heading', { name: 'Hội thoại' })).toBeVisible({ timeout: 30_000 });

    await page.getByTitle('Soạn tin mới theo SĐT').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Org DEMO chưa có account connected → dialog phải nói rõ, không hiện form mù
    await expect(
      page.getByText('Chưa có tài khoản Zalo nào đang kết nối — kết nối trước rồi quay lại.'),
    ).toBeVisible();

    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('chip lọc Danh bạ hoạt động, không crash', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/chat-zalo');
    await expect(page.getByRole('heading', { name: 'Hội thoại' })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Danh bạ', exact: true }).click();
    await expect(page.getByText('Không có hội thoại phù hợp')).toBeVisible();
    await page.getByRole('button', { name: 'Tất cả', exact: true }).click();

    expect(errs, `Console errors: ${errs.join(' | ')}`).toHaveLength(0);
  });
});
