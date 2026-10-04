import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Actual app + authenticated TEST reads. Only Google and the two email-bill
// RPCs are fixtures. Never use auth.ts: its production-account guard is unchanged.
const TEST_HOST = 'hzulujxgonszuleqticb.supabase.co';
const TEST_ORIGIN = `https://${TEST_HOST}`;
const MAILBOX = 'bill-fixture@example.test';
const MESSAGE_ID = 'gmail_e2e_message_1';
const RECEIPT_ID = 'GRAB-E2E-12345';
const FAKE_TOKEN = 'gmail-e2e-only-not-a-real-token';
const BILL_DATE = '2026-10-04';
const BILL_NAME = 'Grab Gmail E2E reviewed';
const READ_RPCS = new Set([
  'list_my_copilot_organizations_v1', 'get_my_permissions_v2', 'get_my_permissions',
  'my_org_ids', 'ie_form_buildings', 'ie_form_rooms', 'get_voucher_slot_warning_v1',
  'get_income_expense_layer_stats', 'get_my_cashbook_access_v2', 'list_cashbook_visibility_v2',
  'is_super_admin', 'is_admin', 'get_my_profile', 'get_my_organization',
  'list_my_cashbook_access_v2', 'get_my_cashbook_roles_v2', 'read_cashbook_access_v2',
  'get_my_staff_assignments', 'get_feature_routes_v1', 'get_canonical_routes_v1',
  'business_performance_organizations_v1', 'is_company_owner_self_v1',
  'get_finance_v2_client_flags_v1', 'read_income_expense_details_v1',
  'can_flex_cancel_v1',
]);

function requireTarget() {
  const base = new URL(process.env.FLEET_BASE_URL ?? 'https://invalid.test');
  if (process.env.GMAIL_E2E_LOCAL_TEST !== '1' || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/') {
    throw new Error('Gmail E2E requires an explicitly enabled 127.0.0.1 TEST app.');
  }
  if (process.env.GMAIL_E2E_TEST_HOST !== TEST_HOST) throw new Error('Gmail E2E TEST host mismatch.');
  if (!process.env.GMAIL_E2E_TEST_PASSWORD || !process.env.GMAIL_E2E_TEST_KEY) throw new Error('Missing TEST-only login environment.');
  return base.origin;
}

type CapturedWrite = { p_source: Record<string, unknown>; p_voucher: Record<string, unknown>; p_items: Array<Record<string, unknown>>; p_organization_id: string };

async function guardedApp(page: Page, context: BrowserContext) {
  const appOrigin = requireTarget();
  const errors: string[] = [];
  const blocked: string[] = [];
  const reads = new Set<string>();
  const responses: string[] = [];
  const writes: CapturedWrite[] = [];
  let imported = false;
  const sanitize = (text: string) => text.replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted-token]').replaceAll(process.env.GMAIL_E2E_TEST_PASSWORD!, '[redacted]');
  page.on('console', message => { if (message.type() === 'error') errors.push(sanitize(message.text())); });
  page.on('pageerror', error => errors.push(sanitize(error.message)));
  page.on('response', response => { const url = new URL(response.url()); if (url.hostname === TEST_HOST) responses.push(`${response.status()} ${url.pathname}`); });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === appOrigin) return route.continue();
    if (url.href === 'https://accounts.google.com/gsi/client') return route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{initTokenClient(c){return {requestAccessToken(){queueMicrotask(()=>c.callback({access_token:${JSON.stringify(FAKE_TOKEN)},expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'}));}}},hasGrantedAllScopes(){return true;}}}};` });
    if (url.hostname === 'gmail.googleapis.com') {
      expect(request.headers().authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      if (url.pathname.endsWith('/profile')) return route.fulfill({ json: { emailAddress: MAILBOX } });
      if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: [{ id: MESSAGE_ID }] } });
      if (url.pathname.endsWith(`/messages/${MESSAGE_ID}`)) return route.fulfill({ json: { id: MESSAGE_ID, payload: {
        mimeType: 'text/plain', headers: [{ name: 'From', value: 'Grab <receipts@grab.com>' }, { name: 'Subject', value: 'Grab E2E receipt' }],
        body: { data: Buffer.from(`Receipt ID: ${RECEIPT_ID}\nPayment completed\nDate: ${BILL_DATE}\nSubtotal: 75.000đ\nTotal: 85.000đ`).toString('base64url') },
      } } });
      blocked.push(`unexpected Gmail ${url.pathname}`); return route.abort('blockedbyclient');
    }
    if (url.hostname.endsWith('.supabase.co')) {
      if (url.hostname !== TEST_HOST) { blocked.push(`non-TEST Supabase ${url.hostname}`); return route.abort('blockedbyclient'); }
      const rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.split('/').at(-1)! : null;
      if (rpc === 'get_imported_email_bills_v1') {
        const body = request.postDataJSON() as { p_sources: Array<{ provider: string; receipt_id: string }> };
        return route.fulfill({ json: body.p_sources.map(source => ({ provider: source.provider, receipt_id: source.receipt_id, imported })) });
      }
      if (rpc === 'create_income_expense_from_email_v1') {
        writes.push(request.postDataJSON() as CapturedWrite); imported = true;
        return route.fulfill({ json: { id: '99990000-0000-4000-8000-000000000001', created: true } });
      }
      if (rpc && READ_RPCS.has(rpc)) { reads.add(rpc); return route.continue(); }
      if (!rpc && ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { reads.add(url.pathname); return route.continue(); }
      // A deny-by-default writer boundary: no table mutation or unreviewed RPC
      // reaches TEST, and all requests to production are blocked above.
      blocked.push(`${request.method()} ${url.pathname}`); return route.abort('blockedbyclient');
    }
    // Fonts/media from the app may be read; Google OAuth/Gmail are never live.
    if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleapis.com')) {
      if (url.hostname === 'fonts.googleapis.com') return route.continue();
      blocked.push(`unexpected Google ${url.hostname}${url.pathname}`); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket(/supabase\.co/, socket => {
    if (new URL(socket.url()).hostname !== TEST_HOST) { blocked.push('non-TEST Supabase websocket'); socket.close(); return; }
    socket.connectToServer();
  });
  const login = await context.request.post(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`, {
    headers: { apikey: process.env.GMAIL_E2E_TEST_KEY! },
    data: { email: process.env.GMAIL_E2E_TEST_EMAIL, password: process.env.GMAIL_E2E_TEST_PASSWORD },
  });
  expect(login.ok(), 'TEST-only login succeeded (credentials intentionally omitted)').toBe(true);
  const session = await login.json();
  expect(typeof session.access_token).toBe('string');
  const organizationId = 'aaaa0000-0000-4000-8000-000000000001';
  const orgResponse = await context.request.post(`${TEST_ORIGIN}/rest/v1/rpc/list_my_copilot_organizations_v1`, {
    headers: { apikey: process.env.GMAIL_E2E_TEST_KEY!, Authorization: `Bearer ${session.access_token}`, 'Content-Profile': 'public' }, data: {},
  });
  expect(orgResponse.ok()).toBe(true);
  const directory = await orgResponse.json();
  expect(directory.organizations.some((org: {id?: string; organization_id?: string}) => (org.id ?? org.organization_id) === organizationId), 'Actor can select the requested organization on TEST').toBe(true);
  await context.addInitScript(({ key, value, organizationId }) => { localStorage.setItem(key, JSON.stringify(value)); localStorage.setItem('ihomecrm.selectedOrganizationId', organizationId); }, { key: 'sb-hzulujxgonszuleqticb-auth-token', value: session, organizationId });
  try {
    await page.goto('/income-expense');
    await expect(page.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lấy hóa đơn Gmail', exact: true })).toBeVisible({ timeout: 90_000 });
  } catch (error) {
    expect.soft(blocked, 'Startup blocked network paths').toEqual([]);
    expect.soft(errors, 'Startup console/page errors').toEqual([]);
    console.log('Gmail E2E startup diagnostics', { path: new URL(page.url()).pathname, testReadPaths: [...reads], responses, blockedCount: blocked.length, consoleErrorCount: errors.length });
    throw error;
  }
  return { errors, blocked, reads, writes };
}

async function selectBill(page: Page) {
  await page.getByRole('button', { name: 'Lấy hóa đơn Gmail', exact: true }).click();
  await page.getByRole('button', { name: 'Kết nối Gmail', exact: true }).click();
  await expect(page.getByText(MAILBOX, { exact: true })).toBeVisible();
  await page.getByLabel('Từ ngày', { exact: true }).fill('2026-10-01');
  await page.getByLabel('Đến ngày', { exact: true }).fill(BILL_DATE);
  await page.getByRole('button', { name: 'Tìm hóa đơn', exact: true }).click();
  await page.getByRole('button', { name: 'Xem hóa đơn', exact: true }).click();
  await expect(page.getByLabel('Số tiền (đồng)', { exact: true })).toHaveValue('85000');
  await expect(page.getByLabel('Ngày chi', { exact: true })).toHaveValue(BILL_DATE);
  await expect(page.getByLabel('Nội dung chi', { exact: true })).not.toHaveValue('');
  await page.getByLabel('Nội dung chi', { exact: true }).fill(BILL_NAME);
  await page.getByLabel('Số tiền (đồng)', { exact: true }).fill('86000');
  const category = page.getByLabel('Hạng mục chi', { exact: true });
  await expect(category.locator('option')).not.toHaveCount(1);
  const value = await category.locator('option').nth(1).getAttribute('value');
  expect(value).toBeTruthy(); await category.selectOption(value!);
  await page.getByRole('button', { name: 'Điền vào phiếu chi', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tên phiếu chi *', exact: true })).toHaveValue(BILL_NAME);
  await expect(page.getByPlaceholder('Số tiền', { exact: true })).toHaveValue(/86[.,]?000/);
  const dateField = page.locator('[data-field-name="voucher_date"]');
  await expect(dateField.getByRole('textbox', { name: 'Ngày', exact: true })).toHaveValue('04');
  await expect(dateField.getByRole('textbox', { name: 'Tháng', exact: true })).toHaveValue('10');
  await expect(dateField.getByRole('textbox', { name: 'Năm', exact: true })).toHaveValue('2026');
  return value;
}

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`Gmail bills ${viewport.width < 500 ? 'mobile' : 'desktop'}: review/cancel does not write; Save submits one reviewed voucher`, async ({ page, context }) => {
    test.setTimeout(240_000); await page.setViewportSize(viewport);
    const state = await guardedApp(page, context);
    try {
      const itemTypeId = await selectBill(page); expect(state.writes).toHaveLength(0);
      await page.getByRole('button', { name: 'Huỷ bỏ', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Lấy hóa đơn Gmail', exact: true })).toBeVisible();
      expect(state.writes).toHaveLength(0);
      await page.getByRole('button', { name: 'Điền vào phiếu chi', exact: true }).click();
      await page.locator('[data-field-name="building_id"]').getByRole('combobox').click();
      const buildingOption = page.getByRole('option', { name: '102LVT', exact: true });
      const buildingId = await buildingOption.getAttribute('data-value');
      await buildingOption.click();
      await page.locator('[data-field-name="account_id"]').getByRole('combobox').click();
      const accountMenu = page.locator('[cmdk-root]').filter({ has: page.getByPlaceholder('Tìm sổ quỹ...', { exact: true }) });
      const accountOption = accountMenu.getByRole('option').first();
      await expect(accountOption).toBeVisible();
      const accountId = await accountOption.getAttribute('data-value');
      await accountOption.click();
      expect(state.writes).toHaveLength(0);
      await page.getByTestId('ie-form-save').click();
      await expect(page.getByText('Đã nhập vào thu chi', { exact: true })).toBeVisible();
      expect(state.writes).toHaveLength(1);
      const payload = state.writes[0];
      expect(payload.p_source).toEqual({ provider: 'grab', receipt_id: RECEIPT_ID, message_id: MESSAGE_ID, mailbox: MAILBOX });
      expect(payload.p_voucher).toMatchObject({ type: 'EXPENSE', name: BILL_NAME, voucher_date: BILL_DATE, building_id: buildingId, account_id: accountId });
      expect(payload.p_voucher.building_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(payload.p_voucher.account_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(payload.p_items).toHaveLength(1);
      expect(payload.p_items[0]).toMatchObject({ income_expense_type_id: itemTypeId, quantity: 1, unit_price: 86000, start_date: '2026-10-01', end_date: '2026-10-31' });
      expect(JSON.stringify(payload)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(payload)).not.toContain('Payment completed');
      const gmailPersisted = await page.evaluate(markers => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => markers.some(marker => String(value).includes(marker))), [FAKE_TOKEN, MAILBOX, 'Payment completed']);
      expect(gmailPersisted).toBe(false);
      expect(state.reads.size).toBeGreaterThan(0);
    } finally {
      expect.soft(state.blocked, 'No production request or unreviewed write may reach the network').toEqual([]);
      expect.soft(state.errors, 'Every console/page error is captured, including network failures').toEqual([]);
    }
  });
}
