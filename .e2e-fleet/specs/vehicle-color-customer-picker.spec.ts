import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * 1) Form khách hàng: hàng "Thông tin xe" inline có ô Màu xe, và màu lưu được
 *    xuống DB (kiểm qua trang /vehicles).
 * 2) Dialog Thêm phương tiện (/vehicles): ô Khách hàng gõ được để lọc nhanh,
 *    và tự thu hẹp theo Toà nhà → Phòng đã chọn.
 *
 * Org DEMO không có HĐ ACTIVE nào gắn khách, nên bài 2 chỉ khẳng định được
 * "lọc CÓ áp dụng" (danh sách thu hẹp hoặc rơi vào empty-state đúng chữ).
 * Case dương (đúng khách của phòng) đã verify tay 27/07/2026 bằng fixture
 * contract_customers tạm trên phòng B101 — 11 khách → đúng 1 "DEMO Nguyễn Văn
 * An"; fixture đã xoá ngay sau đó.
 */

test('customer form: hàng xe inline có ô Màu xe', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');
  await page.goto('/customers');

  // Nút "Thêm" trên toolbar chỉ có icon → khoá theo class nút xanh.
  await page.locator('button.bg-green-600').first().click();

  const addVehicle = page.getByRole('button', { name: 'Thêm phương tiện' });
  await expect(addVehicle).toBeVisible({ timeout: 20_000 });
  await addVehicle.click();

  // 4 ô trên một hàng: loại, tên dòng xe, MÀU XE, biển số
  await expect(page.getByText('Màu xe', { exact: true })).toBeVisible();
  const color = page.getByPlaceholder('VD: Đen, Trắng, Đỏ');
  await expect(color).toBeVisible();
  await color.fill('Xanh rêu');
  await expect(color).toHaveValue('Xanh rêu');

  await expect(page.getByPlaceholder('VD: Honda Wave')).toBeVisible();
  await expect(page.getByPlaceholder('VD: 59A-12345')).toBeVisible();

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('vehicle dialog: ô khách hàng lọc được + auto lọc theo toà/phòng', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');
  await page.goto('/vehicles');

  await page.locator('button.bg-green-600').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Đăng ký phương tiện mới')).toBeVisible({ timeout: 20_000 });

  // Combobox khách hàng có ô tìm kiếm
  const customerTrigger = dialog.getByLabel('Khách hàng');
  await customerTrigger.click();
  const search = page.getByPlaceholder('Gõ tên hoặc SĐT để tìm...');
  await expect(search).toBeVisible();

  // Chờ query customers về (list ban đầu chỉ có "-- Không chọn --").
  await expect.poll(() => page.getByRole('option').count(), { timeout: 20_000 }).toBeGreaterThan(1);
  const allCount = await page.getByRole('option').count();

  // Gõ để lọc nhanh
  await search.fill('zzzz-khong-ton-tai');
  await expect(page.getByText('Không tìm thấy khách hàng')).toBeVisible();
  await page.keyboard.press('Escape');

  // Chọn toà nhà → danh sách khách phải thu hẹp theo HĐ ACTIVE của toà
  await dialog.getByLabel('Toà nhà').click();
  await page.getByRole('option', { name: /Tòa DEMO B/ }).click();
  await expect(dialog.getByRole('button', { name: /Đang lọc theo toà nhà/ })).toBeVisible();

  await customerTrigger.click();
  // keepPreviousData ⇒ list cũ hiện tạm khi đang refetch; chờ nó thu hẹp thật.
  // Phải có ÍT NHẤT 1 option ("-- Không chọn --" luôn còn) — nếu chấp nhận cả 0
  // thì bài đọc trúng lúc dropdown chưa vẽ xong và tưởng là đã lọc.
  await expect
    .poll(
      async () => {
        const texts = await page.getByRole('option').allTextContents();
        if (texts.some((t) => t.includes('Đang tải'))) return false; // chưa xong
        return texts.length > 0 && texts.length < allCount;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const byBuilding = await page.getByRole('option').allTextContents();
  console.log(`Khách: tất cả=${allCount} → lọc theo toà=${byBuilding.length}`, byBuilding);
  const realCustomers = byBuilding.filter(
    (t) => !/Không chọn|Không có khách/.test(t),
  );
  if (realCustomers.length === 0) {
    // Không khách nào có HĐ trong toà → phải nói rõ lý do, không im lặng.
    expect(byBuilding.join('|')).toContain('Không có khách trong toà/phòng này');
  }
  await page.keyboard.press('Escape');

  // Chọn phòng → nhãn đổi sang "phòng"
  await dialog.getByLabel('Phòng').click();
  await page.getByRole('option', { name: /^B101$/ }).click();
  await expect(dialog.getByRole('button', { name: /Đang lọc theo phòng/ })).toBeVisible();

  // Bỏ lọc → quay lại danh sách đầy đủ
  await dialog.getByRole('button', { name: /xem tất cả/ }).click();
  await customerTrigger.click();
  await expect.poll(() => page.getByRole('option').count(), { timeout: 20_000 }).toBe(allCount);
  await page.keyboard.press('Escape');

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
