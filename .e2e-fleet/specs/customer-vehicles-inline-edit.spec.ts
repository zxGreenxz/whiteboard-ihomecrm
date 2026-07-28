import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Sửa xe ngay trong form khách hàng (chế độ Sửa): xe cũ phải load lên, sửa
 * được, thêm dòng mới được, gỡ dòng thì xe bị xoá.
 *
 * Bài tự dọn: cuối bài xoá KH vừa tạo (xe theo đó cũng gỡ khỏi form trước khi
 * xoá KH). Chỉ ghi vào org DEMO.
 */

const wait = (p: Page) => p.waitForLoadState('networkidle');

async function openEdit(page: Page, name: string) {
  await page.goto('/customers');
  const search = page.getByPlaceholder(/Tìm/i).first();
  await search.fill(name);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  // Nút bút chì (cam) trên hàng KH → trang sửa
  await page
    .locator('tr', { hasText: name })
    .locator('button:has(svg.lucide-pencil)')
    .first()
    .click();
  await page.waitForURL(/\/customers\/[^/]+\/edit/, { timeout: 20_000 });
  await wait(page);
}

test('form KH: sửa / thêm / xoá xe inline ở chế độ Sửa', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = trackConsoleErrors(page);
  const stamp = Date.now().toString().slice(-8);
  const name = `[E2E-VEH] KH ${stamp}`;
  const plate1 = `59X-${stamp.slice(-5)}`;
  const plate2 = `59Y-${stamp.slice(-5)}`;

  await login(page, 'chunha');

  // --- Tạo KH kèm 1 xe ---
  await page.goto('/customers');
  await page.locator('button.bg-green-600').first().click();
  await page.getByPlaceholder('Nhập họ tên').fill(name);
  await page.getByPlaceholder('Nhập số điện thoại').fill(`09${stamp}`);
  await page.getByRole('button', { name: 'Thêm phương tiện' }).click();
  await page.getByPlaceholder('VD: Honda Wave').fill('Honda Wave');
  await page.getByPlaceholder('VD: Đen, Trắng, Đỏ').fill('Đỏ');
  await page.getByPlaceholder('VD: 59A-12345').fill(plate1);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.waitForURL(/\/customers$/, { timeout: 30_000 });

  // --- Mở lại Sửa: xe cũ phải load lên đúng dữ liệu ---
  await openEdit(page, name);
  await expect(page.getByPlaceholder('VD: Honda Wave').first()).toHaveValue('Honda Wave', {
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder('VD: Đen, Trắng, Đỏ').first()).toHaveValue('Đỏ');
  await expect(page.getByPlaceholder('VD: 59A-12345').first()).toHaveValue(plate1);

  // --- Sửa màu xe cũ + thêm 1 xe mới ---
  await page.getByPlaceholder('VD: Đen, Trắng, Đỏ').first().fill('Vàng cam');
  await page.getByRole('button', { name: 'Thêm phương tiện' }).click();
  await page.getByPlaceholder('VD: Honda Wave').nth(1).fill('Yamaha Sirius');
  await page.getByPlaceholder('VD: Đen, Trắng, Đỏ').nth(1).fill('Trắng');
  await page.getByPlaceholder('VD: 59A-12345').nth(1).fill(plate2);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.waitForURL(/\/customers$/, { timeout: 30_000 });

  // Trang Phương tiện: xe cũ đổi màu, xe mới xuất hiện
  await page.goto('/vehicles');
  await page.getByPlaceholder(/Tìm/i).first().fill(name);
  await expect(page.getByText(plate1).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Vàng cam').first()).toBeVisible();
  await expect(page.getByText(plate2).first()).toBeVisible();
  await expect(page.getByText('Yamaha Sirius').first()).toBeVisible();

  // --- Gỡ 1 xe khỏi form ⇒ đúng xe đó bị xoá, xe kia còn nguyên ---
  await openEdit(page, name);
  const plateInputs = page.getByPlaceholder('VD: 59A-12345');
  await expect(plateInputs).toHaveCount(2, { timeout: 20_000 });
  // Danh sách xếp mới-nhất-trước, đừng giả định dòng đầu là xe nào.
  const removed = await plateInputs.first().inputValue();
  const kept = await plateInputs.nth(1).inputValue();
  expect([removed, kept].sort()).toEqual([plate1, plate2].sort());

  await page.getByRole('button', { name: 'Xoá phương tiện' }).first().click();
  await expect(plateInputs).toHaveCount(1);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.waitForURL(/\/customers$/, { timeout: 30_000 });

  await page.goto('/vehicles');
  await page.getByPlaceholder(/Tìm/i).first().fill(name);
  await expect(page.getByText(kept).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(removed)).toHaveCount(0);
  console.log(`Đã xoá ${removed}, giữ ${kept}`);

  // --- Dọn: gỡ nốt xe còn lại rồi xoá KH ---
  await openEdit(page, name);
  await page.getByRole('button', { name: 'Xoá phương tiện' }).first().click();
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.waitForURL(/\/customers$/, { timeout: 30_000 });

  await page.getByPlaceholder(/Tìm/i).first().fill(name);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  // Nút xoá (đỏ) là action cuối trên hàng KH.
  await page
    .locator('tr', { hasText: name })
    .locator('button.text-red-500')
    .first()
    .click();
  await page.getByRole('button', { name: 'Xoá', exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 20_000 });

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
