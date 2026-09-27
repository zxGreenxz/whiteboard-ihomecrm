import { test, expect, type Page, type Response } from '@playwright/test';
import { login, trackConsoleErrors, type UserKey } from './auth';
import {
  cleanupDemoSalaryConfig,
  cleanupDemoSalaryFixture,
  demoSalaryMonthlyIds,
  ensureDemoSalaryConfig,
} from './accounting-admin';

// Màn quản trị "Lương & thu nhập" trên DESKTOP (bản Claude Design 26/09/2026):
// Tổng quan kỳ · modal Nguồn lương & khoản định kỳ · Thu nhập & thanh toán.
//
// Ghi dữ liệu: DUY NHẤT một khoản Thưởng mang tiền tố fixture trên DEMO quanly,
// thêm và xoá lại qua chính UI. afterAll dọn phần sót (khoản, dòng salary_monthly
// nháp mà spec làm phát sinh, cấu hình lương fixture) — chỉ org DEMO.
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const PREFIX = 'E2E fleet salary ';
const LABEL = `${PREFIX}${Date.now()}`;
let fixtureState: 'existing' | 'created' | null = null;
let keepMonthly: string[] = [];

test.beforeAll(async () => {
  keepMonthly = await demoSalaryMonthlyIds();
  fixtureState = await ensureDemoSalaryConfig();
  console.log('[salary-admin-desktop] cấu hình lương DEMO:', fixtureState);
});

test.afterAll(async () => {
  const cleaned = await cleanupDemoSalaryFixture(PREFIX, keepMonthly);
  console.log('[salary-admin-desktop] đã dọn khoản/kỳ nháp:', cleaned);
  if (fixtureState === 'created') {
    console.log('[salary-admin-desktop] đã dọn cấu hình:', await cleanupDemoSalaryConfig());
  }
});

const money = (s: string) => Number(s.replace(/[^\d-]/g, '')) || 0;

/** Đăng nhập rồi đọc đúng tập quyền trang lương nhận về (get_my_permissions_v2). */
async function openSalaryAs(page: Page, who: UserKey) {
  const permsResp = page.waitForResponse(
    (r: Response) => /\/rpc\/get_my_permissions_v2\b/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await login(page, who);
  await page.goto('/finance/salary');
  const perms = (await (await permsResp).json()) as Record<string, Record<string, unknown>> & { __superadmin?: boolean };
  const has = (a: string) => !!perms?.salary?.[a] && perms.salary[a] !== false;
  const isAdmin = !!perms?.__superadmin || has('lock') || has('manage_salary') || has('distribute');
  return { isAdmin, canPay: !!perms?.__superadmin || has('distribute') };
}

test('chủ công ty: tổng quan kỳ, nguồn lương, thêm/xoá thưởng ở Thu nhập & thanh toán', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const { isAdmin } = await openSalaryAs(page, 'chunha');
  expect(isAdmin, 'chủ công ty DEMO phải vào được màn quản trị lương').toBe(true);

  const tabIncome = page.getByRole('button', { name: /Thu nhập & thanh toán/ });
  await expect(tabIncome).toBeVisible({ timeout: 45_000 });

  // Tổng quan kỳ: 5 ô số + báo cáo cơ cấu.
  await page.getByRole('button', { name: /Tổng quan kỳ/ }).click();
  for (const label of ['Nguồn lương tháng', 'Tổng lương vận hành', 'Đã trả', 'Đang chờ chi', 'Còn phải trả']) {
    await expect(page.getByRole('button', { name: new RegExp('^' + label) })).toBeVisible();
  }
  await expect(page.getByText('Tiền lương được chia thế nào?')).toBeVisible();

  // Modal Nguồn lương & khoản định kỳ.
  await page.getByRole('button', { name: /^Nguồn lương tháng/ }).click();
  const modal = page.getByRole('dialog', { name: 'Nguồn lương & khoản định kỳ' });
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Phí quản lý từ tòa')).toBeVisible();
  await expect(modal.getByText('Chủ công ty cấp thêm')).toBeVisible();
  await modal.getByRole('button', { name: 'Khoản định kỳ', exact: true }).click();
  await expect(modal.getByText(/Phụ cấp & lương bổ sung/).first()).toBeVisible();
  await modal.getByRole('button', { name: 'Đóng' }).click();
  await expect(modal).toBeHidden();

  // Thu nhập & thanh toán: chọn đúng người fixture.
  await tabIncome.click();
  await expect(page.getByText(/^Người nhận · /)).toBeVisible();
  // Dòng cấu hình fixture mang chức danh "(fixture E2E)" — chọn đúng người đó, không
  // phụ thuộc cách app rút gọn tên hiển thị ("DEMO Quản Lý" hiện thành "Quản lý").
  await page.getByRole('button').filter({ hasText: '(fixture E2E)' }).first().click();
  const cashEl = page.getByText('Tiền thực chuyển', { exact: true }).locator('xpath=following-sibling::span[1]');
  await expect(cashEl).toBeVisible();
  const cashBefore = money(await cashEl.innerText());

  // Thêm một khoản thưởng fixture → khoản hiện ra và tiền thực chuyển tăng đúng.
  await page.getByRole('button', { name: '+ Thưởng / trừ' }).click();
  await page.getByPlaceholder('VD: Bonus QL, fighting, hỗ trợ xăng…').fill(LABEL);
  await page.getByPlaceholder('0', { exact: true }).fill('123000');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  const line = page.getByRole('button', { name: new RegExp(LABEL) });
  await expect(line).toBeVisible({ timeout: 30_000 });
  await expect(cashEl).toHaveText(new RegExp((cashBefore + 123000).toLocaleString('vi-VN').replace(/\./g, '\\.')));

  // Truy ngược căn cứ → xoá khoản qua UI → tiền về như cũ.
  await line.click();
  const drawer = page.getByRole('dialog', { name: LABEL });
  await expect(drawer.getByText('Truy ngược căn cứ')).toBeVisible();
  await drawer.getByRole('button', { name: 'Xoá khoản' }).click();
  await expect(line).toBeHidden({ timeout: 30_000 });
  await expect(cashEl).toHaveText(new RegExp(cashBefore.toLocaleString('vi-VN').replace(/\./g, '\\.')));

  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});

test('kế toán: màn lương hiện đúng theo quyền, không lỗi console', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const { isAdmin, canPay } = await openSalaryAs(page, 'ketoan');
  console.log('[salary-admin-desktop] kế toán DEMO — admin:', isAdmin, '· trả lương:', canPay);
  if (isAdmin) {
    const tabIncome = page.getByRole('button', { name: /Thu nhập & thanh toán/ });
    await expect(tabIncome).toBeVisible({ timeout: 45_000 });
    await tabIncome.click();
    await expect(page.getByText('Tiền thực chuyển', { exact: true })).toBeVisible();
    const payBtn = page.getByRole('button', { name: /Lập yêu cầu thanh toán|Không có quyền trả lương|Không còn tiền phải chuyển|Đang có phiếu chờ duyệt/ });
    await expect(payBtn).toBeVisible();
    if (!canPay) await expect(payBtn).toHaveText('Không có quyền trả lương');
  } else {
    await expect(page.getByText(/chưa được cấu hình hưởng lương/)).toBeVisible({ timeout: 45_000 });
  }
  expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
});
