import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Hộp thoại "Tạo phiếu cọc giữ chỗ" (20/08/2026): sổ quỹ + ảnh chứng từ cho CẢ
 * phiếu cọc lẫn phiếu thưởng Sale, và STK/ngân hàng người nhận thưởng.
 *
 * BÀI NÀY ĐO CÁI GÌ: dialog có gửi đúng bốn thứ mới sang đúng hàm hay không.
 * Chúng nằm trên HAI đường ghi khác nhau — phiếu cọc đi
 * `create_income_expense_v1`, phiếu thưởng đi `create_sale_bonus_from_deposit_v1`
 * — nên đây là chỗ dễ nối nhầm nhất, và cũng là chỗ đã hở suốt ba tuần (ô thưởng
 * có sẵn trong dialog mà thực tế không ai chạm tới được).
 *
 * VÌ SAO CHẶN MẠNG THAY VÌ GHI THẬT: org DEMO hiện KHÔNG có `staff_assignments`
 * nào, nên `create_income_expense_v1` từ chối mọi phiếu với 42501 "Không có
 * quyền tạo phiếu thu/chi cho toà này" — bài sẽ đỏ vì dữ liệu DEMO thiếu quyền,
 * không phải vì mã sai. Vế server của hai hàm đã đo riêng bằng lời gọi RPC thật
 * với JWT demo.chunha, gồm cả ba ca từ chối (sổ quỹ không có quyền, ảnh sai kiểu,
 * chi trùng). Ở đây chỉ đo phần mà chỉ trình duyệt mới trả lời được.
 *
 * Ảnh 1×1 vẫn upload THẬT lên storage — đó là cách duy nhất biết
 * AttachmentUpload kịp trả URL về form trước lúc bấm Lưu.
 */

const BUILDING = 'DEMO Toà A';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const FAKE_DEPOSIT_ID = '00000000-0000-4000-8000-00000000d0c0';

test('dialog-coc-gui-du-so-quy-anh-va-stk-sang-hai-rpc', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const stamp = Date.now();
  const stk = `E2E${stamp}`.slice(0, 16);
  const bank = 'Vietcombank E2E';

  let depositPayload: Record<string, unknown> | null = null;
  let bonusPayload: Record<string, unknown> | null = null;

  // Chặn ĐÚNG hai lời gọi ghi; mọi request khác đi bình thường.
  await page.route('**/rest/v1/rpc/create_income_expense_v1', async (route) => {
    depositPayload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: FAKE_DEPOSIT_ID, code: 'PT-E2E', approval_status: 'APPROVED' }),
    });
  });
  await page.route('**/rest/v1/rpc/create_sale_bonus_from_deposit_v1', async (route) => {
    bonusPayload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ voucherId: FAKE_DEPOSIT_ID, code: 'PC-E2E', amount: 120000, note: '' }),
    });
  });

  await login(page, 'chunha');
  await page.goto('/deposits');

  await page.getByRole('button', { name: 'Tạo đặt cọc' }).click();
  await expect(page.getByRole('heading', { name: 'Tạo phiếu cọc giữ chỗ' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Căn hộ *' }).click();
  await page.getByRole('option', { name: new RegExp(BUILDING) }).first().click();
  await page.getByRole('textbox', { name: 'Số tiền cọc *' }).fill('1500000');

  // Sổ quỹ giờ BẮT BUỘC — bỏ trống thì zod chặn, không RPC nào được gọi.
  await page.getByRole('combobox', { name: 'Sổ quỹ ghi cọc *' }).click();
  await page.getByRole('option').first().click();

  const fileInputs = page.locator('input[type="file"]');
  await expect(fileInputs).toHaveCount(2);
  await fileInputs.nth(0).setInputFiles({ name: 'coc.png', mimeType: 'image/png', buffer: PNG_1PX });

  await page.getByRole('spinbutton', { name: 'Số tiền thưởng' }).fill('120000');
  await page.getByRole('textbox', { name: 'Người nhận', exact: true }).fill(`E2E sale ${stamp}`);
  await page.getByRole('textbox', { name: 'STK người nhận' }).fill(stk);
  await page.getByRole('textbox', { name: 'Ngân hàng' }).fill(bank);
  await page.getByRole('combobox', { name: /Sổ quỹ chi thưởng/ }).click();
  await page.getByRole('option').first().click();
  await fileInputs
    .nth(1)
    .setInputFiles({ name: 'thuong.png', mimeType: 'image/png', buffer: PNG_1PX });

  // Chờ ảnh thứ hai lên xong: 2 thumbnail = 2 URL đã nằm trong state.
  await expect(page.getByRole('img', { name: 'Đính kèm' })).toHaveCount(2);

  await page.getByRole('button', { name: /^Tạo đặt cọc$/ }).click();
  await expect
    .poll(() => (depositPayload && bonusPayload ? 'du' : 'thieu'), { timeout: 30_000 })
    .toBe('du');

  // ── Phiếu cọc: sổ quỹ người dùng chọn + ảnh, không còn tự đoán sổ.
  const dep = depositPayload as unknown as Record<string, unknown>;
  expect(dep.p_account_id, 'phiếu cọc phải mang sổ quỹ đã chọn').toBeTruthy();
  expect((dep.p_attachments as string[])?.length, 'ảnh chứng từ phiếu cọc').toBe(1);
  expect((dep.p_attachments as string[])[0]).toMatch(/^https:\/\//);

  // ── Phiếu thưởng: bốn trường mới đi đúng tham số của RPC.
  const bon = bonusPayload as unknown as Record<string, unknown>;
  expect(bon.p_deposit_voucher_id, 'thưởng phải neo vào phiếu cọc vừa tạo').toBe(FAKE_DEPOSIT_ID);
  expect(bon.p_account_number, 'STK người nhận').toBe(stk);
  expect(bon.p_bank, 'ngân hàng người nhận').toBe(bank);
  expect(bon.p_account_id, 'sổ quỹ chi thưởng').toBeTruthy();
  expect((bon.p_attachments as string[])?.length, 'ảnh chứng từ thưởng').toBe(1);

  expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
});
