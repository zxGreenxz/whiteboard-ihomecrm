// =============================================================================
// Dán ảnh chứng từ (Ctrl+V) trên trang Thu tiền → Đóng tiền theo kỳ.
//
// Bug gốc (user báo 28/07/2026): panel desktop và sheet trong khung điện thoại
// cùng mount useUtilityPayState → 2 listener 'paste'; instance đăng ký trước
// (sheet) nuốt event trong khi key của nó rỗng, nên dán ở bảng desktop luôn ra
// toast "Chạm vào ô Số tiền…". Nay đích dán là biến module (owner+key) và
// hover thắng focus.
//
// Chạy (dev local đã có fix):
//   cd .e2e-fleet && FLEET_BASE_URL=http://localhost:8080 FLEET_WORKERS=2 \
//     npx playwright test specs/utility-paste-receipt.spec.ts
// =============================================================================

import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

// PNG 1×1 trong suốt (67 byte) — đủ để qua validateReceiptFile.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Dán ảnh vào document (đúng đường event thật: ClipboardEvent + DataTransfer). */
async function pasteImage(page: Page) {
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'receipt.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
}

/**
 * Mở panel desktop "Đóng tiền theo kỳ" rồi CHUYỂN sang Điện & Nước — đúng
 * đường user đi. Thứ tự mount này mới lộ bug: sheet trong khung điện thoại
 * mount hook trước, bảng desktop mount sau nên listener 'paste' của nó xếp sau.
 */
async function openUtilityPanel(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('overview'));
  });
  await page.goto('/thu-tien');
  await page.locator('.tt-utility[title="Đóng tiền điện nước"]').click(); // nút Plug ở header khung điện thoại
  await expect(page.locator('.ptt-panel')).toBeVisible();
  await page.locator('.ptt-panel .ptt-trigger').click();
  await page.locator('.ptt-panel .ptt-menu-item', { hasText: 'Điện & Nước' }).click();
  await expect(page.locator('.ptt-panel .ud-table tbody tr').first()).toBeVisible({ timeout: 30_000 });
}

/** Dòng chưa đóng đầu tiên trong bảng desktop (còn nút camera). */
function firstUnpaidRow(page: Page) {
  return page.locator('.ptt-panel .ud-table tbody tr').filter({ has: page.locator('.ud-attach') }).first();
}

type Upload = { url: string; headers: Record<string, string> };

/** Ghi lại ảnh đã upload để cuối bài xoá sạch (không để rác trong Storage). */
function trackUploads(page: Page): Upload[] {
  const done: Upload[] = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (req.method() !== 'POST' || !res.ok()) return;
    if (!/\/storage\/v1\/object\/payment-receipts\//.test(res.url())) return;
    done.push({ url: res.url(), headers: await req.allHeaders() });
  });
  return done;
}

/** Xoá ảnh test bằng chính token của phiên vừa upload. */
async function cleanupUploads(page: Page, uploads: Upload[]) {
  for (const u of uploads) {
    const res = await page.request.delete(u.url, {
      headers: { apikey: u.headers['apikey'], authorization: u.headers['authorization'] },
    });
    expect(res.ok(), `dọn ảnh test: ${u.url}`).toBeTruthy();
  }
  uploads.length = 0;
}

test('dien-nuoc: re chuot vao dong roi Ctrl+V dinh dung dong do', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const uploads = trackUploads(page);
  await login(page, 'chunha');
  await openUtilityPanel(page);

  const row = firstUnpaidRow(page);
  await expect(row).toBeVisible();
  const attachBtn = row.locator('.ud-attach');
  await expect(attachBtn).not.toHaveClass(/has/);

  // Chỉ RÊ CHUỘT (không bấm gì) rồi dán — đúng thao tác user mô tả.
  await row.hover();
  await pasteImage(page);

  // Không được ra toast nhắc nữa; phải upload thật và nút ảnh sáng lên.
  await expect(page.getByText('Đã đính kèm ảnh phiếu')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Đưa chuột vào dòng cần đính ảnh')).toHaveCount(0);
  await expect(attachBtn).toHaveClass(/has/);

  expect(errs, 'console errors').toEqual([]);
  await cleanupUploads(page, uploads);
});

test('dien-nuoc: khong nham dong — dan vao dung dong dang hover', async ({ page }) => {
  const uploads = trackUploads(page);
  await login(page, 'chunha');
  await openUtilityPanel(page);

  const rows = page.locator('.ptt-panel .ud-table tbody tr').filter({ has: page.locator('.ud-attach') });
  if ((await rows.count()) < 2) test.skip(true, 'Cần ≥2 dòng chưa đóng để kiểm tra chọn nhầm dòng');

  // Bấm ô Số tiền dòng 1 (đặt focus target), rồi rê chuột sang dòng 2 và dán:
  // hover phải THẮNG focus.
  const row1 = rows.nth(0);
  const row2 = rows.nth(1);
  await row1.locator('.ud-amt').click();
  await row2.hover();
  await pasteImage(page);

  await expect(page.getByText('Đã đính kèm ảnh phiếu')).toBeVisible({ timeout: 30_000 });
  await expect(row2.locator('.ud-attach')).toHaveClass(/has/);
  await expect(row1.locator('.ud-attach')).not.toHaveClass(/has/);
  await cleanupUploads(page, uploads);
});

test('tien-nha (GRID): re chuot vao dong roi Ctrl+V cung dinh duoc anh', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const uploads = trackUploads(page);
  await login(page, 'chunha');
  await page.addInitScript(() => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('overview'));
  });
  await page.goto('/thu-tien');
  await page.locator('.tt-utility[title="Đóng tiền điện nước"]').click();
  await page.locator('.ptt-panel .ptt-trigger').click();
  await page.locator('.ptt-panel .ptt-menu-item', { hasText: 'Tiền nhà' }).click();

  const row = page.locator('.ptt-panel .ud-table tbody tr').filter({ has: page.locator('.ud-attach') }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await pasteImage(page);

  await expect(page.getByText('Đã đính kèm ảnh phiếu')).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('.ud-attach')).toHaveClass(/has/);
  expect(errs, 'console errors').toEqual([]);
  await cleanupUploads(page, uploads);
});

test('sheet khung dien thoai: dan anh cung an dung the dang hover', async ({ page }) => {
  const uploads = trackUploads(page);
  await login(page, 'chunha');
  await openUtilityPanel(page); // bảng desktop mở sẵn ở Điện & Nước

  // Bấm ô Số tiền BÊN DESKTOP trước (đặt focus target ở instance panel), rồi
  // rê chuột sang thẻ trong khung điện thoại — instance sheet phải giành lại.
  await firstUnpaidRow(page).locator('.ud-amt').click();
  await page.locator('.tt-phone-col .ptt-go', { hasText: 'Đóng' }).first().click();
  const card = page.locator('.tt-phone-col .ubc-row').filter({ has: page.locator('.ub-attach') }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  await card.hover();
  await pasteImage(page);

  await expect(page.getByText('Đã đính kèm ảnh phiếu')).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.ub-attach')).toHaveClass(/has/);
  // Dòng desktop vừa bấm KHÔNG được ăn ảnh.
  await expect(firstUnpaidRow(page).locator('.ud-attach')).not.toHaveClass(/has/);
  await cleanupUploads(page, uploads);
});

test('dien-nuoc: khong nham dong nao thi nhac 1 lan duy nhat', async ({ page }) => {
  await login(page, 'chunha');
  await openUtilityPanel(page);

  // Chuột ở góc trên (ngoài mọi dòng) → chưa có đích.
  await page.mouse.move(2, 2);
  await pasteImage(page);

  const hint = page.getByText('Đưa chuột vào dòng cần đính ảnh');
  await expect(hint.first()).toBeVisible();
  // 2 instance (panel desktop + sheet mobile) cùng nghe → chỉ MỘT toast.
  await expect(hint).toHaveCount(1);
});
