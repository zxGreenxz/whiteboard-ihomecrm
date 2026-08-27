import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Panel "Chu trình phòng" trên /thu-tien (Plan 2 Task 6A + Task 7 Step 4) —
 * spec mà plan §2.3 hứa từ 30/07 và audit 27/08 ghi "không tồn tại".
 *
 * ĐỌC-ONLY. Kiểm ba điều:
 *  1. Nút mở sheet có thật trên /thu-tien và sheet mở được;
 *  2. Chọn phòng ⇒ hoặc timeline (thanh + chú giải), hoặc trạng thái rỗng nói
 *     rõ ràng — KHÔNG BAO GIỜ là khối lỗi "Không đọc được chu trình phòng"
 *     (chunha có quyền mọi toà DEMO nên 42501 ở đây là hỏng cổng quyền);
 *  3. Không lỗi console.
 */

test('chu trình phòng: mở sheet, chọn phòng, timeline hoặc trạng thái rỗng tử tế', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/thu-tien');
  const openBtn = page.getByTitle(/Chu trình phòng/i);
  await expect(openBtn).toBeVisible({ timeout: 20_000 });
  await openBtn.click();

  await expect(page.getByText('Chu trình phòng', { exact: true })).toBeVisible();
  const roomSelect = page.locator('.sheet.full select').nth(1);
  await expect(roomSelect).toBeVisible();

  // Chờ danh sách phòng nạp xong rồi thử lần lượt tới khi gặp phòng CÓ dữ liệu
  // (tối đa 5 phòng — DEMO chắc chắn có phòng có hợp đồng trong số đó).
  await expect
    .poll(async () => (await roomSelect.locator('option').count()), { timeout: 20_000 })
    .toBeGreaterThan(1);
  const values = await roomSelect
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));

  let sawTimeline = false;
  for (const v of values.slice(0, 5)) {
    await roomSelect.selectOption(v);
    // Một trong ba kết cục hợp lệ phải xuất hiện; khối lỗi là FAIL ngay.
    const outcome = page
      .locator('.rl-legend, .rl-empty, .rl-problem')
      .first();
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/Không đọc được chu trình phòng/i),
      'RPC trả lỗi cho phòng DEMO mà chunha có quyền xem — cổng quyền hoặc hàm đang hỏng',
    ).toBeHidden();
    if (await page.locator('.rl-legend').isVisible().catch(() => false)) {
      sawTimeline = true;
      break;
    }
  }

  expect(
    sawTimeline,
    '5 phòng đầu của toà DEMO đều không vẽ được timeline — hoặc DEMO mất dữ liệu hợp đồng, hoặc panel hỏng',
  ).toBeTruthy();

  // Timeline thật thì phải có ít nhất một thanh hợp đồng và chuỗi sự kiện.
  await expect(page.locator('.rl-bar').first()).toBeVisible();
  await expect(page.locator('.rl-item').first()).toBeVisible();

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});
