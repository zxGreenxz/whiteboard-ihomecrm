import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chốt: bảng chọn quyền KHÔNG chào mời trang OpenClaw Zalo khi cờ runtime tắt.
 *
 * Đo trên bundle production 05/08/2026 (main 7f47c3a): entry chunk chứa nguyên
 * mục catalog {key:"openclaw_zalo", route:"/openclaw-zalo", desc:"Kết nối Zalo
 * cá nhân…"} và PermissionPicker render PAGE_GROUPS không lọc — nên chủ tổ chức
 * mở màn phân quyền là thấy 8 tính năng của một trang mà route render null.
 * Quyền thì có thật ở máy chủ (đã cấp cho vai trò chủ sở hữu), nên cách sửa
 * đúng là giấu ở tầng hiển thị chứ không gỡ khỏi catalog — gỡ sẽ tạo "quyền mồ
 * côi" và làm đỏ findOrphanRegistryKeys().
 *
 * Bài này KHÔNG bấm Lưu — chỉ mở hộp thoại "Tạo vai trò" rồi đóng, nên không
 * đụng vai trò thật của org DEMO.
 *
 * LƯU Ý: fleet mặc định trỏ production, nơi CHƯA có bản sửa này. Muốn kiểm
 * trước khi deploy thì chạy trên bản build cục bộ:
 *   npx vite build && npx vite preview --port 4173
 *   FLEET_BASE_URL=http://localhost:4173 npx playwright test specs/openclaw-picker-hidden.spec.ts
 */

test('picker-khong-chao-moi-openclaw-khi-co-tat', async ({ page }) => {
  const errs = trackConsoleErrors(page);

  await login(page, 'chunha');
  await page.goto('/settings/roles');

  await page.getByRole('button', { name: 'Tạo vai trò' }).click();

  const hop = page.getByRole('dialog');
  await expect(hop).toBeVisible();

  // Chứng cứ ĐỐI CHỨNG trước: hộp thoại đã render bảng chọn quyền thật. Thiếu
  // bước này thì "không thấy OpenClaw" có thể chỉ vì hộp thoại chưa kịp mở, và
  // bài test sẽ xanh vì lý do sai.
  await expect(hop.getByText('Chat Zalo', { exact: true })).toBeVisible();

  // Trang chưa ship phải vắng mặt hoàn toàn — cả nhãn lẫn mô tả.
  await expect(hop.getByText('OpenClaw Zalo cá nhân')).toHaveCount(0);
  await expect(hop.getByText(/Kết nối Zalo cá nhân, inbox, AI draft/)).toHaveCount(0);

  // Và không lôi ra được bằng ô tìm kiếm — đường vòng dễ bị bỏ sót, vì nhánh
  // tìm kiếm của picker lọc trên một danh sách khác với nhánh mặc định.
  //
  // KHÔNG khẳng định /OpenClaw/i vắng mặt ở đây: thông báo rỗng nhại lại đúng
  // từ khoá vừa gõ ("Không có quyền nào khớp “openclaw”."), nên một phủ định
  // rộng như thế sẽ tự bắt chính mình chứ không đo được gì.
  await hop.getByPlaceholder(/Tìm quyền/).fill('openclaw');
  await expect(hop.getByText(/Không có quyền nào khớp/)).toBeVisible();
  await expect(hop.getByText('OpenClaw Zalo cá nhân')).toHaveCount(0);

  // Tìm bằng từ chung "zalo": Chat Zalo phải ra, OpenClaw thì không. Đây là
  // phép đo thật sự — nếu bộ lọc hỏng, trang chưa ship sẽ hiện ở đây.
  await hop.getByPlaceholder(/Tìm quyền/).fill('zalo');
  await expect(hop.getByText('Chat Zalo', { exact: true })).toBeVisible();
  await expect(hop.getByText('OpenClaw Zalo cá nhân')).toHaveCount(0);
  await expect(hop.getByText(/Vào trang OpenClaw Zalo/)).toHaveCount(0);

  // Đóng, KHÔNG lưu.
  await page.keyboard.press('Escape');

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
