import { expect, test } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

// E2E cho đợt GÔM NÚT XOÁ VỀ NÚT HUỶ (09/2026).
//
// Bối cảnh: đêm 31/08 nút Xoá (soft-delete) làm hoá đơn biến mất khỏi MỌI tab —
// kể cả "Đã huỷ" — không có đường phục hồi trên UI. Từ đợt này nút đỏ ở danh
// sách là HUỶ (status → CANCELLED): hoá đơn nằm trong tab "Đã huỷ" và user
// thường (không cần super admin) phục hồi được ngay.
//
// Bài test GHI THẬT trên org DEMO nhưng round-trip huỷ → phục hồi nên kết thúc
// nguyên trạng. Chạy trên build LOCAL vì thay đổi chưa lên production:
//   cd .e2e-fleet && FLEET_BASE_URL=http://localhost:8082 FLEET_WORKERS=1 \
//     npx playwright test specs/invoice-cancel-consolidation.spec.ts

test('huỷ từ danh sách → hiện trong tab Đã huỷ → phục hồi (round-trip DEMO)', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/invoices');
  await page.waitForLoadState('networkidle');

  // Hàng đầu tiên có nút huỷ (nút đỏ bg-red-100 — chỉ hiện với DRAFT/APPROVED
  // chưa thu đồng nào, đúng luật canCancelInvoice).
  const cancellableRow = page
    .locator('table tbody tr')
    .filter({ has: page.locator('button.bg-red-100') })
    .first();
  await expect(cancellableRow).toBeVisible({ timeout: 30_000 });

  // Nhận diện hoá đơn qua aria-label của checkbox ("Chọn hoá đơn INV-…") để
  // tìm lại đúng nó trong tab Đã huỷ (tìm theo số HĐ, không lệ thuộc phân trang).
  const ariaLabel = await cancellableRow
    .locator('[role="checkbox"], input[type="checkbox"]')
    .first()
    .getAttribute('aria-label');
  const invoiceNumber = (ariaLabel ?? '').replace(/^Chọn hoá đơn\s*/, '').trim();
  expect(invoiceNumber, `aria-label checkbox: ${ariaLabel}`).not.toBe('');

  // Hộp confirm mới phải nói rõ: vào mục "Đã huỷ" + phục hồi được (không còn
  // lời lẽ "xoá" mơ hồ của đường soft-delete cũ).
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('Đã huỷ');
    expect(dialog.message()).toContain('phục hồi');
    void dialog.accept();
  });
  await cancellableRow.locator('button.bg-red-100').first().click();
  await expect(page.getByText('Hoá đơn đã được huỷ').first()).toBeVisible({ timeout: 30_000 });

  try {
    // ── Tab "Đã huỷ": hoá đơn vừa huỷ PHẢI nằm ở đây ─────────────────────────
    await page.locator('button[data-ai-safe="invoices.list.invoice.status-filter"]').click();
    await page.getByRole('option', { name: 'Đã huỷ' }).click();

    const searchBox = page.getByPlaceholder(/Tìm/i).first();
    await searchBox.fill(invoiceNumber);

    const cancelledRow = page
      .locator('table tbody tr')
      .filter({ has: page.locator(`[aria-label="Chọn hoá đơn ${invoiceNumber}"]`) })
      .first();
    await expect(cancelledRow).toBeVisible({ timeout: 30_000 });
    await expect(cancelledRow.getByText('Đã huỷ', { exact: true })).toBeVisible();

    // ── Phục hồi ngay trên danh sách bằng tài khoản thường ───────────────────
    const restoreBtn = cancelledRow.locator('button.bg-amber-100').first();
    await expect(
      restoreBtn,
      'Nút Phục hồi phải hiện cho user thường có quyền huỷ (không cần super admin)',
    ).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await restoreBtn.click();
    await expect(page.getByText('Đã phục hồi hoá đơn').first()).toBeVisible({ timeout: 30_000 });
  } finally {
    // Chốt nguyên trạng dù fail giữa chừng: quay về view mặc định.
    await page.goto('/invoices');
    await page.waitForLoadState('networkidle');
  }

  // ── View "Đã duyệt": hoá đơn đã trở lại ──────────────────────────────────
  // Filter view_status lưu sessionStorage nên vẫn đang ở "Đã huỷ" — chuyển về.
  await page.locator('button[data-ai-safe="invoices.list.invoice.status-filter"]').click();
  await page.getByRole('option', { name: 'Đã duyệt' }).click();
  const searchBoxAfter = page.getByPlaceholder(/Tìm/i).first();
  await searchBoxAfter.fill(invoiceNumber);
  await expect(
    page.locator(`[aria-label="Chọn hoá đơn ${invoiceNumber}"]`).first(),
  ).toBeVisible({ timeout: 30_000 });

  expect(errors, `Console errors: ${errors.join(' | ')}`).toEqual([]);
});
