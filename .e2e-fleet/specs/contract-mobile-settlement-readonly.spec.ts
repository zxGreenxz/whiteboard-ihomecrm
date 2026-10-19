import { test, expect } from '@playwright/test';
import { login } from './auth';
import { isContractListRead, listReadRows, readRpcAllowlist, uiPreferenceFakeBody } from '../support/read-rpc-allowlist';

const TEST_HOST = 'hzulujxgonszuleqticb.supabase.co';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
// Readers needed by login landing, shell, list and contract detail (shared module).
// No assertions against dashboard money; no writer RPC is forwarded.
const READ_RPC = readRpcAllowlist('dashboard', 'contracts');

test('TEST DEMO: returned contract mobile status loads from existing readers without writes', async ({ page, context }, testInfo) => {
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addInitScript(org => localStorage.setItem('ihomecrm.selectedOrganizationId', org), DEMO_ORG);
  const blocked: string[] = [];
  const errors: string[] = [];
  let observedTest = false;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const block = async () => { blocked.push(`${method} ${url.hostname}${url.pathname}`); await route.abort('blockedbyclient'); };
    if (url.hostname.endsWith('.supabase.co')) {
      if (url.hostname !== TEST_HOST) return block();
      observedTest = true;
      if (url.pathname.startsWith('/functions/')) return block();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      if (url.pathname === '/auth/v1/token' && method === 'POST') {
        const grant = url.searchParams.get('grant_type');
        const body = request.postDataJSON();
        if (grant === 'refresh_token' || (grant === 'password' && body.email === 'demo.chunha@username.ihomecrm.local')) {
          return route.continue();
        }
      }
      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
      if (rpc === 'set_my_ui_preference' && method === 'POST') {
        // App ghi nhớ công ty đã chọn lên hồ sơ; trả lời giả để lượt chỉ-đọc không ghi vào TEST.
        const fake = uiPreferenceFakeBody(request, DEMO_ORG);
        return fake ? route.fulfill({ status: 200, contentType: 'application/json', body: fake }) : block();
      }
      if (rpc && READ_RPC.has(rpc) && method === 'POST') {
        const body = request.postDataJSON();
        if (body?.p_organization_id && body.p_organization_id !== DEMO_ORG) return block();
        if (body?.p_org && body.p_org !== DEMO_ORG) return block();
        return route.continue();
      }
      return block();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return block();
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page, 'chunha');
  await page.goto('/contracts');
  const returned = page.waitForResponse(response => new URL(response.url()).hostname === TEST_HOST
    && isContractListRead(response.request(), { stat: 'TERMINATED' }));
  await page.getByRole('button', { name: /Đã thanh lý/ }).click();
  const result = await returned;
  expect(result.ok()).toBe(true);
  const records = await listReadRows(result);
  test.skip(records.length === 0, 'TEST DEMO không có hợp đồng TERMINATED có sẵn; không seed giao dịch.');
  await expect(page.locator('.rowlist .ctr').first()).toBeVisible();
  await page.locator('.rowlist .ctr').first().click();
  await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]+$/);
  const status = page.getByRole('region', { name: 'Trạng thái sau trả phòng', exact: true });
  await expect(status).toBeVisible();
  await expect(status.getByRole('status')).toHaveCount(0, { timeout: 30_000 });
  await expect(status.getByRole('alert')).toHaveCount(0);
  await expect(status.getByText('Khách đã trả phòng', { exact: true })).toBeVisible();
  await expect(status).toContainText(/Chưa chốt quyết toán|Không còn khoản nào treo|Nợ hoá đơn|Chưa hoàn khách|Thiếu cọc|Phiếu .* chờ xử lý/);
  if (await status.getByText('Chưa chốt quyết toán', { exact: true }).count()) {
    await expect(status.getByText('Không còn khoản nào treo', { exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(() => localStorage.getItem('ihomecrm.selectedOrganizationId'))).toBe(DEMO_ORG);
  await status.screenshot({ path: testInfo.outputPath('mobile-return-status-loaded.png') });
  await page.screenshot({ path: testInfo.outputPath('mobile-return-detail-loaded.png') });
  expect(observedTest).toBe(true);
  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
});
