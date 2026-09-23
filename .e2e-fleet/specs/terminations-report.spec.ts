import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Báo cáo Bỏ trả / thanh lý — trang CHỈ ĐỌC.
 *
 * 23/09/2026 chủ bỏ hẳn "đường hoàn khách thứ hai": nút "Kiểm tra" + hộp thoại
 * sinh phiếu hoàn trên trang này đã gỡ, và migration 20260923161122 thu quyền gọi
 * RPC ghi nghĩa vụ hoàn ở máy chủ (không có nghĩa vụ thì không sinh được phiếu
 * theo đường này). Phiếu hoàn khách thanh lý chỉ còn sinh
 * từ luồng trả phòng. Spec canh để nút đó không quay lại và trang vẫn mở sạch lỗi.
 * Thay cho `termination-refund.spec.ts` + `termination-refund-full-cycle.spec.ts`
 * (cùng đợt gỡ).
 */

const ROUTE = '/reports/real-estate/terminations';

test('báo cáo thanh lý mở được và KHÔNG còn nút sinh phiếu hoàn', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  // Kỳ lọc mặc định là THÁNG HIỆN TẠI — đo 23/09/2026, DEMO không có hợp đồng thanh
  // lý nào trong kỳ đó, bảng rỗng, và "không có nút Kiểm tra" xanh rỗng ngay cả trên
  // bản còn nút. Đặt khoảng ngày rộng (khoá sessionStorage của usePersistedDateRange)
  // rồi ĐÒI bảng có dòng.
  await page.evaluate(() =>
    sessionStorage.setItem(
      'flt:rpt-terminations:dateRange',
      JSON.stringify({ from: '2024-01-01T00:00:00.000Z', to: new Date().toISOString() }),
    ),
  );
  await page.goto(ROUTE);
  await expect(page.getByRole('heading', { name: /Báo cáo Bỏ trả/i })).toBeVisible();

  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count(), 'bảng phải có dòng thì kiểm vắng nút mới có nghĩa').toBeGreaterThan(0);
  await expect(page.getByRole('columnheader', { name: 'Tiền cọc' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Kiểm tra' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Hoàn cọc' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});
