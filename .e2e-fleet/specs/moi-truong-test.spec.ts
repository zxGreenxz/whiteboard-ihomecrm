import { test, expect, type Page } from '@playwright/test';
import { laWebTest, login, trackConsoleErrors } from './auth';

/**
 * MÔI TRƯỜNG TEST RIÊNG — project Supabase `ihomecrm-test`, web Preview nhánh
 * `test-env`, đồng bộ từ production bằng `npm run test-env:sync`
 * (scripts/test-env/README.md). Thay cho spec org TEST cũ (cccc…0001, gỡ 23/09/2026).
 * Chứng minh ba điều:
 *
 *   1. Tài khoản THẬT đăng nhập được bằng MẬT KHẨU TEST, đúng vai production.
 *   2. Mọi request dữ liệu đi về project TEST — không một request nào tới production.
 *   3. Dữ liệu là bản sao công ty thật (toà 102LVT có thật), các màn chính sạch lỗi.
 *
 * Chạy (mật khẩu là dòng `TEST_PASS` trong CLAUDE.local.md, KHÔNG commit):
 *   cd .e2e-fleet && FLEET_BASE_URL=https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app \
 *     VERCEL_AUTOMATION_BYPASS_SECRET=… FLEET_PASS_TEST_CHU=… FLEET_PASS_TEST_QUANLY=… \
 *     npx playwright test specs/moi-truong-test.spec.ts
 */

const HOST_TEST = 'hzulujxgonszuleqticb.supabase.co';
const HOST_PRODUCTION = 'tryymsxyyckgbrmmvozx.supabase.co';

test.skip(!laWebTest(), 'chỉ chạy khi FLEET_BASE_URL là web TEST (nhánh test-env)');

/** Ghi lại host của mọi request tới Supabase trong suốt bài. */
function theoDoiHostSupabase(page: Page): Set<string> {
  const hosts = new Set<string>();
  page.on('request', (r) => {
    const host = new URL(r.url()).host;
    if (host.endsWith('.supabase.co')) hosts.add(host);
  });
  return hosts;
}

test('web TEST — chủ công ty đăng nhập, nhãn TEST hiện, dữ liệu chỉ đi về project TEST', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const hosts = theoDoiHostSupabase(page);
  await login(page, 'testchu');
  await expect(page.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
  await expect(page).toHaveTitle(/^\[TEST\] /);
  await page.goto('/buildings');
  // 102LVT là toà có thật của công ty; thấy nó nghĩa là bản sao mang đúng dữ liệu.
  await expect(page.getByText('102LVT').first()).toBeVisible();
  expect(hosts.has(HOST_PRODUCTION), `có request tới production: ${[...hosts]}`).toBe(false);
  expect([...hosts]).toContain(HOST_TEST);
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('web TEST — thu chi mở được form thêm phiếu', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await page.goto('/income-expense');
  await expect(page.getByRole('heading', { name: 'Thu chi' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('web TEST — sổ quỹ và khách hàng load được', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testchu');
  await page.goto('/finance/cashbooks');
  await expect(page.getByRole('heading', { name: /Sổ quỹ/i })).toBeVisible();
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: /Khách hàng/i })).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});

test('web TEST — quản lý toà vào được bằng mật khẩu TEST', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'testquanly');
  await expect(page).not.toHaveURL(/\/login\b/);
  await expect(page.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
