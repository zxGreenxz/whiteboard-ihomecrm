import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { USERS } from './auth';

// Màn /contracts đọc danh sách qua MỘT hàm dùng chung public.contract_list_v1 (migration
// 20261017115636). CHỈ ĐỌC trên TEST: mọi ghi bị chặn, không tạo/sửa dòng nào.
// Chạy từ .e2e-fleet với FLEET_BASE_URL=http://127.0.0.1:5197 (dev server của worktree trỏ TEST),
// TEST_SUPABASE_PUBLISHABLE_KEY, FLEET_PASS_TEST_CHU và FLEET_PASS_TEST_QUANLY qua env.
// Đăng nhập thẳng vào Auth TEST (không qua app), phiên gắn vào localStorage của app local.
const APP_ORIGIN = 'http://127.0.0.1:5197';
const TEST_REF = 'hzulujxgonszuleqticb';
const TEST_HOST = `${TEST_REF}.supabase.co`;
const TEST_ORIGIN = `https://${TEST_HOST}`;
const ORGANIZATION_ID = 'aaaa0000-0000-4000-8000-000000000001';
// Đọc mà màn /contracts gọi khi mở thẳng route (không qua trang chủ).
const READ_RPC = new Set([
  'get_contract_stats', 'get_my_context', 'get_my_assignments', 'is_admin', 'is_super_admin',
  'get_my_permissions', 'get_my_permissions_v2', 'get_authorization_context_v1', 'my_org_ids',
  'list_my_copilot_organizations_v1', 'business_performance_organizations_v1',
  'get_notification_org_config_v1', 'get_my_notification_preferences_v1',
  'list_due_contract_move_out_notices_v1', 'list_contract_exit_cases_v1',
  'list_contract_meter_followups_v1', 'list_contract_drafts', 'list_room_reservations_v1',
  'read_contract_transfer_links_v1', 'contract_list_v1',
]);
const LABEL: Record<string, string> = {
  ACTIVE: 'Còn hạn', EXPIRING: 'Sắp hết hạn', EXPIRED: 'Quá hạn', MOVING_OUT: 'Sắp chuyển đi',
  TERMINATED: 'Đã thanh lý', TRANSFERRED: 'Đã nhượng', DRAFT: 'Nháp',
};
type ListRow = { id: string; display_status: string; display_label: string; contract_number: string | null };
type ListPage = { total: number; today: string; rows: ListRow[] };
type Who = 'testchu' | 'testquanly';
const PASS_ENV: Record<Who, string> = { testchu: 'FLEET_PASS_TEST_CHU', testquanly: 'FLEET_PASS_TEST_QUANLY' };

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu ${name}`);
  return value;
}

async function openContracts(page: Page, request: APIRequestContext, who: Who, session: Record<string, string>) {
  expect(requiredEnvironment('FLEET_BASE_URL'), 'chỉ chạy tại local app trỏ TEST').toBe(APP_ORIGIN);
  const publicKey = requiredEnvironment('TEST_SUPABASE_PUBLISHABLE_KEY');
  const auth = await request.post(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`, {
    headers: { apikey: publicKey },
    data: { email: USERS[who], password: requiredEnvironment(PASS_ENV[who]) },
    maxRedirects: 0,
  });
  expect(auth.status(), `đăng nhập ${who} trên TEST`).toBe(200);
  const saved = await auth.json();
  expect(saved.user?.email).toBe(USERS[who]);
  const blocked: string[] = [];
  const errors: string[] = [];
  const calls: Record<string, unknown>[] = [];
  await page.context().route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const block = async () => { blocked.push(`${method} ${url.hostname}${url.pathname}`); await route.abort('blockedbyclient'); };
    if (url.hostname.endsWith('.supabase.co')) {
      if (url.origin !== TEST_ORIGIN || url.pathname.startsWith('/functions/')) return block();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        // Danh sách không còn đọc bảng contracts kèm khách trực tiếp.
        if (url.pathname === '/rest/v1/contracts' && (url.searchParams.get('select') ?? '').includes('contract_customers')) return block();
        return route.continue();
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') return route.continue();
      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
      if (rpc && READ_RPC.has(rpc) && method === 'POST') {
        if (rpc === 'contract_list_v1') calls.push(req.postDataJSON() ?? {});
        return route.continue();
      }
      return block();
    }
    if (req.isNavigationRequest() && url.origin !== APP_ORIGIN) return block();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return block();
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ savedSession, storageKey, orgId, origin, storage }) => {
    if (window.location.origin !== origin) return;
    localStorage.setItem(storageKey, JSON.stringify(savedSession));
    localStorage.setItem('ihomecrm.selectedOrganizationId', orgId);
    for (const [k, v] of Object.entries(storage)) sessionStorage.setItem(k, v);
  }, { savedSession: saved, storageKey: `sb-${TEST_REF}-auth-token`, orgId: ORGANIZATION_ID, origin: APP_ORIGIN, storage: session });
  return { blocked, errors, calls };
}

const listResponse = (page: Page, match: (body: Record<string, unknown>) => boolean) =>
  page.waitForResponse((response: Response) => {
    const url = new URL(response.url());
    return url.origin === TEST_ORIGIN && url.pathname === '/rest/v1/rpc/contract_list_v1'
      && match(response.request().postDataJSON() ?? {});
  }, { timeout: 60_000 });

async function readPage(response: Response): Promise<ListPage> {
  expect(response.ok()).toBe(true);
  const data = await response.json() as ListPage;
  expect(Number.isSafeInteger(data.total)).toBe(true);
  expect(Array.isArray(data.rows)).toBe(true);
  for (const row of data.rows) expect(row.display_label).toBe(LABEL[row.display_status]);
  return data;
}

test('TEST desktop (chủ công ty): danh sách, nhãn, ô thống kê và tìm đi qua contract_list_v1', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const audit = await openContracts(page, request, 'testchu', {
    'flt:contracts:stat': JSON.stringify('ALL'), 'flt:contracts:lifecycle': JSON.stringify('ALL'),
    'flt:contracts:buildingIds': '[]', 'flt:contracts:search': JSON.stringify(''),
  });
  const first = listResponse(page, body => body.p_stat === 'ALL' && body.p_lifecycle === 'ALL');
  await page.goto(`${APP_ORIGIN}/contracts`);
  const all = await readPage(await first);
  expect(all.total).toBeGreaterThan(20);
  const table = page.getByRole('table');
  await expect(page.getByText(`/ ${all.total} hợp đồng`, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(table.locator('tbody tr')).toHaveCount(20);
  // Nhãn trên bảng = nhãn SQL của đúng các hàng trang này (bảng xếp lại theo toà/phòng nên so tập).
  const badges = await table.locator('tbody tr td:nth-child(2) span').allInnerTexts();
  expect(badges.sort()).toEqual(all.rows.map(r => r.display_label).sort());

  for (const [card, stat] of [['Quá hạn', 'EXPIRED'], ['Sắp hết hạn', 'EXPIRING'], ['Đã thanh lý', 'TERMINATED']] as const) {
    const next = listResponse(page, body => body.p_stat === stat);
    await page.getByRole('button', { name: new RegExp(card) }).first().click();
    const filtered = await readPage(await next);
    expect(filtered.rows.every(r => r.display_status === stat)).toBe(true);
    if (filtered.total === 0) await expect(page.getByText('Không tìm thấy hợp đồng nào')).toBeVisible();
    else {
      await expect(page.getByText(`/ ${filtered.total} hợp đồng`, { exact: true })).toBeVisible();
      const shown = await table.locator('tbody tr td:nth-child(2) span').allInnerTexts();
      expect(new Set(shown)).toEqual(new Set([LABEL[stat]]));
    }
  }
  expect(audit.calls.at(-1)).toMatchObject({ p_stat: 'TERMINATED', p_lifecycle: 'TERMINATED', p_offset: 0, p_limit: 20 });

  // Trang 2: một lời gọi với p_offset 20, tổng giữ nguyên.
  const page2 = listResponse(page, body => body.p_offset === 20);
  await page.getByRole('button', { name: 'Trang sau' }).click();
  const second = await readPage(await page2);
  await expect(page.getByText(/^Trang 2 \//)).toBeVisible();
  expect(second.rows.length).toBeGreaterThan(0);

  // Tìm theo số HĐ của một hàng: một lời gọi mang p_search, kết quả chứa đúng hàng đó.
  const sample = all.rows.find(r => r.contract_number);
  expect(sample?.contract_number).toBeTruthy();
  await page.getByRole('button', { name: /Tất cả/ }).first().click();
  const searched = listResponse(page, body => body.p_search === sample!.contract_number);
  await page.getByRole('textbox', { name: 'Tìm hợp đồng' }).fill(sample!.contract_number!);
  const found = await readPage(await searched);
  expect(found.rows.map(r => r.id)).toContain(sample!.id);
  await expect(page.getByText(`/ ${found.total} hợp đồng`, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('contracts-desktop.png') });
  // Ghi tuỳ chọn giao diện của tài khoản thật bị CHẶN có chủ ý (không ghi TEST); ngoài nó không đường nào bị chặn.
  expect(audit.blocked.filter(path => !path.endsWith('/rest/v1/rpc/set_my_ui_preference'))).toEqual([]);
  // Dòng mạng do chính phép chặn ghi ở trên sinh ra không phải lỗi của app.
  expect(audit.errors.filter(text => !/net::ERR_BLOCKED_BY_CLIENT/.test(text))).toEqual([]);
});

test('TEST mobile (quản lý theo toà): thẻ hợp đồng mang nhãn SQL, chip lọc và "Tải thêm" theo tổng', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await openContracts(page, request, 'testquanly', {
    'flt:contracts-mb:stat': JSON.stringify('ALL'), 'flt:contracts-mb:buildingId': JSON.stringify(''),
    'flt:contracts-mb:roomName': JSON.stringify('all'), 'flt:contracts-mb:search': JSON.stringify(''),
  });
  const first = listResponse(page, body => body.p_stat === 'ALL');
  await page.goto(`${APP_ORIGIN}/contracts`);
  const data = await readPage(await first);
  expect(audit.calls[0]).toMatchObject({ p_lifecycle: 'ACTIVE', p_stat: 'ALL', p_limit: 15, p_offset: 0 });
  const cards = page.locator('.rowlist .ctr');
  await expect(cards).toHaveCount(Math.min(15, data.rows.length), { timeout: 60_000 });
  const pills = await cards.locator('.ctr-badges .pill').allInnerTexts();
  for (const label of data.rows.map(r => r.display_label)) expect(pills).toContain(label);
  if (data.total > data.rows.length) {
    await expect(page.getByRole('button', { name: `Tải thêm (${data.total - data.rows.length})` })).toBeVisible();
    const more = listResponse(page, body => body.p_limit === 45);
    await page.getByRole('button', { name: /Tải thêm/ }).click();
    const bigger = await readPage(await more);
    await expect(cards).toHaveCount(Math.min(45, bigger.rows.length));
  }
  const expired = listResponse(page, body => body.p_stat === 'EXPIRED');
  await page.locator('.lfilter .lchip', { hasText: 'Quá hạn' }).click();
  const late = await readPage(await expired);
  expect(late.rows.every(r => r.display_status === 'EXPIRED')).toBe(true);
  if (late.total > 0) await expect(cards.first().locator('.ctr-badges .pill').last()).toHaveText('Quá hạn');
  await page.screenshot({ path: testInfo.outputPath('contracts-mobile.png') });
  // Ghi tuỳ chọn giao diện của tài khoản thật bị CHẶN có chủ ý (không ghi TEST); ngoài nó không đường nào bị chặn.
  expect(audit.blocked.filter(path => !path.endsWith('/rest/v1/rpc/set_my_ui_preference'))).toEqual([]);
  // Dòng mạng do chính phép chặn ghi ở trên sinh ra không phải lỗi của app.
  expect(audit.errors.filter(text => !/net::ERR_BLOCKED_BY_CLIENT/.test(text))).toEqual([]);
});
