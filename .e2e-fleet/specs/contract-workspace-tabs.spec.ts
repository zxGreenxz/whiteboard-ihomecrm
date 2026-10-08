import { test, expect, type Page } from '@playwright/test';
import { credentials, type UserKey } from './auth';

const TEST_HOST = 'hzulujxgonszuleqticb.supabase.co';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const METER_CONTRACT_ID = 'e2e00000-0000-4000-8000-000000000001';
// UI-only response: no TEST/PROD row, voucher or contract is created.
const METER_FOLLOWUP = {
  items: [{ id: 'e2e00000-0000-4000-8000-000000000002', contract_id: METER_CONTRACT_ID,
    contract_number: 'E2E-CHISO', building_name: 'Toà kiểm thử UI', room_name: 'Phòng mẫu',
    effective_on: '2026-09-28', state: 'MISSING' }],
  total: 1, limit: 10, offset: 0,
};
const READ_RPC = new Set([
  'get_dashboard_summary', 'revenue_by_month', 'get_contract_stats', 'get_my_context',
  'get_my_assignments', 'is_admin', 'is_super_admin', 'get_my_permissions', 'get_my_permissions_v2',
  'list_my_copilot_organizations_v1', 'business_performance_organizations_v1', 'my_org_ids',
  'get_notification_org_config_v1', 'get_my_notification_preferences_v1',
  'list_due_contract_move_out_notices_v1', 'list_contract_exit_cases_v1',
  'list_contract_meter_followups_v1', 'get_contract_move_out_notice_v1',
  'read_contract_meter_boundary_set_v1', 'read_contract_transfer_links_v1',
  'list_contract_drafts',
]);

type CapturedReaders = { exits: number[]; drafts: number[] };

// Authenticate the real TEST role, then open the target route directly. Delivering
// the login response to the home page would also mount unrelated dashboard readers.
async function openContracts(page: Page, role: UserKey) {
  const account = credentials(role);
  const authPage = await page.context().newPage();
  type Session = { access_token: string; refresh_token: string; expires_in: number; user: { email: string } };
  let resolveSession!: (session: Session) => void;
  let rejectSession!: (error: unknown) => void;
  const authenticated = new Promise<Session>((resolve, reject) => { resolveSession = resolve; rejectSession = reject; });
  await authPage.route(`https://${TEST_HOST}/auth/v1/token*`, async route => {
    try {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(new URL(request.url()).searchParams.get('grant_type')).toBe('password');
      expect(request.postDataJSON().email).toBe(account.email);
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.ok()).toBe(true);
      const session: Session = await response.json();
      expect(session.user.email).toBe(account.email);
      resolveSession(session);
    } catch (error) { rejectSession(error); }
    finally { await route.abort('aborted'); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await authPage.goto('/login');
    await authPage.getByRole('textbox', { name: 'Tài Khoản' }).fill(account.email);
    await authPage.getByRole('textbox', { name: 'Mật khẩu' }).fill(account.pass);
    await authPage.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    const session = await Promise.race([authenticated, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TEST role authentication timed out')), 45_000);
    })]);
    await page.addInitScript(({ session, host }) => {
      localStorage.setItem(`sb-${host.split('.')[0]}-auth-token`, JSON.stringify({
        ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
      }));
    }, { session, host: TEST_HOST });
  } finally {
    clearTimeout(timer);
    await authPage.close();
  }
  await page.goto('/contracts');
}

async function readonlyDemo(page: Page, email: string) {
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  const blocked: string[] = [];
  const errors: string[] = [];
  const captured: CapturedReaders = { exits: [], drafts: [] };
  let observedTest = false;
  let meterResponsesMocked = 0;
  await page.context().addInitScript(org => localStorage.setItem('ihomecrm.selectedOrganizationId', org), DEMO_ORG);
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const block = async () => {
      blocked.push(`${method} ${url.hostname}${url.pathname}`);
      await route.abort('blockedbyclient');
    };
    if (url.hostname.endsWith('.supabase.co')) {
      if (url.hostname !== TEST_HOST) return block();
      observedTest = true;
      if (url.pathname.startsWith('/functions/')) return block();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      if (url.pathname === '/auth/v1/token' && method === 'POST') {
        const grant = url.searchParams.get('grant_type');
        const body = request.postDataJSON();
        if (grant === 'refresh_token' || (grant === 'password' && body.email === email)) return route.continue();
      }
      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
      if (rpc === 'list_contract_meter_followups_v1' && method === 'POST') {
        const body = request.postDataJSON();
        if (body?.p_organization_id !== DEMO_ORG || body?.p_limit !== 10 || body?.p_offset !== 0) return block();
        meterResponsesMocked++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METER_FOLLOWUP) });
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
  page.on('response', response => {
    if (!response.ok() || new URL(response.url()).hostname !== TEST_HOST) return;
    const rpc = new URL(response.url()).pathname.match(/^\/rest\/v1\/rpc\/(list_contract_exit_cases_v1|list_contract_drafts)$/)?.[1];
    if (!rpc) return;
    void response.json().then((data: unknown) => {
      if (rpc === 'list_contract_exit_cases_v1' && data && typeof data === 'object' && 'total' in data
          && Number.isInteger(data.total)) captured.exits.push(data.total as number);
      if (rpc === 'list_contract_drafts' && Array.isArray(data)) {
        captured.drafts.push(data.filter(row => row?.status !== 'SIGNED').length);
      }
    }).catch(() => { /* UI error assertion below remains authoritative. */ });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return { blocked, errors, captured, observedTest: () => observedTest, meterResponsesMocked: () => meterResponsesMocked };
}

async function settledTabs(page: Page, captured: CapturedReaders) {
  const tabs = page.getByRole('tablist', { name: 'Các mục hợp đồng' });
  const list = tabs.getByRole('tab', { name: 'Danh sách', exact: true });
  const exits = tabs.getByRole('tab', { name: /Chờ quyết toán/ });
  const drafts = tabs.getByRole('tab', { name: /Hợp đồng nháp/ });
  await expect(exits).toHaveAttribute('title', 'Hồ sơ chờ quyết toán');
  await expect(drafts).toHaveAttribute('title', 'Bản nháp chưa ký');
  await expect.poll(() => captured.exits.length).toBeGreaterThan(0);
  await expect.poll(() => captured.drafts.length).toBeGreaterThan(0);
  const exitCount = captured.exits.at(-1)!;
  const draftCount = captured.drafts.at(-1)!;
  await expect(exits).toContainText(`Chờ quyết toán ${exitCount}`);
  await expect(drafts).toContainText(`Hợp đồng nháp ${draftCount}`);
  return { list, exits, drafts, exitCount };
}

for (const role of ['chunha', 'quanly'] as const) {
  test(`TEST DEMO ${role}: desktop contract workspace tabs are read-only and settled`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const email = `demo.${role}@username.ihomecrm.local`;
    const audit = await readonlyDemo(page, email);
    await openContracts(page, role);
    let settled;
    try {
      settled = await settledTabs(page, audit.captured);
    } catch (error) {
      await testInfo.attach('readonly-diagnostics.json', { body: JSON.stringify({
        path: new URL(page.url()).pathname, blocked: audit.blocked, errors: audit.errors,
        observedTest: audit.observedTest(), meterResponsesMocked: audit.meterResponsesMocked(), captured: audit.captured,
      }, null, 2), contentType: 'application/json' });
      throw error;
    }
    const { list, exits, drafts, exitCount } = settled;
    await expect(list).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('region', { name: 'Hồ sơ chờ quyết toán' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hợp đồng nháp' })).toHaveCount(0);
    const meterRegion = page.getByRole('region', { name: 'Chờ bổ sung chỉ số bàn giao' });
    await expect(meterRegion).toHaveCount(0);
    await expect(exits).toContainText('Chỉ số 1');
    // Khối xám từ 02/10/2026; câu chờ chỉ còn sr-only trong role="status".
    await expect(page.getByText('Đang tải danh sách hợp đồng…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Không tải được danh sách hợp đồng', { exact: true })).toHaveCount(0);
    if (role === 'chunha') await page.screenshot({ path: testInfo.outputPath('owner-contract-list.png'), animations: 'disabled' });

    const search = page.getByRole('textbox', { name: 'Tìm hợp đồng' });
    await search.fill('__workspace_tabs_readonly__');
    await exits.click();
    await expect(exits).toHaveAttribute('data-state', 'active');
    await expect(search).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Hợp đồng nháp' })).toHaveCount(0);
    await expect(meterRegion).toBeVisible();
    await expect(meterRegion.getByRole('heading', { name: 'Chờ bổ sung / kiểm tra chỉ số (1)' })).toBeVisible();
    await expect(meterRegion.getByRole('link', { name: 'Mở mốc bàn giao' })).toHaveAttribute('href', `/contracts/${METER_CONTRACT_ID}`);
    await expect(page.getByText('Đang tải hồ sơ chờ quyết toán…')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Không tải được hồ sơ chờ quyết toán' })).toHaveCount(0);
    if (exitCount) await expect(page.getByRole('region', { name: 'Hồ sơ chờ quyết toán' })).toBeVisible();
    else await expect(page.getByText('Không có hợp đồng chờ quyết toán.', { exact: true })).toBeVisible();
    if (role === 'chunha') await page.screenshot({ path: testInfo.outputPath('owner-contract-exits.png'), animations: 'disabled' });

    await drafts.click();
    await expect(drafts).toHaveAttribute('data-state', 'active');
    const workspace = page.getByRole('region', { name: 'Hợp đồng nháp', exact: true });
    await expect(workspace).toBeVisible();
    await expect(workspace.getByText('Đang tải bản nháp…')).toHaveCount(0);
    await expect(workspace.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hồ sơ chờ quyết toán' })).toHaveCount(0);
    await expect(meterRegion).toHaveCount(0);
    if (role === 'chunha') {
      await expect(workspace.getByRole('button', { name: 'Soạn nháp', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('owner-contract-drafts.png'), animations: 'disabled' });
    }

    await list.click();
    await expect(list).toHaveAttribute('data-state', 'active');
    await expect(search).toBeEnabled();
    await expect(search).toHaveValue('__workspace_tabs_readonly__');
    await expect(workspace).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hồ sơ chờ quyết toán' })).toHaveCount(0);
    await expect(meterRegion).toHaveCount(0);
    if (role === 'chunha') {
      await page.setViewportSize({ width: 800, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    expect(audit.observedTest()).toBe(true);
    expect(audit.meterResponsesMocked()).toBeGreaterThan(0);
    expect(audit.blocked).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}
