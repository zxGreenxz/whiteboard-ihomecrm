import { expect, test } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

// Headless E2E cho ô "Nợ cũ kỳ trước" mới thêm vào dialog Chỉnh sửa hoá đơn.
// Chạy trên build LOCAL (FLEET_BASE_URL=http://localhost:8082) vì production
// chưa có thay đổi. Chỉ ĐỌC + mở dialog rồi Huỷ — KHÔNG ghi dữ liệu.
//
//   FLEET_BASE_URL=http://localhost:8082 FLEET_WORKERS=1 \
//     npx playwright test specs/invoice-edit-previous-debt.spec.ts

test('dialog sửa HĐ có ô Nợ cũ và Tổng cộng đã gồm nợ cũ', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/invoices');
  await page.waitForLoadState('networkidle');

  // Tìm hàng HĐ đầu tiên còn sửa được (có nút bút chì — chỉ hiện với
  // DRAFT/APPROVED + chưa thu đồng nào).
  const editBtn = page.locator('table tbody tr').locator('button[title*="Sửa"], button:has(svg.lucide-pencil)').first();
  await expect(editBtn).toBeVisible({ timeout: 30_000 });
  await editBtn.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Chỉnh sửa hoá đơn/)).toBeVisible();

  // 1) Ô Nợ cũ phải tồn tại và sửa được.
  const debtBox = dialog.locator('.bg-red-50').filter({ hasText: 'Nợ cũ kỳ trước:' });
  await expect(debtBox).toBeVisible();

  const debtInput = debtBox.locator('input').first();
  await expect(debtInput).toBeEditable();

  // 2) Đọc Tổng cộng trước, sửa nợ cũ +100.000 → Tổng cộng phải tăng đúng 100.000.
  const totalLocator = dialog.locator('.bg-blue-50').locator('span').last();
  const parseVnd = (s: string) => Number(s.replace(/[^\d]/g, ''));
  const totalBefore = parseVnd((await totalLocator.textContent()) ?? '0');
  const debtBefore = parseVnd((await debtInput.inputValue()) || '0');

  await debtInput.fill(String(debtBefore + 100_000));
  await debtInput.blur();

  await expect
    .poll(async () => parseVnd((await totalLocator.textContent()) ?? '0'), { timeout: 10_000 })
    .toBe(totalBefore + 100_000);

  // 3) Nút "tính lại nợ cũ" bấm được, không nổ.
  const reloadBtn = dialog.locator('button[title*="Tính lại nợ cũ"]');
  await expect(reloadBtn).toBeVisible();
  await reloadBtn.click();
  await expect(reloadBtn).toBeEnabled({ timeout: 20_000 });

  // Huỷ — KHÔNG ghi gì vào DB.
  await dialog.getByRole('button', { name: 'Hủy' }).click();
  await expect(dialog).toBeHidden();

  expect(errors, `Console errors: ${errors.join(' | ')}`).toEqual([]);
});

// Round-trip GHI THẬT trên org DEMO: HĐ INV-2026-00309 (A203, 10/2027, APPROVED,
// chưa thu). Contract 8b564ddf còn 3 HĐ mở (4.570.000 + 900.000 + 300.000) nên
// "tính lại" phải ra 5.770.000. Cuối bài trả về nguyên trạng (nợ cũ 0).
const INVOICE_ID = '4c27ab83-ab5c-445f-933c-fde5895d2a65';
const BASE_TOTAL = 200_000;
const EXPECTED_DEBT = 5_770_000;

test('lưu nợ cũ + sources round-trip trên org DEMO', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  const openEditDialog = async () => {
    await page.goto(`/invoices/${INVOICE_ID}`);
    await page.waitForLoadState('networkidle');
    await page.locator('button:has(svg.lucide-pencil)').first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText(/Chỉnh sửa hoá đơn/)).toBeVisible();
    return dlg;
  };
  const parseVnd = (s: string) => Number(s.replace(/[^\d]/g, ''));

  try {
    // ── 1) Tính lại nợ cũ → lưu ────────────────────────────────────────────
    let dialog = await openEditDialog();
    let debtBox = dialog.locator('.bg-red-50').filter({ hasText: 'Nợ cũ kỳ trước:' });
    await debtBox.locator('button[title*="Tính lại nợ cũ"]').click();

    const debtInput = debtBox.locator('input').first();
    await expect
      .poll(async () => parseVnd(await debtInput.inputValue()), { timeout: 20_000 })
      .toBe(EXPECTED_DEBT);

    // Sources phải hiện ra dưới ô (3 hoá đơn cũ) → chứng tỏ link cascade còn sống.
    await expect(debtBox.locator('li')).toHaveCount(3);

    // Tổng cộng = gốc + nợ cũ.
    const total = dialog.locator('.bg-blue-50').locator('span').last();
    await expect
      .poll(async () => parseVnd((await total.textContent()) ?? '0'), { timeout: 10_000 })
      .toBe(BASE_TOTAL + EXPECTED_DEBT);

    await dialog.getByRole('button', { name: 'Cập nhật' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Detail page phải hiện nợ cũ vừa lưu.
    await expect(page.getByText('Nợ cũ kỳ trước')).toBeVisible({ timeout: 20_000 });

    // ── 2) Chỉnh tay về 0 → lưu (trả nguyên trạng) ─────────────────────────
    dialog = await openEditDialog();
    debtBox = dialog.locator('.bg-red-50').filter({ hasText: 'Nợ cũ kỳ trước:' });
    // Giá trị đã lưu phải load lại đúng.
    await expect
      .poll(async () => parseVnd(await debtBox.locator('input').first().inputValue()), {
        timeout: 20_000,
      })
      .toBe(EXPECTED_DEBT);

    await debtBox.locator('input').first().fill('0');
    await debtBox.locator('input').first().blur();
    await expect(debtBox.getByText(/Đã chỉnh tay/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cập nhật' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  } finally {
    // Chốt cứng nguyên trạng dù test fail giữa chừng.
    await page.goto(`/invoices/${INVOICE_ID}`);
    await page.waitForLoadState('networkidle');
  }

  expect(errors, `Console errors: ${errors.join(' | ')}`).toEqual([]);
});
