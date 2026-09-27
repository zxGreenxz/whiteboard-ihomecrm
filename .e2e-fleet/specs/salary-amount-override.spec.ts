import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import {
  cleanupDemoSalaryConfig,
  cleanupDemoSalaryExtras,
  cleanupDemoSalaryFixture,
  demoSalaryMonthlyIds,
  demoSalaryStaffId,
  ensureDemoSalaryConfig,
} from './accounting-admin';

// Sửa số tiền từng khoản + khoản định kỳ ở màn Lương & thu nhập (migration
// 20260927081925_luong_khoan_dinh_ky_va_so_ghi_de). Nghiệm thu SAU khi migration
// lên production: org DEMO nằm chung database production, nên trước lúc đó spec ĐỎ
// với thông điệp "chưa bật trên máy chủ" — cố ý không skip (skip = xanh rỗng).
//
// Ghi dữ liệu: chỉ org DEMO, mọi lý do mang tiền tố fixture; afterAll dọn số ghi
// đè / khoản định kỳ (app_private), dòng salary_monthly nháp và cấu hình fixture.
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const PREFIX = 'E2E fleet salary-extra ';
const TAG = `${PREFIX}${Date.now()}`;
let fixtureState: 'existing' | 'created' | null = null;
let keepMonthly: string[] = [];
let staffId = '';

test.beforeAll(async () => {
  keepMonthly = await demoSalaryMonthlyIds();
  staffId = await demoSalaryStaffId();
  fixtureState = await ensureDemoSalaryConfig();
});

test.afterAll(async () => {
  console.log('[salary-amount-override] dọn khoản định kỳ / ghi đè:', await cleanupDemoSalaryExtras(PREFIX));
  console.log('[salary-amount-override] dọn khoản/kỳ nháp:', await cleanupDemoSalaryFixture(PREFIX, keepMonthly));
  if (fixtureState === 'created') console.log('[salary-amount-override] dọn cấu hình:', await cleanupDemoSalaryConfig());
});

const money = (s: string) => Number(s.replace(/[^\d-]/g, '')) || 0;
const cashOf = async (page: Page) =>
  money(await page.getByText('Tiền thực chuyển', { exact: true }).locator('xpath=following-sibling::span[1]').innerText());

async function openIncome(page: Page) {
  await page.goto('/finance/salary');
  const tab = page.getByRole('button', { name: /Thu nhập & thanh toán/ });
  await expect(tab).toBeVisible({ timeout: 45_000 });
  await tab.click();
  await page.getByRole('button').filter({ hasText: '(fixture E2E)' }).first().click();
  await expect(page.getByText('Tiền thực chuyển', { exact: true })).toBeVisible();
}

test('chủ công ty: sửa số tiền một khoản rồi bỏ sửa tay', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');
  await openIncome(page);
  const pencil = page.getByRole('button', { name: 'Sửa số tiền: Lương cứng · chuyên cần' });
  await expect(pencil, 'không có nút sửa số tiền — migration 20260927081925 chưa lên máy chủ?').toBeVisible({ timeout: 30_000 });
  const cash0 = await cashOf(page);

  await pencil.click();
  const computed = money(await page.getByText('Số máy tính', { exact: true }).locator('xpath=following-sibling::b[1]').innerText());
  await page.locator('#sal-ovr-amount').fill(String(Math.max(0, computed - 100000)));
  await page.locator('#sal-ovr-reason').fill(TAG + ' giảm');
  await page.getByRole('button', { name: 'Lưu số mới' }).click();
  await expect(page.getByText('Sửa tay', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => cashOf(page)).toBe(cash0 - Math.min(100000, computed));

  await page.getByRole('button', { name: /Lương cứng · chuyên cần/ }).first().click();
  await page.getByRole('button', { name: 'Sửa lại số tiền / bỏ sửa tay' }).click();
  await page.locator('#sal-ovr-reason').fill(TAG + ' bỏ');
  await page.getByRole('button', { name: 'Bỏ sửa tay' }).click();
  await expect(page.getByText('Sửa tay', { exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => cashOf(page)).toBe(cash0);
  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});

test('chủ công ty: khoản định kỳ vào lương, ngừng rồi xoá', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');
  await openIncome(page);
  const cash0 = await cashOf(page);

  await page.getByRole('button', { name: /Tổng quan kỳ/ }).click();
  await page.getByRole('button', { name: /^Nguồn lương tháng/ }).click();
  const modal = page.getByRole('dialog', { name: 'Nguồn lương & khoản định kỳ' });
  await modal.getByRole('button', { name: 'Khoản định kỳ', exact: true }).click();
  await expect(modal.getByText('Chưa bật trên máy chủ.'), 'migration 20260927081925 chưa lên máy chủ').toHaveCount(0);
  await modal.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
  // Ô người nhận chỉ hiện tên — chọn theo id để trúng đúng người fixture đang mở ở tab Thu nhập.
  await modal.locator('#rec-staff').selectOption(staffId);
  await modal.locator('#rec-label').fill('Hỗ trợ xăng');
  await modal.locator('#rec-amount').fill('200000');
  await modal.locator('#rec-reason').fill(TAG + ' tạo');
  await modal.getByRole('button', { name: 'Tạo khoản định kỳ' }).click();
  const row = modal.getByRole('button').filter({ hasText: 'Hỗ trợ xăng' }).first();
  await expect(row).toContainText('200.000', { timeout: 30_000 });
  await modal.getByRole('button', { name: 'Đóng' }).click();

  await openIncome(page);
  // Dòng lương (tên bắt đầu bằng nhãn khoản) — nút bút chì "Sửa số tiền: Hỗ trợ xăng" cũng khớp /Hỗ trợ xăng/.
  await expect(page.getByRole('button', { name: /^Hỗ trợ xăng/ })).toBeVisible();
  await expect.poll(() => cashOf(page)).toBe(cash0 + 200000);

  await page.getByRole('button', { name: /Tổng quan kỳ/ }).click();
  await page.getByRole('button', { name: /^Nguồn lương tháng/ }).click();
  await modal.getByRole('button', { name: 'Khoản định kỳ', exact: true }).click();
  await row.click();
  await modal.getByRole('button', { name: 'Ngừng từ kỳ' }).click();
  await modal.locator('#recv-reason').fill(TAG + ' ngừng');
  await modal.getByRole('button', { name: 'Lưu phiên bản mới' }).click();
  await expect(row).toContainText('Không phát sinh kỳ này', { timeout: 30_000 });
  // Danh sách cập nhật TRƯỚC, form xoá ô lý do SAU (onSuccess của lượt lưu) — gõ vào
  // giữa hai nhịp thì chữ bị xoá mất và nút "Xoá khoản" đứng im. Đợi form reset xong.
  await expect(modal.locator('#recv-reason')).toHaveValue('');
  await modal.locator('#recv-reason').fill(TAG + ' xoá');
  await modal.getByRole('button', { name: /Xoá khoản/ }).click();
  await expect(modal.getByRole('button').filter({ hasText: 'Hỗ trợ xăng' })).toHaveCount(0, { timeout: 30_000 });
  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});

test('kế toán: không có nút sửa số tiền', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'ketoan');
  await page.goto('/finance/salary');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: /^Sửa số tiền: / })).toHaveCount(0);
  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});
