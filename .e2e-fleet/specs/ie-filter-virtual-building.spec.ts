import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chốt bản vá 27/07/2026: ô LỌC toà nhà ở màn Thu chi phải chọn được TOÀ ẢO.
 *
 * Toà ảo (buildings.is_virtual) là bucket tài chính gom thu/chi không thuộc toà
 * vật lý — org thật là "Kho Văn Phòng Chung", org DEMO là "Chung (Demo)". Form
 * tạo phiếu vẫn ghi được vào đó, nên phiếu tồn tại; nhưng BuildingFilterSelect
 * gọi useBuildings() mặc định (is_virtual = false) nên toà ảo bị cắt khỏi
 * dropdown → phiếu của nó không lọc ra được. Nay ô lọc truyền includeVirtual.
 *
 * LƯU Ý: fleet mặc định trỏ production; bài này chỉ xanh khi bản đang chạy đã có
 * thay đổi. Kiểm trước khi deploy:
 *   npm run dev
 *   FLEET_BASE_URL=http://localhost:8080 npx playwright test specs/ie-filter-virtual-building.spec.ts
 */

test('loc-thu-chi-chon-duoc-toa-ao', async ({ page }) => {
  const errs = trackConsoleErrors(page);

  await login(page, 'chunha');
  await page.goto('/income-expense');

  const oLoc = page.getByRole('combobox', { name: 'Chọn toà nhà' }).first();
  await expect(oLoc).toBeVisible({ timeout: 20_000 });
  await oLoc.click();

  await page.getByPlaceholder('Tìm toà nhà...').fill('Chung');
  await expect(page.getByRole('option', { name: 'Chung (Demo)' })).toBeVisible({
    timeout: 15_000,
  });

  // Chọn thật để chắc bộ lọc nhận giá trị, không chỉ hiện trong danh sách.
  await page.getByRole('option', { name: 'Chung (Demo)' }).click();
  await expect(oLoc).toContainText('Chung (Demo)');

  expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
});
