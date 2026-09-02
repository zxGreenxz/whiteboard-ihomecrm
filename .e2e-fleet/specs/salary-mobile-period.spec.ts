import { test, expect, devices, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { cleanupDemoSalaryConfig, ensureDemoSalaryConfig } from './accounting-admin';

// Bảng lương cá nhân trên ĐIỆN THOẠI phải chuyển kỳ được như bản desktop.
test.use({ ...devices['Pixel 7'] });

// Self-view chỉ hiện khi tài khoản CÓ cấu hình hưởng lương. Trước 02/09/2026 spec
// skip khi org DEMO thiếu cấu hình → test "xanh" mà không kiểm gì. Nay fixture
// tự tạo dòng manager_salary_config cho DEMO quanly (đánh dấu note) và xoá sau,
// giữ đúng luật "không ghi fixture lâu dài vào org DEMO".
let fixtureState: 'existing' | 'created' | null = null;

test.beforeAll(async () => {
  fixtureState = await ensureDemoSalaryConfig();
  console.log('[salary-mobile-period] cấu hình lương DEMO:', fixtureState);
});

test.afterAll(async () => {
  if (fixtureState === 'created') {
    const deleted = await cleanupDemoSalaryConfig();
    console.log('[salary-mobile-period] đã dọn fixture:', deleted);
  }
});

// Còn giữ để fail-loud rõ nghĩa: nếu fixture đã tạo mà UI vẫn báo chưa cấu hình
// thì là bug thật (self-view không nhận config), không phải thiếu dữ liệu.
async function skipIfNoSalaryConfig(page: Page) {
  const empty = page.getByText('chưa được cấu hình hưởng lương');
  const nav = page.getByRole('button', { name: 'Tháng trước' });
  // Chờ MỘT trong hai xuất hiện (isVisible() không chờ → phải waitFor).
  await Promise.race([
    nav.waitFor({ state: 'visible', timeout: 45_000 }),
    empty.waitFor({ state: 'visible', timeout: 45_000 }),
  ]).catch(() => {});
  if (await empty.isVisible()) {
    throw new Error(
      `Tài khoản DEMO quanly vẫn báo "chưa được cấu hình hưởng lương" dù fixture=${fixtureState} — self-view không nhận manager_salary_config.`,
    );
  }
}

test('mobile: lùi/tiến tháng ở trang Lương của tôi', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'quanly');
  await page.goto('/finance/my-salary');
  await skipIfNoSalaryConfig(page);

  const prev = page.getByRole('button', { name: 'Tháng trước' });
  const next = page.getByRole('button', { name: 'Tháng sau' });
  await expect(prev).toBeVisible({ timeout: 45_000 });

  const pill = prev.locator('xpath=following-sibling::span[1]');
  const start = (await pill.innerText()).trim();
  console.log('kỳ ban đầu:', start);

  // Ở kỳ hiện tại: "Tháng sau" phải bị khoá.
  await expect(next).toBeDisabled();

  await prev.click();
  await expect(prev).toBeVisible({ timeout: 45_000 });
  const back1 = (await page.getByRole('button', { name: 'Tháng trước' })
    .locator('xpath=following-sibling::span[1]').innerText()).trim();
  console.log('sau khi lùi 1 tháng:', back1);
  expect(back1).not.toBe(start);

  // Lùi thêm 1 tháng rồi tiến lại 2 lần → về đúng kỳ ban đầu.
  await page.getByRole('button', { name: 'Tháng trước' }).click();
  await expect(page.getByRole('button', { name: 'Tháng sau' })).toBeEnabled();
  await page.getByRole('button', { name: 'Tháng sau' }).click();
  await expect(page.getByRole('button', { name: 'Tháng trước' })
    .locator('xpath=following-sibling::span[1]')).toHaveText(new RegExp(back1.replace('/', '\\/')));
  await page.getByRole('button', { name: 'Tháng sau' }).click();

  const backNow = page.getByRole('button', { name: 'Tháng trước' })
    .locator('xpath=following-sibling::span[1]');
  await expect(backNow).toHaveText(new RegExp(start.replace('/', '\\/')));
  await expect(page.getByRole('button', { name: 'Tháng sau' })).toBeDisabled();

  // Hàng đầu hero KHÔNG được tràn: nút thoát phải nằm trọn trong khung.
  const exitBtn = page.getByRole('button', { name: 'Quay lại' });
  const box = await exitBtn.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box, 'không thấy nút Quay lại').not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw);

  await page.screenshot({ path: 'salary-mobile-period.png' });
  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});

// Route trong app (sidebar "Bảng lương") — nhánh mobile của ManagerSalaryPage.
test('mobile: lùi/tiến tháng ở /finance/salary (self view)', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'quanly');
  await page.goto('/finance/salary');
  await skipIfNoSalaryConfig(page);

  const prev = page.getByRole('button', { name: 'Tháng trước' });
  await expect(prev).toBeVisible({ timeout: 45_000 });
  const label = page.getByRole('button', { name: 'Tháng trước' })
    .locator('xpath=following-sibling::span[1]');
  const start = (await label.innerText()).trim();
  await expect(page.getByRole('button', { name: 'Tháng sau' })).toBeDisabled();

  await prev.click();
  await expect(label).not.toHaveText(new RegExp(start.replace('/', '\\/')));
  await expect(page.getByRole('button', { name: 'Tháng sau' })).toBeEnabled();
  await page.getByRole('button', { name: 'Tháng sau' }).click();
  await expect(label).toHaveText(new RegExp(start.replace('/', '\\/')));

  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});
