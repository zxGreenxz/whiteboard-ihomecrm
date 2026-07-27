import { expect, test } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';

/**
 * ÁN LỆ 27/07/2026 — tk joey không tạo nổi HĐ phòng 503 158PVC.
 *
 * Form HĐ tự chọn sổ quỹ cho dòng "Đã đặt cọc" bằng `mine[0]` (sổ đầu tiên của
 * chính user). Với joey sổ đó là "Cấn trừ thanh lý (nội bộ)" — SỔ ẢO. Nhưng
 * `create_contract_v2` chặn sổ ảo (`NOT accounts.is_virtual`) rồi ném 42501
 * "Sổ quỹ cọc không thuộc tổ chức", mà 42501 hiện thành toast "Không đủ quyền"
 * → user tưởng bị khoá quyền, dò phân quyền cả buổi trong khi lỗi nằm ở sổ quỹ.
 *
 * Hạm đội cũ không bắt được vì spec HĐ duy nhất (invoice-collection-v5) đi
 * nhánh "Đóng đủ trong hoá đơn" — KHÔNG hề chạm dòng "Đã đặt cọc".
 *
 * Org DEMO dính y hệt: sổ đầu danh sách của demo.chunha cũng là
 * "Cấn trừ thanh lý (nội bộ)" (is_virtual = true).
 *
 * Spec CHỈ ĐỌC — mở form, soi dropdown sổ quỹ, đóng lại. Không tạo dữ liệu.
 */

const VIRTUAL_CASHBOOKS = [
  'Cấn trừ thanh lý (nội bộ)',
  'CỌC (giữ hộ khách)',
  'Làm tròn tiền thiếu',
  'Hiển Thối',
  'Hiệp Thối',
];

test('dòng "Đã đặt cọc" không bao giờ chọn/hiện sổ ảo', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/contracts');
  const search = page.getByPlaceholder('Tìm theo mã HĐ, tên khách, SĐT, tên phòng...');
  await expect(search).toBeVisible();

  const toolbar = search.locator('xpath=../..');
  await toolbar.locator('button:has(svg.lucide-plus)').first().click();

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Tạo hợp đồng mới' }),
  });
  await expect(dialog).toBeVisible();

  // Thêm 1 lần cọc → form tự điền sổ quỹ mặc định vào dòng vừa tạo.
  await dialog.getByRole('button', { name: 'Thêm lần cọc' }).click();

  const cashbookPicker = dialog.getByRole('combobox').filter({ hasText: /Sổ quỹ|./ }).last();
  await expect(cashbookPicker).toBeVisible();

  // 1) Sổ auto-chọn phải là sổ THẬT.
  const picked = ((await cashbookPicker.textContent()) ?? '').trim();
  expect(picked, 'form phải tự chọn được một sổ quỹ').not.toBe('');
  expect(picked, `form auto-chọn sổ ảo "${picked}" → create_contract_v2 sẽ ném 42501`)
    .not.toBe('Sổ quỹ');
  for (const virtual of VIRTUAL_CASHBOOKS) {
    expect(picked, `sổ auto-chọn là sổ ảo "${virtual}"`).not.toContain(virtual);
  }

  // 2) Cả danh sách xổ ra cũng không được chứa sổ ảo.
  await cashbookPicker.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const options = (await listbox.getByRole('option').allTextContents()).map((t) => t.trim());
  expect(options.length, 'phải có ít nhất 1 sổ quỹ thật để nhận cọc').toBeGreaterThan(0);
  for (const virtual of VIRTUAL_CASHBOOKS) {
    expect(options, `dropdown sổ nhận cọc vẫn liệt kê sổ ảo "${virtual}"`).not.toContain(virtual);
  }

  await page.keyboard.press('Escape');
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
