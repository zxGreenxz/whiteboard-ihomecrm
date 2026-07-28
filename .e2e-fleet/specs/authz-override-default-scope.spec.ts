import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chốt hành vi thêm 27/07/2026 ở hộp thoại Phân quyền thành viên:
 *
 *   · Khoá "Đảo bút toán phiếu đã ghi sổ" (income_expenses.reverse) có mặt trong
 *     bảng chọn quyền — cấp được bằng giao diện, không phải bằng SQL.
 *   · Khi thêm ngoại lệ, phạm vi MẶC ĐỊNH là đúng những toà người đó đang phụ
 *     trách (lấy từ vai trò đã gán) chứ không để trống.
 *   · Có hai nút chọn nhanh "Toà đang phụ trách" / "Tất cả toà nhà", bên dưới
 *     vẫn là bộ chọn đầy đủ (thêm toà khác, hoặc Toàn tổ chức).
 *
 * Bài này KHÔNG bấm Lưu — chỉ dựng trạng thái trong hộp thoại rồi đóng, nên
 * không đụng phân quyền thật của org DEMO.
 *
 * LƯU Ý: fleet mặc định trỏ vào production. Bài này chỉ xanh khi bản đang chạy
 * đã có thay đổi giao diện 27/07. Muốn kiểm trước khi deploy:
 *   npm run dev
 *   FLEET_BASE_URL=http://localhost:8080 npx playwright test specs/authz-override-default-scope.spec.ts
 */

test('them-ngoai-le-reverse-mac-dinh-theo-toa-phu-trach', async ({ page }) => {
  const errs = trackConsoleErrors(page);

  await login(page, 'chunha');
  await page.goto('/settings/members');

  // Lọc tới ĐÚNG một người khác mình: hộp thoại chặn tự sửa quyền của chính
  // mình, nên bấm thẻ đầu danh sách (chính chunha) sẽ chỉ ra màn cảnh báo.
  await page.getByPlaceholder('Tìm theo tên, email hoặc vai trò…').fill('demo.quanly');
  await expect(page.getByRole('button', { name: 'Phân quyền' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Phân quyền' }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog.getByRole('tab', { name: /Ngoại lệ/i })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('tab', { name: /Ngoại lệ/i }).click();

  await dialog.getByRole('button', { name: /Thêm ngoại lệ/i }).click();
  const chonQuyen = page.getByRole('dialog').filter({ hasText: 'Chọn quyền cần thêm ngoại lệ' });

  // Bảng chọn gom theo trang và gập sẵn → lọc bằng ô tìm cho chắc.
  await chonQuyen.getByPlaceholder(/Tìm quyền/).fill('Đảo bút toán');
  // Khoá reverse phải có nhãn tiếng Việt trong bảng chọn.
  const oReverse = chonQuyen.getByText('Đảo bút toán phiếu đã ghi sổ', { exact: true });
  await expect(oReverse).toBeVisible({ timeout: 20_000 });
  await oReverse.click();
  await chonQuyen.getByRole('button', { name: 'Xong' }).click();

  // Dòng ngoại lệ vừa thêm: phải có sẵn phạm vi, KHÔNG được "chưa có phạm vi".
  const dongOv = dialog
    .locator('div')
    .filter({ hasText: 'Đảo bút toán phiếu đã ghi sổ' })
    .last();
  await expect(dongOv).not.toContainText('chưa có phạm vi');

  // Bung ra: hai nút chọn nhanh phải hiện.
  await dialog.getByRole('button', { name: 'Sửa' }).last().click();
  // Số trong ngoặc phải > 0: demo.quanly có vai trò gắn phạm vi toà, nên mặc
  // định KHÔNG được rỗng — đó chính là điểm bài này canh.
  await expect(dialog.getByRole('button', { name: /Toà đang phụ trách \([1-9]\d*\)/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Tất cả toà nhà \([1-9]\d*\)/ })).toBeVisible();

  // Đóng mà KHÔNG lưu — giữ nguyên phân quyền DEMO.
  await page.keyboard.press('Escape');
  expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
});
