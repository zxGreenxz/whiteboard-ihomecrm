import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Sidebar thu gọn/ẩn hiện — theo mock "Sidebar Auto Hide.dc.html" (phương án 1a
 * làm mặc định + phủ 1d tự-thu-theo-màn-hình).
 *
 * Chạy trên dev server local:
 *   FLEET_BASE_URL=http://localhost:8080 FLEET_PASS_KETOAN=... \
 *     npx playwright test specs/sidebar-auto-hide.spec.ts
 */

const RAIL = 72;
const FULL = 264;

const aside = (page: Page) => page.locator('aside').first();

const asideBox = async (page: Page) => {
  const box = await aside(page).boundingBox();
  if (!box) throw new Error('Không tìm thấy sidebar');
  return box;
};

/** Ô giữ chỗ trong luồng = phần sidebar thực sự ĐẨY nội dung. */
const mainLeft = async (page: Page) => {
  const box = await page.locator('main').first().boundingBox();
  if (!box) throw new Error('Không tìm thấy vùng nội dung');
  return box.x;
};

const settle = (page: Page) => page.waitForTimeout(700);

test.describe('sidebar auto hide', () => {
  test('1d: màn 1280px tự thu về rail, rê chuột bung ra NỔI ĐÈ (nội dung đứng yên)', async ({
    page,
  }) => {
    const errs = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'ketoan');
    await page.goto('/invoices');
    await page.waitForLoadState('networkidle');
    await settle(page);

    // 1024–1440px → tự thu về rail.
    expect((await asideBox(page)).width).toBeCloseTo(RAIL, 0);
    const contentLeft = await mainLeft(page);
    expect(contentLeft).toBeCloseTo(RAIL, 0);

    // Rê chuột vào rail → bung 264px…
    await aside(page).hover({ position: { x: 30, y: 300 } });
    await settle(page);
    expect((await asideBox(page)).width).toBeCloseTo(FULL, 0);
    // …nhưng bảng phía sau KHÔNG xô lệch: panel nổi đè.
    expect(await mainLeft(page)).toBeCloseTo(contentLeft, 0);

    // Chuột rời → thu lại.
    await page.mouse.move(900, 500);
    await settle(page);
    expect((await asideBox(page)).width).toBeCloseTo(RAIL, 0);

    expect(errs).toEqual([]);
  });

  test('1d: màn ≥1440px tự mở đầy đủ và ĐẨY nội dung', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, 'ketoan');
    await page.goto('/invoices');
    await page.waitForLoadState('networkidle');
    await settle(page);

    expect((await asideBox(page)).width).toBeCloseTo(FULL, 0);
    expect(await mainLeft(page)).toBeCloseTo(FULL, 0);
  });

  test('ghim/bỏ ghim bằng Ctrl+B, nhớ trạng thái sau khi tải lại trang', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, 'ketoan');
    await page.goto('/invoices');
    await page.waitForLoadState('networkidle');
    await settle(page);

    // Đang mở (auto ≥1440) → Ctrl+B thu gọn.
    await page.keyboard.press('Control+b');
    await settle(page);
    expect((await asideBox(page)).width).toBeCloseTo(RAIL, 0);
    expect(await mainLeft(page)).toBeCloseTo(RAIL, 0);

    // Lựa chọn tay được ghi nhớ qua lần tải lại.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await settle(page);
    expect((await asideBox(page)).width).toBeCloseTo(RAIL, 0);

    // Nút ghim trong sidebar mở lại.
    await aside(page).hover({ position: { x: 30, y: 300 } });
    await settle(page);
    await page.getByRole('button', { name: /Ghim sidebar mở/ }).first().click();
    await settle(page);
    expect((await asideBox(page)).width).toBeCloseTo(FULL, 0);
    expect(await mainLeft(page)).toBeCloseTo(FULL, 0);
  });

  test('desktop bỏ header trên cùng: tài khoản + đăng xuất nằm ở chân sidebar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, 'ketoan');
    await page.goto('/invoices');
    await page.waitForLoadState('networkidle');
    await settle(page);

    // Sidebar chạm mép trên viewport (không còn thanh header 64px đè lên).
    expect((await asideBox(page)).y).toBeCloseTo(0, 0);

    await expect(aside(page).getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
    await expect(aside(page).getByRole('link', { name: 'Về trang chủ' })).toBeVisible();
    // Chuông thông báo đã chuyển vào chân sidebar.
    await expect(aside(page).getByRole('button').filter({ has: page.locator('svg') })).not.toHaveCount(
      0,
    );
  });

  test('mobile vẫn là drawer, mở bằng nút ☰', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'ketoan');
    // /invoices có bản mobile riêng (không dùng MainLayout) — dùng trang FAQ,
    // vốn chạy MainLayout ở mọi cỡ màn.
    await page.goto('/faq');
    await page.waitForLoadState('networkidle');
    await settle(page);

    // Rail/panel desktop bị ẩn hẳn trên mobile (rail 72px quá hẹp cho ngón tay).
    await expect(page.locator('aside')).toBeHidden();

    await page.locator('header button').first().click();
    await settle(page);
    const drawer = page.locator('aside:visible');
    await expect(drawer).toHaveCount(1);
    const box = await drawer.boundingBox();
    expect(box?.width).toBeCloseTo(FULL, 0);
  });
});
