import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const accountId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const transactionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ignoredId = '99999999-9999-4999-8999-999999999999';
const invoiceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const invoiceNumber = 'ACB-E2E-01';
const v5Receipt = {
  collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: invoiceId,
  gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0,
  rounding_amount: 0, credit_lot_id: null,
  tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }],
  invoice: { id: invoiceId },
};

type BankReviewRequest = {
  p_transaction_id: string;
  p_invoice_number: string;
  p_ignore: boolean;
  p_expected_invoice_id: string | null;
  p_expected_amount: number | null;
};

function target() {
  const app = new URL(process.env.FLEET_BASE_URL ?? 'https://invalid.test');
  const testHost = process.env.BANK_EMAIL_E2E_TEST_HOST;
  if (process.env.BANK_EMAIL_E2E_LOCAL_TEST !== '1' || app.protocol !== 'http:' || app.hostname !== '127.0.0.1' || !app.port || app.pathname !== '/') {
    throw new Error('Bank email E2E requires an explicitly enabled local 127.0.0.1 app.');
  }
  if (!testHost || !/^[a-z0-9]+\.supabase\.co$/.test(testHost) || !process.env.BANK_EMAIL_E2E_TEST_EMAIL || !process.env.BANK_EMAIL_E2E_TEST_PASSWORD || !process.env.BANK_EMAIL_E2E_TEST_KEY) {
    throw new Error('Bank email E2E requires TEST-only Supabase host and login environment.');
  }
  return { appOrigin: app.origin, testOrigin: `https://${testHost}`, testHost };
}

async function authenticatedFixture(page: Page, context: BrowserContext, options: { loseFirstPostResponse?: boolean } = {}) {
  const { appOrigin, testOrigin, testHost } = target();
  const key = process.env.BANK_EMAIL_E2E_TEST_KEY!;
  const errors: string[] = [];
  const expectedDeniedInboxConsole: string[] = [];
  const blocked: string[] = [];
  const reviews: BankReviewRequest[] = [];
  const sourceReads: string[] = [];
  const oauthStarts: Array<{ connectionId: string; bearer: boolean }> = [];
  let posted = false;
  let lostPostResponse = false;
  let ignored = false;
  let enabled = false;
  let connected = true;
  let denyBusinessInbox = false;
  let organizationId = '';
  const connection = () => ({
    id: connectionId, organizationId, bankAccount: '1234567890', accountId,
    enabled, autoEnabledAt: enabled ? '2026-10-05T02:00:00Z' : null,
    status: connected ? 'CONNECTED' : 'DISCONNECTED', email: 'fixture@example.test', lastSyncedAt: '2026-10-05T01:30:00Z',
    lastError: null, createdAt: '2026-10-05T01:00:00Z',
  });
  const transaction = (id: string, status: 'PENDING' | 'POSTED' | 'IGNORED', reference: string) => ({
    id, connectionId, messageId: `gmail-${id}`, internalDate: '2026-10-05T01:35:00Z',
    verified: true, account: '1234567890', amount: 500000, balance: 1200000,
    currency: 'VND', direction: 'CREDIT', occurredAt: '2026-10-05T01:34:00Z',
    bankReference: reference, description: `Thanh toan ${invoiceNumber}`,
    status, reason: status === 'PENDING' ? 'NO_MATCH' : null,
    invoiceId: status === 'POSTED' ? invoiceId : null,
    receipt: status === 'POSTED' ? v5Receipt : null,
    createdAt: id === transactionId ? '2026-10-05T01:36:00Z' : '2026-10-05T01:35:00Z',
  });
  const sanitize = (value: string) => value.replace(/eyJ[A-Za-z0-9_.-]+/g, '[token]').replaceAll(process.env.BANK_EMAIL_E2E_TEST_PASSWORD!, '[password]');
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const messageText = sanitize(message.text());
    const source = message.location().url;
    if (denyBusinessInbox && source === `${testOrigin}/rest/v1/rpc/bank_email_list_v1` && /status of 403 \(Forbidden\)/.test(messageText)) {
      expectedDeniedInboxConsole.push(messageText);
      return;
    }
    errors.push(messageText);
  });
  page.on('pageerror', error => errors.push(sanitize(error.message)));

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname === '/api/bank-email/oauth/start') {
      const payload = request.postDataJSON() as { connectionId?: string };
      oauthStarts.push({ connectionId: String(payload.connectionId), bearer: /^Bearer eyJ/.test(request.headers().authorization ?? '') });
      return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&response_type=code' } });
    }
    if (url.origin === appOrigin) return route.continue();
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'text/html', body: '<title>Google OAuth fixture</title><h1>Google OAuth fixture</h1>' });
    if (url.hostname === testHost) {
      const rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.split('/').at(-1) : null;
      if (rpc === 'bank_email_list_v1') {
        if (denyBusinessInbox) return route.fulfill({ status: 403, json: { code: '42501', message: 'business permission revoked' } });
        return route.fulfill({ json: { connections: [connection()], transactions: [transaction(transactionId, posted ? 'POSTED' : 'PENDING', 'FT-E2E-POST'), transaction(ignoredId, ignored ? 'IGNORED' : 'PENDING', 'FT-E2E-IGNORE')], hasMore: false } });
      }
      if (rpc === 'bank_email_my_connections_v1') return route.fulfill({ json: { connections: [{ id: connectionId, organizationId, email: 'fixture@example.test', status: connected ? 'CONNECTED' : 'DISCONNECTED' }] } });
      if (rpc === 'bank_email_disconnect_v1') {
        const payload = request.postDataJSON() as { p_connection_id?: string };
        if (payload.p_connection_id !== connectionId) { blocked.push('unexpected owner disconnect'); return route.abort('blockedbyclient'); }
        connected = false;
        enabled = false;
        return route.fulfill({ json: connection() });
      }
      if (rpc === 'bank_email_transaction_v1') {
        const payload = request.postDataJSON() as { p_transaction_id?: string };
        if (payload.p_transaction_id !== transactionId) { blocked.push('unexpected source lookup'); return route.abort('blockedbyclient'); }
        sourceReads.push(payload.p_transaction_id);
        return route.fulfill({ json: transaction(transactionId, posted ? 'POSTED' : 'PENDING', 'FT-E2E-POST') });
      }
      if (rpc === 'bank_email_review_v1') {
        const payload = request.postDataJSON() as BankReviewRequest;
        reviews.push(payload);
        if (payload.p_transaction_id === transactionId && payload.p_invoice_number === invoiceNumber && payload.p_ignore === false && payload.p_expected_invoice_id === invoiceId && payload.p_expected_amount === 500000) {
          if (options.loseFirstPostResponse && !lostPostResponse) {
            lostPostResponse = true;
            // The browser cannot confirm the RPC result; the next attempt must read the source.
            return route.fulfill({ json: { id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: null } });
          }
          posted = true;
          return route.fulfill({ json: { id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: v5Receipt } });
        }
        if (payload.p_transaction_id === ignoredId && payload.p_ignore === true && payload.p_expected_invoice_id === null && payload.p_expected_amount === null) {
          ignored = true;
          return route.fulfill({ json: { id: ignoredId, status: 'IGNORED', reason: 'USER_IGNORED', invoiceId: null, receipt: null } });
        }
        blocked.push('unexpected bank review'); return route.abort('blockedbyclient');
      }
      if (rpc === 'bank_email_set_enabled_v1') {
        const payload = request.postDataJSON() as { p_connection_id: string; p_enabled: boolean };
        if (payload.p_connection_id !== connectionId) { blocked.push('unexpected bank switch'); return route.abort('blockedbyclient'); }
        enabled = payload.p_enabled;
        return route.fulfill({ json: connection() });
      }
      if (rpc?.startsWith('bank_email_')) { blocked.push(`unexpected ${rpc}`); return route.abort('blockedbyclient'); }
      if (url.pathname === '/rest/v1/accounts') return route.fulfill({ json: [{ id: accountId, name: 'Sổ ngân hàng TEST' }] });
      if (url.pathname === '/rest/v1/invoices') return route.fulfill({ json: [{ id: invoiceId, invoice_number: invoiceNumber, status: 'APPROVED' }] });
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      if (rpc === 'business_performance_organizations_v1' || (rpc && /^(get_|list_|my_|is_|can_|read_|check_|authorized_)/.test(rpc))) return route.continue();
      blocked.push(`${request.method()} ${url.pathname}`); return route.abort('blockedbyclient');
    }
    if (url.hostname.endsWith('.supabase.co')) { blocked.push(`non-TEST Supabase ${url.hostname}`); return route.abort('blockedbyclient'); }
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    blocked.push(`unexpected origin ${url.hostname}`); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/supabase\.co/, socket => {
    if (new URL(socket.url()).hostname !== testHost) { blocked.push('non-TEST Supabase websocket'); socket.close(); return; }
    socket.connectToServer();
  });

  const login = await context.request.post(`${testOrigin}/auth/v1/token?grant_type=password`, {
    headers: { apikey: key },
    data: { email: process.env.BANK_EMAIL_E2E_TEST_EMAIL!, password: process.env.BANK_EMAIL_E2E_TEST_PASSWORD! },
  });
  expect(login.ok(), 'TEST Supabase login').toBe(true);
  const session = await login.json();
  expect(typeof session.access_token).toBe('string');
  const directoryResponse = await context.request.post(`${testOrigin}/rest/v1/rpc/list_my_copilot_organizations_v1`, {
    headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, 'Content-Profile': 'public' }, data: {},
  });
  expect(directoryResponse.ok(), 'TEST organization directory').toBe(true);
  const directory = await directoryResponse.json() as { organizations?: Array<{ id: string }> };
  organizationId = directory.organizations?.at(0)?.id ?? '';
  expect(organizationId).toMatch(/^[a-f0-9-]{36}$/);
  await context.addInitScript(({ host, sessionValue, org }) => {
    localStorage.setItem(`sb-${host.split('.')[0]}-auth-token`, JSON.stringify(sessionValue));
    localStorage.setItem('ihomecrm.selectedOrganizationId', org);
  }, { host: testHost, sessionValue: session, org: organizationId });
  await page.goto('/settings/categories/auto-debt');
  await expect(page.getByRole('heading', { name: 'Email ACB' })).toBeVisible({ timeout: 90_000 });
  return { errors, blocked, reviews, sourceReads, oauthStarts, expectedDeniedInboxConsole, revokeBusinessAccess: () => { denyBusinessInbox = true; } };
}

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`ACB email ${viewport.width < 500 ? 'mobile' : 'desktop'}: review, ignore and OAuth handoff stay on TEST`, async ({ page, context }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(viewport);
    const state = await authenticatedFixture(page, context);
    try {
      const postRow = page.locator('article[aria-label="Giao dịch FT-E2E-POST"]');
      const ignoreRow = page.locator('article[aria-label="Giao dịch FT-E2E-IGNORE"]');
      await expect(postRow.getByText('Số tiền giao dịch:')).toBeVisible();
      await expect(postRow.getByText('Số dư sau giao dịch:')).toBeVisible();
      await expect(postRow.getByRole('button', { name: 'Xác nhận thu' })).toBeDisabled();
      await postRow.getByLabel(/Mã hóa đơn cho giao dịch/).fill('ACB-E2E');
      await postRow.getByRole('button', { name: invoiceNumber }).click();
      await postRow.getByRole('button', { name: 'Xác nhận thu' }).click();
      await expect(postRow.getByText('Đã ghi thu')).toBeVisible();
      await ignoreRow.getByRole('button', { name: 'Bỏ qua giao dịch' }).click();
      await expect(ignoreRow.getByText('Đã bỏ qua')).toBeVisible();
      expect(state.reviews).toEqual([
        { p_transaction_id: transactionId, p_invoice_number: invoiceNumber, p_ignore: false, p_expected_invoice_id: invoiceId, p_expected_amount: 500000 },
        { p_transaction_id: ignoredId, p_invoice_number: '', p_ignore: true, p_expected_invoice_id: null, p_expected_amount: null },
      ]);
      const autoSwitch = page.getByRole('switch', { name: 'Tự ghi thu tài khoản 1234567890' });
      await expect(autoSwitch).toBeEnabled();
      await autoSwitch.click();
      await expect(autoSwitch).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('button', { name: 'Kết nối Gmail' }).click();
      await expect(page.getByRole('heading', { name: 'Google OAuth fixture' })).toBeVisible();
      expect(state.oauthStarts).toEqual([{ connectionId, bearer: true }]);
    } finally {
      expect.soft(state.blocked, 'No external bank write or production request').toEqual([]);
      expect.soft(state.errors, 'No browser console or page errors').toEqual([]);
    }
  });
}

test('ACB email: an unconfirmed response reconciles PENDING source before retry', async ({ page, context }) => {
  test.setTimeout(240_000);
  const state = await authenticatedFixture(page, context, { loseFirstPostResponse: true });
  try {
    const postRow = page.locator('article[aria-label="Giao dịch FT-E2E-POST"]');
    await postRow.getByLabel(/Mã hóa đơn cho giao dịch/).fill('ACB-E2E');
    await postRow.getByRole('button', { name: invoiceNumber }).click();
    await postRow.getByRole('button', { name: 'Xác nhận thu' }).click();
    await expect(postRow.getByRole('alert')).toContainText('Chưa xác nhận');
    await postRow.getByRole('button', { name: 'Xác nhận thu' }).click();
    await expect(postRow.getByText('Đã ghi thu')).toBeVisible();
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews[1]).toEqual(state.reviews[0]);
    expect(state.sourceReads).toEqual([transactionId]);
  } finally {
    expect.soft(state.blocked, 'No external bank write or production request').toEqual([]);
    expect.soft(state.errors, 'No browser console or page errors').toEqual([]);
  }
});

test('ACB email: Gmail owner can disconnect from account after business inbox access is revoked', async ({ page, context }) => {
  test.setTimeout(240_000);
  const state = await authenticatedFixture(page, context);
  try {
    state.revokeBusinessAccess();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Email ACB' })).toBeVisible();
    await expect(page.getByText(/Chưa tải được.*ACB|không có quyền/i).first()).toBeVisible();
    expect(state.expectedDeniedInboxConsole.length).toBeGreaterThan(0);
    await page.goto('/account/profile');
    const manager = page.locator('[aria-label="Kết nối Gmail ACB của tôi"]');
    await expect(manager.getByText('fixture@example.test')).toBeVisible();
    await manager.getByRole('button', { name: 'Ngắt Gmail ACB' }).click();
    await expect(manager.getByText('Đã ngắt')).toBeVisible();
  } finally {
    expect.soft(state.blocked, 'No external bank write or production request').toEqual([]);
    expect.soft(state.errors, 'No browser console or page errors').toEqual([]);
  }
});
