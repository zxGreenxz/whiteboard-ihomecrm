import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Dialog "KHÁCH HÀNG" mở từ luồng chọn khách của hợp đồng (Tạo HĐ → Chọn khách
 * → Tạo mới): mục "2. THÔNG TIN XE" trước đây có nút "+ Thêm xe" chết — bấm
 * không ra dòng nào. Bài này chốt: bấm ra đủ 4 ô và xe lưu được cùng khách.
 *
 * Tự dọn: xoá KH vừa tạo (và xe theo nó) ở cuối bài. Chỉ ghi org DEMO.
 */

test('dialog KH trong luồng HĐ: thêm xe ra dòng nhập + lưu được', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = trackConsoleErrors(page);
  const stamp = Date.now().toString().slice(-8);
  const name = `[E2E-CTVEH] KH ${stamp}`;
  const plate = `59W-${stamp.slice(-5)}`;

  await login(page, 'chunha');
  await page.goto('/contracts');

  // Tạo HĐ → dialog HĐ
  await page.locator('button.bg-green-500').first().click();
  const contractDialog = page.getByRole('dialog').first();
  await expect(contractDialog).toBeVisible({ timeout: 20_000 });

  // Mở bảng chọn khách rồi bấm "Tạo mới"
  await page.getByRole('button', { name: /Chọn khách|Thêm khách/ }).first().click();
  await page.getByRole('button', { name: 'Tạo mới' }).click();

  // Dialog HĐ cũng có chữ "KHÁCH HÀNG" → khoá theo dòng mô tả riêng của dialog này.
  const custDialog = page
    .getByRole('dialog')
    .filter({ hasText: 'Nhập thông tin khách hàng cho hệ thống quản lý' });
  await expect(custDialog.getByText('2. THÔNG TIN XE')).toBeVisible({ timeout: 20_000 });

  // Bấm thêm xe → phải hiện đủ 4 ô (loại/dòng/màu/biển số)
  await custDialog.getByRole('button', { name: 'Thêm phương tiện' }).click();
  await expect(custDialog.getByPlaceholder('VD: Honda Wave')).toBeVisible();
  await expect(custDialog.getByPlaceholder('VD: Đen, Trắng, Đỏ')).toBeVisible();
  await expect(custDialog.getByPlaceholder('VD: 59A-12345')).toBeVisible();
  await expect(custDialog.getByText('Loại phương tiện')).toBeVisible();

  // Điền KH + xe rồi lưu
  await custDialog.getByLabel('Họ tên khách *').fill(name);
  await custDialog.getByLabel('Số điện thoại *').fill(`09${stamp}`);
  await custDialog.getByPlaceholder('VD: Honda Wave').fill('SH Mode');
  await custDialog.getByPlaceholder('VD: Đen, Trắng, Đỏ').fill('Nâu');
  await custDialog.getByPlaceholder('VD: 59A-12345').fill(plate);
  await custDialog.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(custDialog).toHaveCount(0, { timeout: 30_000 });

  // Xe phải có mặt ở trang Phương tiện, gắn đúng khách
  await page.goto('/vehicles');
  await page.getByPlaceholder(/Tìm/i).first().fill(plate);
  await expect(page.getByText(plate).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('SH Mode').first()).toBeVisible();
  await expect(page.getByText('Nâu').first()).toBeVisible();
  console.log(`Đã tạo ${plate} (SH Mode / Nâu) cho ${name}`);

  // --- Dọn: gỡ xe trong form sửa KH rồi xoá KH ---
  await page.goto('/customers');
  await page.getByPlaceholder(/Tìm/i).first().fill(name);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  await page
    .locator('tr', { hasText: name })
    .locator('button:has(svg.lucide-pencil)')
    .first()
    .click();
  await page.waitForURL(/\/customers\/[^/]+\/edit/, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Xoá phương tiện' }).first().click();
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.waitForURL(/\/customers$/, { timeout: 30_000 });

  await page.getByPlaceholder(/Tìm/i).first().fill(name);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('tr', { hasText: name }).locator('button.text-red-500').first().click();
  await page.getByRole('button', { name: 'Xoá', exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 20_000 });

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
