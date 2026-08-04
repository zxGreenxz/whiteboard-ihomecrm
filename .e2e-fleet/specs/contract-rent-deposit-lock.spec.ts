import { expect, test, type Locator, type Page } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';

/**
 * Form "Tạo hợp đồng mới" — ô Tiền thuê / Tiền cọc khoá theo mặc định.
 *
 * Yêu cầu (chủ nhà 28/07/2026):
 *   - Tiền thuê load sẵn GIÁ MẶC ĐỊNH của phòng, ô xám chỉ đọc, cuối ô có cây
 *     bút để mở khoá sửa. Sửa lệch → ghi vào lịch sử giá của phòng.
 *   - Tiền cọc mặc định bám tiền thuê, cũng xám + cây bút.
 *   - Cọc lệch tiền thuê → NGAY DƯỚI ô cọc phải nói rõ đang TĂNG hay GIẢM số
 *     tiền cọc khách phải đóng.
 *
 * Spec CHỈ ĐỌC — mở form, gõ số, đóng lại. KHÔNG lưu hợp đồng, không tạo dữ liệu.
 */

const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

async function openContractForm(page: Page) {
  await page.goto('/contracts');
  const search = page.getByPlaceholder('Tìm theo mã HĐ, tên khách, SĐT, tên phòng...');
  await expect(search).toBeVisible();

  const toolbar = search.locator('xpath=../..');
  await toolbar.locator('button:has(svg.lucide-plus)').first().click();

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Tạo hợp đồng mới' }),
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Ô tiền theo nhãn — input + nút bút chì + toàn bộ chữ của khối (hint nằm đó). */
function moneyField(dialog: Locator, label: string, name: string) {
  const item = dialog
    .locator('label')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=..');
  return {
    input: item.locator(`input[name="${name}"]`),
    pencil: dialog.locator(`button[aria-label="Sửa ${label.toLowerCase()}"]`),
    text: () => item.innerText(),
  };
}

/** Mở dropdown rồi trả danh sách nhãn option (chờ list hiện, rỗng thì trả []). */
async function optionLabels(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click();
  const options = page.getByRole('option');
  try {
    await expect(options.first()).toBeVisible({ timeout: 5_000 });
  } catch {
    await page.keyboard.press('Escape');
    return [];
  }
  const labels = (await options.allTextContents()).map((t) => t.trim());
  await page.keyboard.press('Escape');
  return labels;
}

/** Chọn toà + phòng đầu tiên có giá mặc định > 0; trả về giá đó. */
async function pickRoomWithPrice(dialog: Locator, page: Page): Promise<number> {
  const buildingSelect = dialog.getByRole('combobox').first();
  const roomSelect = dialog.getByRole('combobox').nth(1);
  const rent = moneyField(dialog, 'Tiền thuê', 'rent_price');

  for (const building of await optionLabels(page, buildingSelect)) {
    await buildingSelect.click();
    await page.getByRole('option', { name: building, exact: true }).click();

    const rooms = await optionLabels(page, roomSelect);
    for (const room of rooms) {
      await roomSelect.click();
      await page.getByRole('option', { name: room, exact: true }).click();
      // Giá nạp bất đồng bộ theo query phòng → poll thay vì đọc ngay.
      await expect
        .poll(async () => digits(await rent.input.inputValue()), { timeout: 10_000 })
        .not.toBe('');
      const value = Number(digits(await rent.input.inputValue()));
      if (value > 0) return value;
    }
  }
  throw new Error('Không tìm thấy phòng nào có giá mặc định > 0');
}

test('Tiền thuê load giá mặc định của phòng, khoá xám + cây bút mở sửa', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await login(page, 'chunha');
  const dialog = await openContractForm(page);

  const rent = moneyField(dialog, 'Tiền thuê', 'rent_price');
  const deposit = moneyField(dialog, 'Tiền cọc', 'total_deposit');

  const roomRent = await pickRoomWithPrice(dialog, page);

  // 1) Ô khoá: readonly + có nút bút chì.
  await expect(rent.input).toHaveAttribute('readonly', '');
  await expect(rent.pencil).toBeVisible();
  await expect(deposit.input).toHaveAttribute('readonly', '');
  await expect(deposit.pencil).toBeVisible();

  // 2) Hiển thị đúng giá mặc định của phòng + nhắc rõ đó là giá phòng.
  expect(digits(await rent.input.inputValue())).toBe(String(roomRent));
  expect(await rent.text()).toContain('Giá mặc định của phòng');

  // 3) Cọc bám theo tiền thuê.
  expect(digits(await deposit.input.inputValue())).toBe(String(roomRent));

  // 4) Bấm bút → mở khoá, sửa được; cọc CÒN KHOÁ nên chạy theo tiền thuê.
  await rent.pencil.click();
  await expect(rent.input).not.toHaveAttribute('readonly', '');
  const newRent = roomRent + 500_000;
  await rent.input.fill(String(newRent));
  await expect
    .poll(async () => digits(await deposit.input.inputValue()))
    .toBe(String(newRent));

  // 5) Giá ký lệch giá phòng → nhắc sẽ ghi vào lịch sử giá.
  expect(await rent.text()).toContain('lịch sử giá của phòng');

  await page.keyboard.press('Escape');
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('Tiền cọc lệch tiền thuê → cảnh báo rõ đang TĂNG hay GIẢM', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await login(page, 'chunha');
  const dialog = await openContractForm(page);

  const deposit = moneyField(dialog, 'Tiền cọc', 'total_deposit');
  const roomRent = await pickRoomWithPrice(dialog, page);

  // Chưa lệch → không có cảnh báo, chỉ có dòng giải thích mặc định.
  expect(await deposit.text()).toContain('Mặc định bằng tiền thuê');

  await deposit.pencil.click();
  await expect(deposit.input).not.toHaveAttribute('readonly', '');

  // GIẢM cọc.
  await deposit.input.fill(String(Math.max(0, roomRent - 1_500_000)));
  await expect
    .poll(async () => deposit.text(), { timeout: 10_000 })
    .toContain('GIẢM số tiền cọc khách phải đóng');

  // TĂNG cọc.
  await deposit.input.fill(String(roomRent + 2_000_000));
  await expect
    .poll(async () => deposit.text(), { timeout: 10_000 })
    .toContain('TĂNG số tiền cọc khách phải đóng');

  // Quay về đúng tiền thuê → cảnh báo biến mất.
  await deposit.input.fill(String(roomRent));
  await expect
    .poll(async () => deposit.text(), { timeout: 10_000 })
    .toContain('Mặc định bằng tiền thuê');

  await page.keyboard.press('Escape');
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('Dialog sửa phòng có khối "Lịch sử giá"', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/apartments');
  const editButtons = page.locator('tbody button:has(svg.lucide-pencil)');
  await expect(editButtons.first()).toBeVisible({ timeout: 30_000 });
  await editButtons.first().click();

  const dialog = page.getByRole('dialog').filter({ hasText: /phòng|căn hộ/i }).first();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Lịch sử giá' })).toBeVisible();

  await page.keyboard.press('Escape');
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
