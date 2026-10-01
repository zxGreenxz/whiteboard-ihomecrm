import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page, type Request, type TestInfo } from '@playwright/test';
import { createNavigationReadGuard } from '../../scripts/lib/commission-e2e-network.mjs';

export const TEST_REF = 'hzulujxgonszuleqticb';
export const TEST_ORIGIN = `https://${TEST_REF}.supabase.co`;
export const browserAudits = new WeakMap<Page, Record<string, unknown>>();
export const browserAuditPending = new WeakMap<Page, Promise<void>[]>();
const navigationSnapshots = new WeakMap<Page, () => void>();
export async function navigateTest(page: Page, path: string) {
  await page.waitForLoadState('networkidle'); navigationSnapshots.get(page)?.(); await page.goto(path);
}
type Actor = { id: string; email: string; password_env: string };
export type Subject = { contract_id: string; contract_number: string; room_name: string };
export interface BrowserFixture {
  project: string; source_sha: string; app_url: string; organization_id: string; marker: string;
  building_id: string; building_name: string; party_id: string; account_id: string;
  actors: { owner: Actor; manager: Actor; contracts_only: Actor };
  draft: { id: string; customer_name: string; template_name: string };
  role_draft: { id: string; customer_name: string };
  subjects: { commission_only: Subject; bonus_first: Subject; net_zero: Subject; shortage: Subject; invoice: Subject; excel: Subject };
  reader_contract_ids?: string[];
  deposit_v3?: Subject & { deposit_claim_id: string; deposit_voucher_id: string; bonus_voucher_id: string; bonus_gross: string };
}
const uuid = (value: string) => expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export function fixtures(): BrowserFixture {
  expect(process.env.RENT_SUPPORT_BROWSER_FIXTURE).toBeTruthy();
  const f = JSON.parse(readFileSync(process.env.RENT_SUPPORT_BROWSER_FIXTURE!, 'utf8')) as BrowserFixture;
  expect(f.project).toBe(TEST_REF);
  expect(f.marker).toMatch(/^task(?:7|8|10)-[a-z0-9-]+$/);
  expect(f.app_url).toBe(process.env.FLEET_BASE_URL);
  expect(f.app_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$|^https:\/\/ihomecrm-git-test-env-[a-z0-9-]+\.vercel\.app$/);
  expect(process.env.FLEET_HEADED).toBeFalsy();
  expect(f.source_sha).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim());
  [f.organization_id, f.building_id, f.party_id, f.account_id, f.draft.id, f.role_draft.id].forEach(uuid);
  expect(f.draft.id).not.toBe(f.role_draft.id);
  const ids = Object.values(f.subjects).map(subject => subject.contract_id);
  ids.forEach(uuid); expect(new Set(ids).size).toBe(6);
  if (f.reader_contract_ids) { expect(f.reader_contract_ids).toHaveLength(2); f.reader_contract_ids.forEach(uuid); expect(new Set(f.reader_contract_ids).size).toBe(2); }
  for (const actor of Object.values(f.actors)) {
    uuid(actor.id); expect(actor.email).toMatch(/@example\.invalid$/);
    expect(actor.password_env).toMatch(/^RENT_SUPPORT_TEST_PASS_[A-Z_]+$/);
    expect(Object.hasOwn(actor, 'password') || Object.hasOwn(actor, 'jwt')).toBe(false);
  }
  if (process.env.RENT_SUPPORT_BROWSER_DEPOSIT_FIXTURE) {
    const extension = JSON.parse(readFileSync(process.env.RENT_SUPPORT_BROWSER_DEPOSIT_FIXTURE, 'utf8'));
    expect(extension.project).toBe(f.project); expect(extension.source_sha).toBe(f.source_sha);
    expect(extension.organization_id).toBe(f.organization_id); expect(extension.marker).toBe(f.marker);
    f.deposit_v3 = extension.deposit_v3;
    for (const id of [f.deposit_v3!.contract_id, f.deposit_v3!.deposit_claim_id, f.deposit_v3!.deposit_voucher_id, f.deposit_v3!.bonus_voucher_id]) uuid(id);
    expect(ids.includes(f.deposit_v3!.contract_id)).toBe(false); expect(f.deposit_v3!.bonus_gross).toBe('500000');
  }
  return f;
}
const READERS = new Set([
  'get_my_context', 'get_my_assignments', 'is_admin', 'is_super_admin', 'get_my_permissions', 'get_my_permissions_v2',
  'my_org_ids', 'can_access_building', 'accessible_building_ids', 'get_contract_stats', 'get_dashboard_summary',
  'list_my_copilot_organizations_v1', 'business_performance_organizations_v1', 'list_cashbook_visibility_v2',
  'get_notification_org_config_v1', 'get_my_notification_preferences_v1', 'list_contract_drafts', 'list_room_reservations_v1',
  'list_due_contract_move_out_notices_v1', 'list_contract_exit_cases_v1', 'list_contract_meter_followups_v1',
  'get_contract_move_out_notice_v1', 'read_contract_meter_boundary_set_v1', 'read_contract_transfer_links_v1',
  'read_contract_rent_support_v1', 'quote_contract_rent_support_v1', 'quote_invoice_rent_support_v1',
  'list_rent_support_parties_v1', 'read_contract_payout_operation_v1', 'read_contract_payout_request_v1',
  'list_contract_commission_followups_v2', 'get_commission_voucher_facts_v1', 'sale_bonus_status_v1',
  'read_contract_draft_signing_v1', 'read_contract_meter_interval_v1', 'read_contract_rent_support_lifecycle_v1',
  'read_rent_support_deposit_candidate_v1',
  'get_invoice_statistics_v2', 'is_company_owner_self_v1', 'invoice_active_payment_methods', 'get_customer_credit_balance_v1',
  'read_rent_support_salary_parts_v1',
  // Existing canonical readers used by the salary and settlement pages. Money
  // writers (lock/pay/approve/collect/termination) remain outside the allowlist.
  'salary_work_ledger', 'salary_commission_meta_v1', 'salary_staff_months', 'get_salary_v5_config', 'v5_month_money_bulk',
  'salary_recurring_list_v1', 'salary_line_override_list_v1', 'salary_can_edit_amounts_v1', 'rent_support_salary_bridge_required_v1',
  'get_special_fee_prices_v1', 'get_period_fee_status', 'get_period_commissions', 'is_org_owner_self_v1',
  'ie_form_buildings', 'ie_form_rooms', 'read_income_expense_details_v1', 'get_room_cash_lifecycle_v1', 'get_room_residence_segments_v1',
  'get_finance_v2_client_flags_v1', 'can_flex_cancel_v1',
]);
const WRITERS = new Set(['save_contract_draft', 'register_contract_draft_document', 'sign_and_checkin_contract_draft_v1',
  'prepare_contract_payouts_with_support_v1', 'execute_contract_payout_operation_v1', 'create_invoice_v1', 'create_invoice_with_credit_v1', 'mark_overdue_invoices_v1', 'verify_rent_support_deposit_payee_v1']);
export async function openTest(page: Page, f: BrowserFixture, role: keyof BrowserFixture['actors'], path = '/contracts') {
  const actor = f.actors[role], password = process.env[actor.password_env], key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
  expect(password, `synthetic password env for ${role}`).toBeTruthy();
  expect(key, 'TEST publishable key in env').toBeTruthy();
  const auth = await page.request.post(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`, { headers: { apikey: key! }, data: { email: actor.email, password } });
  expect(auth.status(), 'actual TEST login').toBe(200);
  const session = await auth.json() as { access_token: string; expires_in: number; user: { id: string } };
  expect(session.user.id).toBe(actor.id);
  expect(JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'))).toMatchObject({ role: 'authenticated', sub: actor.id });
  const headers = { apikey: key!, Authorization: `Bearer ${session.access_token}`, 'Accept-Profile': 'public', 'Content-Profile': 'public' };
  const get = async <T>(query: string): Promise<T> => {
    const response = await page.request.get(`${TEST_ORIGIN}/rest/v1/${query}`, { headers });
    expect(response.status(), 'actual TEST fixture read').toBe(200); return response.json() as Promise<T>;
  };
  const rpc = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
    expect(READERS.has(name), 'helper only calls explicit readers').toBe(true);
    const response = await page.request.post(`${TEST_ORIGIN}/rest/v1/rpc/${name}`, { headers, data: body });
    expect(response.status(), `actual TEST reader ${name}`).toBe(200); return response.json() as Promise<T>;
  };
  // OrganizationProvider uses this canonical directory: ordinary members cannot
  // SELECT organizations directly under its RLS, even for their own ACTIVE org.
  const directory = await rpc<{ organizations: { id: string; name: string }[] }>('list_my_copilot_organizations_v1', {});
  expect(directory.organizations.filter(org => org.id === f.organization_id))
    .toEqual([expect.objectContaining({ id: f.organization_id, name: f.marker })]);
  const errors: string[] = [], blocked: string[] = [], networkFailures: string[] = [], writes: string[] = [], networkConsole: string[] = [];
  const rpcFailures: { name: string; status: number; code?: string; message?: string }[] = [];
  const writerFailures: { name: string; status: number; error: unknown; request: Record<string, unknown> }[] = [];
  const headerCompleteNotificationReads: { method: string; path: string; responseStatus: number; failure: string }[] = [];
  const networkJobs: Promise<void>[] = []; browserAuditPending.set(page, networkJobs);
  const navigation = createNavigationReadGuard({ appOrigin: f.app_url, testOrigin: TEST_ORIGIN });
  const pendingSupportReads = new Set<Request>(), reloadSupportReads = new Set<Request>();
  const navigationCancelledReads: unknown[] = [];
  const isSupportRead = (request: Request) => new URL(request.url()).origin === TEST_ORIGIN && request.method() === 'POST'
    && ['/rest/v1/rpc/read_contract_rent_support_v1', '/rest/v1/rpc/quote_contract_rent_support_v1'].includes(new URL(request.url()).pathname);
  const snapshot = () => { navigation.snapshot('harness-navigation'); for (const request of pendingSupportReads) reloadSupportReads.add(request); };
  navigationSnapshots.set(page, snapshot);
  const subjectReads: { name: string; contract_ids: string[] }[] = [];
  browserAudits.set(page, { errors, blocked, networkFailures, writes, networkConsole, rpcFailures, writerFailures, headerCompleteNotificationReads, subjectReads, navigationCancelledReads });
  page.on('request', request => {
    navigation.started(request); if (isSupportRead(request)) pendingSupportReads.add(request);
    const name = new URL(request.url()).pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (!name || !READERS.has(name) || request.method() !== 'POST') return;
    const body = request.postDataJSON() as { p_contract_id?: string; p_contract_ids?: string[] };
    const ids = body.p_contract_ids ?? (body.p_contract_id ? [body.p_contract_id] : []);
    if (ids.length) subjectReads.push({ name, contract_ids: ids });
  });
  page.on('requestfinished', request => { navigation.finished(request); pendingSupportReads.delete(request); });
  const operations = new Set<string>(), allowedContracts = new Set(Object.values(f.subjects).map(subject => subject.contract_id));
  if (f.deposit_v3) allowedContracts.add(f.deposit_v3.contract_id);
  const readerContracts = new Set(allowedContracts);
  if (f.reader_contract_ids?.length) {
    const rows = await get<{ id: string; organization_id: string; room: { building_id: string } }[]>(
      `contracts?select=id,organization_id,room:rooms!contracts_room_id_fkey(building_id)&id=in.(${f.reader_contract_ids.join(',')})&organization_id=eq.${f.organization_id}`);
    expect(rows.map(row => row.id).sort()).toEqual([...f.reader_contract_ids].sort());
    for (const row of rows) { expect(row.organization_id).toBe(f.organization_id); expect(row.room.building_id).toBe(f.building_id); readerContracts.add(row.id); }
  }
  const expectedTransportFailures = new Set<Request>();
  const expectedLostResponseConsole: string[] = [];
  let loseResponse: ((value: unknown) => void) | undefined;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') {
    if (/Failed to load resource|Failed to fetch/i.test(message.text())) {
      if (message.text() === 'Failed to load resource: net::ERR_FAILED'
        && message.location().url === `${TEST_ORIGIN}/rest/v1/rpc/execute_contract_payout_operation_v1`
        && expectedTransportFailures.size === 1) expectedLostResponseConsole.push(message.text());
      else networkConsole.push(message.text());
    } else errors.push(message.text());
  } });
  page.on('requestfailed', request => { networkJobs.push((async () => {
    const url = new URL(request.url()), failure = request.failure()?.errorText ?? '';
    const responseStatus = (await request.response())?.status();
    const cancelled = navigation.cancelled(request, failure, responseStatus);
    if (cancelled || (reloadSupportReads.has(request) && isSupportRead(request) && failure === 'net::ERR_ABORTED' && !(responseStatus && responseStatus >= 400))) {
      navigationCancelledReads.push(cancelled ?? { boundary: 'harness-reload', path: url.pathname, method: request.method(), failure, responseStatus });
      navigation.finished(request); pendingSupportReads.delete(request); return;
    }
    // Reuse the exact header-complete HEAD classification of
    // scripts/test-commission-failure-ui.mjs; other aborts/errors still fail.
    if (url.origin === TEST_ORIGIN && url.pathname === '/rest/v1/notifications'
      && request.method() === 'HEAD' && responseStatus === 200 && failure === 'net::ERR_ABORTED') {
      headerCompleteNotificationReads.push({ method: 'HEAD', path: url.pathname, responseStatus, failure }); return;
    }
    if (!expectedTransportFailures.has(request)) networkFailures.push(`${request.method()} ${url.hostname}${url.pathname} ${failure}`);
    navigation.finished(request); pendingSupportReads.delete(request);
  })()); });
  page.on('response', response => { networkJobs.push((async () => { if (response.status() >= 400) {
    const path = new URL(response.url()).pathname;
    networkFailures.push(`HTTP${response.status()} ${path}`);
    const name = path.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (name) { try { const body = await response.json(); rpcFailures.push({ name, status: response.status(), code: body.code, message: body.message }); } catch { rpcFailures.push({ name, status: response.status() }); } }
  } })()); });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const block = async () => { blocked.push(`${method} ${url.hostname}${url.pathname}`); await route.abort('blockedbyclient'); };
    if (!url.hostname.endsWith('.supabase.co')) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && url.origin !== f.app_url) return block();
      return route.continue();
    }
    if (url.origin !== TEST_ORIGIN) return block();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    if (url.pathname === '/auth/v1/token') return route.continue();
    const name = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (name) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.p_organization_id && body.p_organization_id !== f.organization_id) return block();
      if (body.p_contract_id && !(READERS.has(name) ? readerContracts : allowedContracts).has(String(body.p_contract_id))) return block();
      if (body.p_draft_id && ![f.draft.id, f.role_draft.id].includes(String(body.p_draft_id))) return block();
      if (READERS.has(name)) return route.continue();
      if (role !== 'owner' || !WRITERS.has(name)) return block();
      if (name === 'mark_overdue_invoices_v1') {
        expect(Object.keys(body)).toEqual([]);
        const proof = JSON.parse(readFileSync(process.env.RENT_SUPPORT_OVERDUE_SCOPE_PROOF!, 'utf8'));
        expect(proof.actor).toBe(actor.id); expect(proof.organization).toBe(f.organization_id);
        expect(proof.canonical_editable_buildings).toHaveLength(2);
        expect(proof.canonical_editable_buildings.every((building: { organization_id: string }) => building.organization_id === f.organization_id)).toBe(true);
      }
      if (name === 'verify_rent_support_deposit_payee_v1') {
        expect(f.deposit_v3).toBeTruthy();
        expect(body).toMatchObject({ p_contract_id: f.deposit_v3!.contract_id, p_claim_id: f.deposit_v3!.deposit_claim_id,
          p_deposit_voucher_id: f.deposit_v3!.deposit_voucher_id, p_bonus_voucher_id: f.deposit_v3!.bonus_voucher_id, p_party_id: f.party_id });
      }
      if (name === 'execute_contract_payout_operation_v1' && !operations.has(String(body.p_operation_id))) return block();
      writes.push(name);
      const response = await route.fetch({ maxRedirects: 0 });
      if (!response.ok()) {
        // Guarded synthetic RPC only; capture real error before UI teardown can
        // dispose the fulfilled response. No auth headers or tokens are retained.
        let error: unknown;
        try { const raw = await response.json(); error = { code: raw.code, message: raw.message, details: raw.details, hint: raw.hint }; }
        catch { error = { unreadable: true }; }
        writerFailures.push({ name, status: response.status(), error, request: body });
      }
      if (response.ok()) {
        const result = await response.json() as { operation_id?: string; contract_id?: string };
        if (name === 'prepare_contract_payouts_with_support_v1' && result.operation_id) operations.add(result.operation_id);
        if (name === 'sign_and_checkin_contract_draft_v1' && result.contract_id) allowedContracts.add(result.contract_id);
        if (name === 'execute_contract_payout_operation_v1' && loseResponse) {
          expect(response.status()).toBe(200); expect(result.operation_id).toBe(body.p_operation_id);
          const resolveLost = loseResponse; loseResponse = undefined; expectedTransportFailures.add(request);
          resolveLost(result); await route.abort('failed'); return;
        }
      }
      return route.fulfill({ response }); // Unchanged real response; no save/sign/money stubs.
    }
    const root = `/storage/v1/object/contract-draft-documents/${f.organization_id}/${f.building_id}/${f.draft.id}/`;
    if (role === 'owner' && method === 'POST' && url.pathname.startsWith(root)) return route.continue();
    return block();
  });
  await page.addInitScript(({ session, organization, ref }) => {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in }));
    localStorage.setItem('ihomecrm.selectedOrganizationId', organization);
  }, { session, organization: f.organization_id, ref: TEST_REF });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(path);
  return { get, rpc, writes, allowedContracts, subjectReads,
    loseNextExecuteResponse: () => new Promise<unknown>(resolve => { expect(loseResponse).toBeUndefined(); loseResponse = resolve; }),
    reload: async () => { await page.waitForLoadState('networkidle'); snapshot(); await page.reload(); },
    verify: async (info: TestInfo, evidence: Record<string, unknown>) => {
      await Promise.all(networkJobs);
      const path = info.outputPath('rent-support-proof.json');
      writeFileSync(path, JSON.stringify({ project: TEST_REF, source_sha: f.source_sha, organization_id: f.organization_id, ...evidence, writes, blocked, errors, networkFailures, networkConsole, expectedLostResponseConsole, navigationCancelledReads }, null, 2));
      await info.attach('rent-support-proof.json', { path, contentType: 'application/json' });
      expect(blocked).toEqual([]); expect(errors).toEqual([]); expect(networkFailures).toEqual([]);
      expect(networkConsole).toEqual([]);
    } };
}
export const rpcResponse = (page: Page, name: string) => page.waitForResponse(response => response.url() === `${TEST_ORIGIN}/rest/v1/rpc/${name}` && response.request().method() === 'POST');
export async function selectRadix(page: Page, trigger: ReturnType<Page['getByRole']>, name: string) {
  await trigger.click(); await page.getByRole('option', { name, exact: true }).click();
}
export async function draftRow(page: Page, customer: string) {
  await page.getByRole('tablist', { name: 'Các mục hợp đồng' }).getByRole('tab', { name: /Hợp đồng nháp/ }).click();
  const row = page.getByRole('region', { name: 'Hợp đồng nháp', exact: true }).locator('div.p-4.flex').filter({ hasText: customer });
  await expect(row).toHaveCount(1); return row;
}
export async function openPayout(page: Page, subject: Subject) {
  await navigateTest(page, `/contracts/${subject.contract_id}`);
  await page.getByRole('button', { name: 'Tạo phiếu hoa hồng', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tạo phiếu hoa hồng và hỗ trợ tiền thuê', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}
