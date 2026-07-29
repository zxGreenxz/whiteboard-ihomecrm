// =============================================================================
// Page /thanh-toan — "Đóng tiền Tập trung theo Kỳ" tách khỏi overlay /thu-tien.
//
// Trước đây UI này chỉ mở được bằng nút Plug trong /thu-tien (state `utility`).
// Sau khi tách:
//   - /thanh-toan là route thật, deep-link được (vào thẳng từ Home launcher)
//   - desktop ≥1024px: .ptt-panel ở cột trái, khung điện thoại ở cột phải
//   - mobile <1024px: chỉ còn khung điện thoại + sheet .ptt-sheet
//   - nút Plug bên /thu-tien giờ ĐIỀU HƯỚNG sang page mới (không mở overlay)
//   - ô kỳ <input type="month"> nằm TRONG header sheet (sheet.full phủ kín
//     .tt-page nên header page phía sau bấm không tới)
//
// Chạy: cd .e2e-fleet && FLEET_BASE_URL=http://localhost:8092 \
//         npx playwright test specs/thanh-toan-page.spec.ts
// =============================================================================

import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

test('deep-link /thanh-toan: panel desktop + sheet mobile cùng render, không lỗi console', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/thanh-toan');

  // Cột trái desktop (viewport mặc định 1280 → ≥1024px nên .tt-udesk hiện).
  await expect(page.locator('.ptt-panel')).toBeVisible();
  await expect(page.locator('.ptt-panel .ptt-title')).toContainText('Tổng quan kỳ');

  // Cột phải: khung điện thoại chứa sheet, hiện SẴN (không cần bấm gì).
  await expect(page.locator('.tt-phone-col .tt-page')).toBeVisible();
  await expect(page.locator('.tt-phone-col .ptt-sheet')).toBeVisible();

  // Sheet phải trượt hết lên (translateY(0)) chứ không nằm ngoài khung.
  const frame = await page.locator('.tt-phone-col .tt-page').boundingBox();
  const sheet = await page.locator('.tt-phone-col .ptt-sheet').boundingBox();
  expect(frame && sheet).toBeTruthy();
  expect(Math.abs(sheet!.y - frame!.y)).toBeLessThan(4);

  expect(errs, 'console errors').toEqual([]);
});

test('nút Plug bên /thu-tien điều hướng sang /thanh-toan (không còn overlay)', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/thu-tien');
  await expect(page.locator('.tt-manage')).toBeVisible();          // ManagePanel cột trái
  await expect(page.locator('.ptt-panel')).toHaveCount(0);         // chưa có panel Đóng tiền

  await page.locator('.tt-utility[title="Đóng tiền điện nước"]').click();

  await expect(page).toHaveURL(/\/thanh-toan$/);
  await expect(page.locator('.ptt-panel')).toBeVisible();
  await expect(page.locator('.tt-manage')).toHaveCount(0);         // ManagePanel đã rời khỏi DOM

  expect(errs, 'console errors').toEqual([]);
});

test('back từ /thanh-toan quay về /thu-tien kể cả khi vào thẳng bằng deep-link', async ({ page }) => {
  await login(page, 'chunha');

  // Vào THẲNG /thanh-toan → history không có /thu-tien phía sau (location.key
  // = 'default') nên back phải rơi về /thu-tien chứ không đứng im.
  await page.goto('/thanh-toan');
  await expect(page.locator('.ptt-panel')).toBeVisible();

  await page.locator('.ptt-panel .ud-back').click();

  await expect(page).toHaveURL(/\/thu-tien$/);
  await expect(page.locator('.tt-manage')).toBeVisible();
});

test('back sau khi vào từ trong app thì LÙI đúng 1 bước (về Home, không nhảy sang Thu tiền)', async ({ page }) => {
  // Phải điều hướng BẰNG SPA (bấm link) — page.goto là full reload nên
  // location.key luôn là 'default' và không phân biệt được 2 nhánh.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'chunha');
  await page.goto('/');

  await page.locator('a[href="/thanh-toan"]').click();
  await expect(page).toHaveURL(/\/thanh-toan$/);
  await expect(page.locator('.tt-phone-col .ptt-sheet')).toBeVisible();

  // Mobile: panel desktop ẩn → dùng nút X trong header sheet.
  await page.locator('.tt-phone-col .ptt-m-head .rp-x').click();

  // Vào từ Home thì back về Home, KHÔNG rơi cứng về /thu-tien.
  await expect(page).toHaveURL(/localhost:\d+\/$|ptcrm\.vercel\.app\/$/);
  await expect(page.locator('a[href="/thanh-toan"]')).toBeVisible();
});

test('scrim bị bỏ trên page: bấm mép ngoài sheet không văng khỏi /thanh-toan', async ({ page }) => {
  await login(page, 'chunha');
  await page.goto('/thanh-toan');
  await expect(page.locator('.tt-phone-col .ptt-sheet')).toBeVisible();

  // standalone → không render .sheet-scrim (vùng bấm "thoát trang" full-bleed).
  await expect(page.locator('.tt-phone-col .sheet-scrim')).toHaveCount(0);
  await expect(page).toHaveURL(/\/thanh-toan$/);
});

test('ô chọn kỳ trong header sheet đổi được tháng (mobile không bị kẹt 1 kỳ)', async ({ page }) => {
  await login(page, 'chunha');
  await page.goto('/thanh-toan');

  const ky = page.locator('.tt-phone-col .ptt-m-head input[type="month"]');
  await expect(ky).toBeVisible();

  const before = await ky.inputValue();
  expect(before).toMatch(/^\d{4}-\d{2}$/);

  // Lùi 1 kỳ.
  const [y, m] = before.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  await ky.fill(prev);

  await expect(ky).toHaveValue(prev);
  // Panel desktop dùng CHUNG state kỳ → phải đổi theo.
  await expect(page.locator('.ptt-panel .ud-ky')).toHaveValue(prev);
  // Phụ đề sheet cũng phản ánh kỳ mới.
  await expect(page.locator('.tt-phone-col .ptt-m-sub')).toContainText(String(y));
});

test('ô "Thanh toán" hiện ở mục Tài chính của Home launcher và trỏ đúng route', async ({ page }) => {
  // "/" tách nhánh theo bề ngang: ≤767px mới ra Home launcher (desktop = Dashboard).
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'chunha');
  await page.goto('/');

  const tile = page.locator('a[href="/thanh-toan"]');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('Thanh toán');

  // Nằm trong section "Tài chính".
  const sec = page.locator('section.lsec', { has: page.locator('a[href="/thanh-toan"]') });
  await expect(sec).toContainText('Tài chính');

  await tile.click();
  await expect(page).toHaveURL(/\/thanh-toan$/);
  // Mobile <1024px: .tt-udesk bị ẩn, chỉ còn khung điện thoại + sheet.
  await expect(page.locator('.tt-phone-col .ptt-sheet')).toBeVisible();
  await expect(page.locator('.ptt-panel')).toBeHidden();
});
