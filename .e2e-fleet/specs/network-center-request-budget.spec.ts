import { expect, test, type Page } from '@playwright/test';

import { credentials, trackConsoleErrors, type UserKey } from './auth';

/**
 * Ngân sách request của Trung tâm mạng — ĐO chứ không đoán.
 *
 * Án lệ production 04/08/2026: tài khoản chủ nhìn thấy 36 toà thuộc 3 tổ chức;
 * 17 toà của tổ chức TEST chưa có dòng `network_site_settings` nên
 * `network_center_get_building_v1` trả HTTP 200 với `settings` toàn null. Client
 * coi trạng thái RỖNG đó là lỗi hợp đồng, `listFleet()` ném lỗi cho cả hạm đội
 * và React Query nhân request lên: đo được 4 × list_fleet + 144 × get_building
 * trong 25 giây, mọi response 200, không một console error nào.
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_MAIN_EMAIL=… FLEET_MAIN_PASS=… FLEET_PASS_CHUNHA=… \
 *     npx playwright test specs/network-center-request-budget.spec.ts
 */

const RPC_PATTERN = /\/rest\/v1\/rpc\/(network_center_[a-z0-9_]+)/;
const SETTLE_MS = Number(process.env.FLEET_NC_SETTLE_MS || 25_000);

/** Toà của tổ chức TEST — CHƯA có dòng network_site_settings nào (chỉ đọc). */
const UNPROVISIONED_BUILDING_ID = 'c32d4465-6a78-4e1a-bf10-6905cca9ec3c';
/** Toà DEMO có MikroTik thật đang chạy. */
const DEMO_LIVE_BUILDING_ID = '72dbe01c-2e14-4fac-8b13-d522213a1bf9';

type Counts = Record<string, number>;

function countRpcCalls(page: Page): Counts {
  const counts: Counts = {};
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const match = request.url().match(RPC_PATTERN);
    if (!match) return;
    counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  });
  return counts;
}

async function loginWith(page: Page, email: string, pass: string) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(pass);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
}

function mainCredentials(): { email: string; pass: string } {
  const email = process.env.FLEET_MAIN_EMAIL;
  const pass = process.env.FLEET_MAIN_PASS;
  if (!email || !pass) {
    throw new Error(
      'Thiếu FLEET_MAIN_EMAIL / FLEET_MAIN_PASS cho tài khoản tổ chức thật. '
      + 'Giá trị nằm ở CLAUDE.local.md — KHÔNG commit vào repo.',
    );
  }
  return { email, pass };
}

function demoCredentials(who: UserKey = 'chunha') {
  return credentials(who);
}

test.describe('Network Center request budget', () => {
  test('tổ chức thật: trạng thái rỗng bình tĩnh, request có trần', async ({ page }) => {
    const { email, pass } = mainCredentials();
    const consoleErrors = trackConsoleErrors(page);
    await loginWith(page, email, pass);
    const counts = countRpcCalls(page);

    await page.goto('/network-center');
    await page.waitForTimeout(SETTLE_MS);
    const summary = JSON.stringify(counts);
    console.log(`[real-org] rpc counts ${summary}`);
    console.log(`[real-org] console errors ${JSON.stringify(consoleErrors)}`);

    await expect(
      page.getByRole('heading', { name: 'Không tải được toà nhà' }),
      `vẫn thấy thẻ lỗi; rpc=${summary}`,
    ).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Bảng điều hành mạng' })).toBeVisible();
    const fleetRows = await page.locator('.nc-building-link').count();
    console.log(`[real-org] fleet rows ${fleetRows}`);
    expect(fleetRows).toBeGreaterThan(0);

    // Toà CHƯA provisioning: trạng thái rỗng bình tĩnh, không phải thẻ đỏ.
    await page.goto(`/network-center/buildings/${UNPROVISIONED_BUILDING_ID}?tab=settings`);
    await expect(page.getByRole('heading', { name: 'Không tải được toà nhà' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Chưa cấu hình Network Center' })).toBeVisible();
    await expect(page.getByLabel('Chu kỳ kiểm tra (giây)')).toHaveCount(0);
    console.log('[real-org] toà chưa provisioning: hiện "Chưa cấu hình Network Center"');
    await page.waitForTimeout(3_000);

    const afterSummary = JSON.stringify(counts);
    console.log(`[real-org] rpc counts (kể cả trang toà nhà) ${afterSummary}`);
    expect(counts.network_center_list_fleet_v1 ?? 0, afterSummary).toBeLessThanOrEqual(4);
    expect(counts.network_center_get_building_v1 ?? 0, afterSummary).toBeLessThanOrEqual(60);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('tổ chức DEMO: telemetry thật, request có trần', async ({ page }) => {
    const { email, pass } = demoCredentials();
    const consoleErrors = trackConsoleErrors(page);
    await loginWith(page, email, pass);
    const counts = countRpcCalls(page);

    await page.goto('/network-center');
    await page.waitForTimeout(SETTLE_MS);
    console.log(`[demo-org] rpc counts ${JSON.stringify(counts)}`);
    console.log(`[demo-org] console errors ${JSON.stringify(consoleErrors)}`);

    await expect(page.getByRole('heading', { name: 'Không tải được toà nhà' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Bảng điều hành mạng' })).toBeVisible();

    await page.goto(`/network-center/buildings/${DEMO_LIVE_BUILDING_ID}`);
    await expect(page.getByRole('heading', { name: 'Không tải được toà nhà' })).toBeHidden();
    const subtitle = await page.locator('.nc-building-subtitle').first().textContent();
    console.log(`[demo-org] router: ${subtitle?.replace(/\s+/g, ' ').trim()}`);

    const tabList = page.getByRole('tablist', { name: 'Khu chức năng toà nhà' });
    await tabList.getByRole('tab', { name: 'Cổng giao tiếp', exact: true }).click();
    const interfaceRows = await page.locator('tbody tr').count();
    console.log(`[demo-org] interface rows ${interfaceRows}`);
    expect(interfaceRows).toBeGreaterThan(0);

    await tabList.getByRole('tab', { name: 'Thay đổi', exact: true }).click();
    const changeText = (await page.locator('.nc-panel').last().textContent()) ?? '';
    console.log(`[demo-org] changes: ${changeText.replace(/\s+/g, ' ').trim().slice(0, 220)}`);

    await tabList.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chưa cấu hình Network Center' })).toBeHidden();
    await expect(page.getByLabel('Chu kỳ kiểm tra (giây)')).toBeVisible();
    await page.waitForTimeout(3_000);

    const summary = JSON.stringify(counts);
    console.log(`[demo-org] rpc counts (kể cả trang toà nhà) ${summary}`);
    expect(counts.network_center_list_fleet_v1 ?? 0, summary).toBeLessThanOrEqual(4);
    expect(counts.network_center_get_building_v1 ?? 0, summary).toBeLessThanOrEqual(12);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
