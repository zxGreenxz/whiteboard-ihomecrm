import { test, expect, type APIRequestContext } from '@playwright/test';
import { USERS } from './auth';

// Read-only acceptance after the reviewed exclusion migration is seeded on TEST.
// Run from .e2e-fleet with FLEET_BASE_URL=http://127.0.0.1:5198,
// TEST_SUPABASE_PUBLISHABLE_KEY and FLEET_PASS_TEST_CHU supplied through env.
// TEST Nano times out when the unrelated contract/refund dashboard fans out.
// Those readers and the building picker use explicit fixtures below. Reservation
// list/summary, voucher/exclusion reads, authentication and authorization stay live.
const APP_ORIGIN = 'http://127.0.0.1:5198';
const TEST_REF = 'hzulujxgonszuleqticb';
const TEST_HOST = `${TEST_REF}.supabase.co`;
const TEST_ORIGIN = `https://${TEST_HOST}`;
const ORGANIZATION_ID = 'aaaa0000-0000-4000-8000-000000000001';
const VOUCHER_ID = '6196cec6-6c35-4ed5-87c7-e39c12f0f34f';
const BUILDING_ID = '59c6fc2c-2369-4ec8-b253-1ac64abb2f45';
const ROOM_ID = '46a8f5e8-cc72-4c32-a288-0dafe93f343c';

// Source: OrganizationContext, useMyPermissions, useDepositDashboard,
// useReservationSettlement, useRoomReservations and Sidebar's organization read.
const READ_RPCS = new Set([
  'list_my_copilot_organizations_v1', 'get_my_permissions_v2', 'get_my_permissions',
  'is_admin', 'is_super_admin', 'is_company_owner_self_v1',
  'business_performance_organizations_v1', 'get_held_deposit_summary',
  'get_refund_forfeit_summary', 'get_reservation_deposit_summary',
  'get_reservation_settlement_summary_v1', 'get_reservation_settlements_v1',
  'list_room_reservations_v1',
]);

const CONTROLLED_REFUND_SUMMARY = {
  refund_total: 0, refund_count: 0, forfeit_total: 0, forfeit_count: 0,
  refund_linked_total: 0, refund_linked_count: 0, refund_voucher_count: 0,
  refund_posted_orphan_total: 0, refund_posted_orphan_count: 0,
  refund_pending_total: 0, refund_pending_count: 0,
  refund_deposit_total: 0, refund_non_deposit_total: 0,
  refund_pending_deposit_total: 0, refund_pending_non_deposit_total: 0,
  refund_net_settlement_total: 0, customer_debt_total: 0, customer_debt_count: 0,
};

function controlledReader(url: URL): { name: string; body: unknown } | null {
  if (url.origin !== TEST_ORIGIN) return null;
  const select = url.searchParams.get('select') ?? '';
  if (url.pathname === '/rest/v1/contracts' && select.includes('deposit_remaining') && select.includes('contract_customers')) {
    return { name: 'deposits.held', body: [] };
  }
  if (url.pathname === '/rest/v1/contract_terminations' && select.includes('refund_amount')) {
    return { name: 'deposits.refundsForfeits', body: [] };
  }
  if (url.pathname === '/rest/v1/income_expenses' && url.searchParams.get('system_source') === 'eq.termination.refund') {
    return { name: 'deposits.postedRefundVouchers', body: [] };
  }
  if (url.pathname === '/rest/v1/buildings' && select.includes('rooms:rooms(count)')) {
    return { name: 'building picker', body: [{ id: BUILDING_ID, name: '102LVT', code: '102LVT',
      is_virtual: false, deleted_at: null, area_links: [], rooms: [{ count: 0 }] }] };
  }
  if (url.pathname === '/rest/v1/rpc/get_held_deposit_summary') return { name: 'held summary', body: [] };
  if (url.pathname === '/rest/v1/rpc/get_refund_forfeit_summary') return { name: 'refund summary', body: CONTROLLED_REFUND_SUMMARY };
  return null;
}

test.use({ headless: true, serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off' });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu ${name}; spec không được bỏ qua kiểm chứng TEST.`);
  return value;
}

async function readVoucher(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.get(`${TEST_ORIGIN}/rest/v1/income_expenses`, {
    headers,
    params: {
      select: 'id,organization_id,code,approval_status,total_amount,building_id,room_id,contract_id,deleted_at',
      id: `eq.${VOUCHER_ID}`,
    },
    maxRedirects: 0,
  });
  const errorBody = response.ok() ? '' : (await response.text())
    .replaceAll(headers.apikey, '[redacted]')
    .replaceAll(headers.Authorization.replace(/^Bearer /, ''), '[redacted]')
    .slice(0, 800);
  expect(response.status(), `đọc phiếu nguồn bằng JWT TEST ${errorBody}`).toBe(200);
  const rows = await response.json();
  expect(rows).toEqual([{
    id: VOUCHER_ID, organization_id: ORGANIZATION_ID, code: 'PT2605043',
    approval_status: 'APPROVED', total_amount: 5_000_000,
    building_id: BUILDING_ID, room_id: ROOM_ID, contract_id: null, deleted_at: null,
  }]);
  return rows;
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`TEST: ẩn phiếu giữ chỗ; sổ HĐ/hoàn cọc dùng fixture (${viewport.width}px)`, async ({ page, request }) => {
    test.setTimeout(120_000);
    expect(requiredEnvironment('FLEET_BASE_URL'), 'chỉ chạy tại local app đã chỉ định').toBe(APP_ORIGIN);
    const publicKey = requiredEnvironment('TEST_SUPABASE_PUBLISHABLE_KEY');
    const password = requiredEnvironment('FLEET_PASS_TEST_CHU');
    const auth = await request.post(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`, {
      headers: { apikey: publicKey },
      data: { email: USERS.testchu, password },
      maxRedirects: 0,
    });
    expect(auth.status(), 'đăng nhập chủ công ty trên TEST').toBe(200);
    const session = await auth.json();
    expect(typeof session.access_token).toBe('string');
    expect(session.user?.email).toBe(USERS.testchu);
    const headers = {
      apikey: publicKey, Authorization: `Bearer ${session.access_token}`,
      'Accept-Profile': 'public', 'Content-Profile': 'public',
    };
    const before = await readVoucher(request, headers);
    const exclusion = await request.get(`${TEST_ORIGIN}/rest/v1/deposit_management_exclusions`, {
      headers, params: { select: 'voucher_id', voucher_id: `eq.${VOUCHER_ID}` }, maxRedirects: 0,
    });
    expect(exclusion.status(), 'migration và fixture loại trừ phải có trên TEST').toBe(200);
    expect(await exclusion.json()).toEqual([{ voucher_id: VOUCHER_ID }]);

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const unexpectedRequests: string[] = [];
    const failedRequests: string[] = [];
    const controlledReads = new Set<string>();
    const supabaseHosts = new Set<string>();
    const blockedBackgroundUrls = new Set<string>();
    const reservationReads: Array<{ url: URL; status: number; rows: Array<{ id: string }> }> = [];
    const readCompletions: Promise<void>[] = [];
    const redact = (text: string) => [publicKey, password, session.access_token, session.refresh_token]
      .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
      .reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
      .replace(/([?&](?:token|apikey|access_token)=)[^&\s'"]+/gi, '$1[redacted]')
      .slice(0, 1000);
    const diagnostics = () => JSON.stringify({
      pageErrors: pageErrors.slice(0, 8), consoleErrors: consoleErrors.slice(0, 8),
      unexpectedRequests: unexpectedRequests.slice(0, 12), failedRequests: failedRequests.slice(0, 12),
      reservationReads: reservationReads.map(read => ({ status: read.status, rows: Array.isArray(read.rows) ? read.rows.length : 'invalid payload' })).slice(0, 8),
    });

    // No API write is forwarded. Unknown RPCs fail the test as well as being blocked.
    await page.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      if (url.hostname.endsWith('.supabase.co') && url.origin !== TEST_ORIGIN) {
        unexpectedRequests.push(`wrong Supabase host: ${url.hostname}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (req.isNavigationRequest() && url.origin !== APP_ORIGIN) {
        unexpectedRequests.push(`wrong navigation origin: ${url.origin}`);
        await route.abort('blockedbyclient');
        return;
      }
      const rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.split('/').at(-1) : null;
      const allowedRpc = url.origin === TEST_ORIGIN && rpc && READ_RPCS.has(rpc) && ['GET', 'POST'].includes(method);
      const allowedAuth = url.origin === TEST_ORIGIN && url.pathname === '/auth/v1/token' && method === 'POST';
      const allowedRead = method === 'OPTIONS' || (['GET', 'HEAD'].includes(method) && !rpc);
      if (allowedRpc || allowedAuth || allowedRead) {
        const fixture = method === 'OPTIONS' ? null : controlledReader(url);
        if (fixture) {
          controlledReads.add(fixture.name);
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.body) });
          return;
        }
        await route.continue();
        return;
      }
      if (url.origin === TEST_ORIGIN && url.pathname === '/rest/v1/notifications' && method === 'POST') {
        blockedBackgroundUrls.add(req.url());
      } else {
        unexpectedRequests.push(`${method} ${url.hostname}${url.pathname}`);
      }
      await route.abort('blockedbyclient');
    });
    await page.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const isLocal = url.hostname === '127.0.0.1' && url.port === '5198';
      if (!isLocal && url.hostname !== TEST_HOST) {
        unexpectedRequests.push(`blocked websocket: ${url.hostname}`);
        socket.close();
        return;
      }
      socket.connectToServer();
    });
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.hostname.endsWith('.supabase.co')) supabaseHosts.add(url.hostname);
    });
    page.on('requestfailed', req => {
      if (blockedBackgroundUrls.has(req.url())) return;
      const url = new URL(req.url());
      failedRequests.push(redact(`${req.method()} ${url.origin}${url.pathname}: ${req.failure()?.errorText}`));
    });
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.hostname.endsWith('.supabase.co')) {
        supabaseHosts.add(url.hostname);
        if (url.hostname !== TEST_HOST) unexpectedRequests.push(`wrong Supabase websocket: ${url.hostname}`);
      }
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (blockedBackgroundUrls.has(message.location().url) && /net::ERR_BLOCKED_BY_CLIENT/.test(message.text())) return;
      consoleErrors.push(redact(message.text()));
    });
    page.on('pageerror', error => pageErrors.push(redact(error.message)));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== TEST_ORIGIN || url.pathname !== '/rest/v1/income_expenses' ||
          !url.searchParams.get('select')?.includes('reservation_deposit_settlements')) return;
      readCompletions.push((async () => {
        const rows = await response.json();
        reservationReads.push({ url, status: response.status(), rows });
      })());
    });

    await page.setViewportSize(viewport);
    await page.addInitScript(({ savedSession, storageKey, orgId, buildingId, origin }) => {
      if (window.location.origin !== origin) return;
      localStorage.setItem(storageKey, JSON.stringify(savedSession));
      localStorage.setItem('ihomecrm.selectedOrganizationId', orgId);
      sessionStorage.setItem('flt:deposits:buildingIds', JSON.stringify([buildingId]));
    }, { savedSession: session, storageKey: `sb-${TEST_REF}-auth-token`, orgId: ORGANIZATION_ID, buildingId: BUILDING_ID, origin: APP_ORIGIN });

    try {
      await page.goto(`${APP_ORIGIN}/deposits`);
      await expect(page.getByRole('heading', { name: 'Quản lý Cọc', exact: true })).toBeVisible();
      await expect.poll(() => reservationReads.some(read => Array.isArray(read.rows) && read.rows.length === 0), {
        message: 'danh sách cọc phải đọc đến trang cuối, không chỉ hiện màn hình rỗng khi còn tải',
      }).toBe(true);
    } catch (error) {
      throw new Error(`${redact(error instanceof Error ? error.message : String(error))}\nDiagnostics: ${diagnostics()}`);
    }
    await Promise.all(readCompletions);
    expect(reservationReads.length).toBeGreaterThan(0);
    for (const read of reservationReads) {
      expect(read.status).toBe(200);
      expect(read.url.searchParams.get('management_exclusion')).toBe('is.null');
      expect(read.url.searchParams.get('select')).toContain('management_exclusion:deposit_management_exclusions');
      expect(read.rows.some(row => row.id === VOUCHER_ID)).toBe(false);
    }

    if (viewport.width > 768) {
      await expect(page.getByText('Giữ chỗ chờ ký · 0', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Sổ cọc đầy đủ/ }).click();
      await page.getByRole('tab', { name: 'Phiếu giữ chỗ', exact: true }).click();
      await expect(page.getByRole('row').filter({ hasText: 'PT2605043' }).filter({ hasText: '104' })).toHaveCount(0);
    } else {
      await page.getByRole('button', { name: /^Sổ cọc ·/ }).click();
      await page.getByRole('button', { name: 'Phiếu giữ chỗ', exact: true }).click();
      await expect(page.locator('.dp-lrow').filter({ hasText: 'P.104 · 102LVT' }).filter({ hasText: 'PT2605043' })).toHaveCount(0);
    }

    const summary = await request.post(`${TEST_ORIGIN}/rest/v1/rpc/get_reservation_deposit_summary`, {
      headers, data: { p_building_ids: [BUILDING_ID] }, maxRedirects: 0,
    });
    expect(summary.status()).toBe(200);
    expect(await summary.json()).toMatchObject({ holding_amount: 0, approved_count: 0, cancelled_count: 4 });
    expect(await readVoucher(request, headers)).toEqual(before);
    expect(controlledReads.has('deposits.held')).toBe(true);
    expect(controlledReads.has('held summary')).toBe(true);
    expect(controlledReads.has('refund summary')).toBe(true);
    expect([...supabaseHosts]).toEqual([TEST_HOST]);
    expect(unexpectedRequests, 'request nằm ngoài phạm vi đọc đã cho phép').toEqual([]);
    expect(pageErrors, 'lỗi JavaScript của trang').toEqual([]);
    expect(consoleErrors, 'console errors không được bỏ qua').toEqual([]);
  });
}
