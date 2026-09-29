#!/usr/bin/env node
// Guarded TEST browser regression. The app server on :4186 must already target TEST.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { testConnection, signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
import { createNavigationReadGuard } from './lib/commission-e2e-network.mjs';

const BASE = 'http://127.0.0.1:4186';
const PROD_REF = 'tryymsxyyckgbrmmvozx';
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const ctx = await testConnection();
assert.equal(ctx.cred.testRef, 'hzulujxgonszuleqticb');
const ownerEmail = 'nguyentam@username.ihomecrm.local';
const owner = await signInTest(ctx, ownerEmail, matKhauTest(ctx.cred.passwordSeed, ownerEmail));
const scope = await request(ctx, owner.access_token, 'rpc/list_contract_commission_followups_v2',
  { p_organization_id: ORG, p_unresolved_only: false, p_limit: 100 });
assert.equal(scope.status, 200, 'owner followup source must be readable');
const source = scope.json.rows.find(row => row.can_manage);
assert(source, 'owner needs accessible building');
const db = new pg.Client({ host: ctx.cred.testPoolerHost, port: 5432, user: `postgres.${ctx.cred.testRef}`,
  password: ctx.cred.testDbPassword, database: 'postgres', ssl: { rejectUnauthorized: false } });
await db.connect();
if (process.argv.includes('--inspect')) {
  const columns = await db.query("select column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name='accounts' order by ordinal_position");
  console.log(JSON.stringify(columns.rows)); await db.end(); process.exit(0);
}
if (process.argv.includes('--cleanup-residue')) {
  const stale = JSON.parse(readFileSync('.superpowers/sdd/2026-09-29-commission-failure-retry/task-2-e2e-report.json', 'utf8'));
  assert.equal(stale.target, ctx.cred.testRef); assert.match(stale.marker, /^E2E-RETRY-\d+$/);
  const old = (await db.query('select id from public.contracts where organization_id=$1 and public_code like $2', [ORG, `${stale.marker}-%`])).rows.map(r => r.id);
  await db.query('begin'); await db.query('set local session_replication_role=replica');
  const vouchers = (await db.query('select id from public.income_expenses where contract_id=any($1::uuid[])', [old])).rows.map(r => r.id);
  await db.query('delete from public.income_expense_items where income_expense_id=any($1::uuid[])', [vouchers]);
  await db.query('delete from public.income_expenses where id=any($1::uuid[])', [vouchers]);
  await db.query('delete from public.contract_commission_events where contract_id=any($1::uuid[])', [old]);
  await db.query('delete from public.contract_commission_requests where contract_id=any($1::uuid[])', [old]);
  await db.query('delete from public.contracts where id=any($1::uuid[])', [old]);
  await db.query('commit'); console.log(JSON.stringify({ cleanedContracts: old.length, marker: stale.marker })); await db.end(); process.exit(0);
}
const ids = [randomUUID(), randomUUID()];
const repairedAccount = randomUUID();
const marker = `E2E-RETRY-${Date.now()}`;
const report = { target: ctx.cred.testRef, base: BASE, marker, checks: [], console: [], blockedProduction: [],
  expectedConsole: [], expectedNetwork: [], successfulHeadReceipts: [], navigationCancelledReads: [], unexpectedNetwork: [], cleanup: false, screenshots: [] };
let browser;
let activePage;
let injectedFailure = null;
const expectedExecuteRequests = new Set();
const navigationGuards = new Map(), networkJobs = [];
const isExpectedConsole = (text, location) => {
  if (!injectedFailure) return false;
  if (/Failed to load resource/.test(text)) return location.endsWith('/rpc/execute_commission_request_v1')
    && injectedFailure === 'lost-response';
  return text.startsWith('Error creating commission voucher:')
    && location.includes('/src/hooks/useCommissionVoucher.ts')
    && (injectedFailure === 'canonical-failure' ? text.includes('Máy chủ chưa tạo được phiếu.') : text.includes('Failed to fetch'));
};
const rpc = async (name, body) => request(ctx, owner.access_token, `rpc/${name}`, body);
const list = async (contractId) => {
  const r = await rpc('list_contract_commission_followups_v2',
    { p_organization_id: ORG, p_contract_ids: [contractId], p_unresolved_only: false });
  assert.equal(r.status, 200); return r.json.rows;
};
const voucherCount = async (contractId, kind) => (await db.query(
  "select count(*)::int n from public.income_expenses where contract_id=$1 and commission_kind=$2 and deleted_at is null",
  [contractId, kind])).rows[0].n;
const guarded = async (viewport) => {
  const context = await browser.newContext({ viewport });
  await context.route(`https://${PROD_REF}.supabase.co/**`, route => {
    report.blockedProduction.push(new URL(route.request().url()).pathname);
    return route.abort('blockedbyclient');
  });
  await context.route(/https:\/\/[^/]+\.supabase\.co\//, route => {
    const ref = new URL(route.request().url()).hostname.split('.')[0];
    if (ref !== ctx.cred.testRef) { report.blockedProduction.push(route.request().url()); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await context.addInitScript(({ org, key, session }) => {
    localStorage.setItem('ihomecrm.selectedOrganizationId', org);
    localStorage.setItem(key, JSON.stringify(session));
  }, { org: ORG, key: `sb-${ctx.cred.testRef}-auth-token`, session: owner });
  const page = await context.newPage();
  const navigation = createNavigationReadGuard({ appOrigin: BASE, testOrigin: ctx.url });
  navigationGuards.set(page, navigation);
  page.on('request', navigation.started); page.on('requestfinished', navigation.finished);
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.console.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const entry = { text: message.text(), url: page.url(), location: message.location().url };
    if (isExpectedConsole(entry.text, entry.location))
      report.expectedConsole.push(entry);
    else report.console.push(entry);
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    report.unexpectedNetwork.push({ path, status: response.status() });
  });
  page.on('requestfailed', failed => { networkJobs.push((async () => {
    navigation.finished(failed);
    const entry = { path: new URL(failed.url()).pathname, method: failed.method(), responseStatus: (await failed.response())?.status(), failure: failed.failure()?.errorText };
    const successHead = entry.path === '/rest/v1/notifications' && entry.method === 'HEAD' && entry.responseStatus === 200 && entry.failure === 'net::ERR_ABORTED';
    const cancelled = navigation.cancelled(failed, entry.failure, entry.responseStatus);
    if (cancelled) report.navigationCancelledReads.push(cancelled);
    else (successHead ? report.successfulHeadReceipts : expectedExecuteRequests.has(failed) ? report.expectedNetwork : report.unexpectedNetwork).push(entry);
  })()); });
  navigation.snapshot('goto');
  await page.goto(`${BASE}/contracts`);
  return { context, page };
};
const shot = async (page, name) => { const path = `.superpowers/sdd/2026-09-29-commission-failure-retry/${name}.png`;
  await page.screenshot({ path }); report.screenshots.push(path); };
// Let the previous page's real REST reads finish before navigation. Aborting a
// background read during a rapid goto creates misleading Failed to fetch noise
// and can pile expensive TEST queries onto the 8-second PostgREST limit.
const settle = async page => {
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
};
const go = async (page, path) => { await settle(page);
  navigationGuards.get(page).snapshot('spa-route');
  await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
};
const reload = async page => { await settle(page); navigationGuards.get(page).snapshot('reload'); await page.reload(); };
try {
  const markerCheck = await db.query('select ref from test_env.danh_dau limit 1');
  assert.equal(markerCheck.rows[0]?.ref, ctx.cred.testRef, 'TEST database marker required');
  await db.query('begin');
  await db.query('set local session_replication_role=replica');
  for (const [i, id] of ids.entries()) await db.query(`insert into public.contracts
    (id,user_id,room_id,organization_id,status,signed_date,start_date,end_date,rent_price,public_code,contract_number)
    select $1,user_id,room_id,organization_id,'TERMINATED',current_date,current_date,current_date+365,1000000,$2,$3
    from public.contracts where id=$4`, [id, `${marker}-${i}`, `${marker}-${i}`, source.contract_id]);
  await db.query('commit');
  browser = await chromium.launch({ headless: true });
  const desktop = await guarded({ width: 1440, height: 1000 });
  const { page } = desktop;
  activePage = page;
  await expect(page.getByRole('tablist', { name: 'Các mục hợp đồng' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Theo dõi hoa hồng và thưởng Sale' })).toHaveCount(0);
  report.checks.push('Contracts desktop: no third panel or new review tab');
  await go(page, `/contracts/${ids[0]}`);
  const detail = page.getByLabel('Tạo hoa hồng và thưởng Sale');
  await expect(detail.getByRole('button', { name: 'Tạo phiếu hoa hồng' })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Tạo phiếu hoa hồng' }).click();
  const modal = page.getByRole('dialog', { name: 'Tạo phiếu chi hoa hồng' });
  await expect(modal.getByRole('button', { name: 'Tạo phiếu chi' })).toBeEnabled({ timeout: 30_000 });
  await modal.locator('input[inputmode="numeric"][placeholder="0"]').first().fill('1000');
  await modal.locator('input[inputmode="numeric"][placeholder="0"]').first().blur();
  let preparedRequest;
  await page.route('**/rest/v1/rpc/prepare_commission_requests_v1', async route => {
    const body = route.request().postDataJSON();
    if (body.p_intents?.[0]?.contract_id !== ids[0]) return route.continue();
    body.p_intents[0].account_id = repairedAccount;
    injectedFailure = 'canonical-failure';
    preparedRequest = body.p_intents[0];
    return route.continue({ postData: JSON.stringify(body) });
  });
  await modal.getByRole('button', { name: 'Tạo phiếu chi' }).click();
  await expect.poll(async () => (await list(ids[0])).find(row => row.kind === 'broker')?.state,
    { timeout: 30_000 }).toBe('FAILED');
  assert(preparedRequest?.request_id);
  assert.equal(await voucherCount(ids[0], 'broker'), 0);
  await modal.getByRole('button', { name: 'Để xử lý sau' }).click();
  injectedFailure = null;
  await reload(page);
  await expect(detail.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole('button', { name: 'Tạo lại' })).toBeVisible();
  await shot(page, 'task-2-real-failure-desktop');
  report.checks.push('Actual canonical writer failure persisted after reload; no voucher was fabricated');
  if (!process.argv.includes('--skip-settlement')) {
    await go(page, '/thanh-toan');
    await page.locator('.ptt-panel .ptt-trigger').click();
    await page.locator('.ptt-panel .ptt-menu-item').filter({ hasText: 'Hợp đồng & quyết toán' }).click();
    const settlement = page.locator('.cs-wrap');
    await expect(settlement).toBeVisible({ timeout: 30_000 });
    await settlement.getByRole('button', { name: /Cần rà soát/ }).click();
    await expect(settlement.getByLabel('Lỗi tạo hoa hồng / thưởng Sale').getByText(`${marker}-0`)).toBeVisible({ timeout: 30_000 });
    await shot(page, 'task-2-real-failure-settlement');
    report.checks.push('Existing desktop Cần rà soát lane shows TEST persisted failure, separate from voucher totals');
  }
  await db.query('begin'); await db.query('set local session_replication_role=replica');
  await db.query("insert into public.accounts(id,user_id,organization_id,name,code,initial_amount,initial_date) values($1,$2,$3,$4,$5,0,current_date)",
    [repairedAccount, owner.user.id, ORG, marker, marker]);
  await db.query('commit');
  if (process.argv.includes('--settlement-retry')) {
    const queue = page.getByLabel('Lỗi tạo hoa hồng / thưởng Sale');
    const failure = queue.locator('[role="alert"]').filter({ hasText: `${marker}-0` });
    await expect(failure).toBeVisible({ timeout: 30_000 });
    await failure.getByRole('button', { name: 'Tạo lại' }).click();
    await expect.poll(async () => voucherCount(ids[0], 'broker'), { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await list(ids[0])).find(row => row.kind === 'broker')?.state,
      { timeout: 30_000 }).toBe('VOUCHER_CREATED');
    await reload(page);
    await page.locator('.ptt-panel .ptt-trigger').click();
    await page.locator('.ptt-panel .ptt-menu-item').filter({ hasText: 'Hợp đồng & quyết toán' }).click();
    const refreshed = page.locator('.cs-wrap');
    await refreshed.getByRole('button', { name: /Cần rà soát/ }).click();
    await expect(refreshed.getByLabel('Lỗi tạo hoa hồng / thưởng Sale').getByText(`${marker}-0`)).toHaveCount(0);
    assert.equal(await voucherCount(ids[0], 'broker'), 1);
    report.checks.push('Cần rà soát Tạo lại executed saved TEST request; exactly one voucher and queue cleared after reload');
  } else {
  await go(page, `/contracts/${ids[0]}`);
  await expect(detail.getByRole('button', { name: 'Tạo lại' })).toBeVisible({ timeout: 30_000 });
  await detail.getByRole('button', { name: 'Tạo lại' }).click();
  await expect.poll(async () => voucherCount(ids[0], 'broker'), { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await list(ids[0])).find(row => row.kind === 'broker')?.state,
    { timeout: 30_000 }).toBe('VOUCHER_CREATED');
  await reload(page);
  await expect(detail.getByRole('alert')).toHaveCount(0);
  assert.equal(await voucherCount(ids[0], 'broker'), 1);
  report.checks.push('Direct Tạo lại used saved request after repair; exactly one real voucher, queue cleared after reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, `/contracts/${ids[1]}`);
  await expect(detail.getByRole('button', { name: 'Tạo phiếu hoa hồng' })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await go(page, '/contracts');
  await expect(page.getByRole('region', { name: 'Theo dõi hoa hồng và thưởng Sale' })).toHaveCount(0);
  report.checks.push('Mobile detail action and list placement checked');
  await go(page, `/contracts/${ids[1]}`);
  await detail.getByRole('button', { name: 'Tạo phiếu hoa hồng' }).click();
  const mobileModal = page.getByRole('dialog', { name: 'Tạo phiếu chi hoa hồng' });
  await expect(mobileModal.getByRole('button', { name: 'Tạo phiếu chi' })).toBeEnabled({ timeout: 30_000 });
  await mobileModal.locator('input[inputmode="numeric"][placeholder="0"]').first().fill('1000');
  await mobileModal.locator('input[inputmode="numeric"][placeholder="0"]').first().blur();
  let lostReceipt;
  await page.route('**/rest/v1/rpc/execute_commission_request_v1', async route => {
    const body = route.request().postDataJSON();
    if (body.p_contract_id !== ids[1]) return route.continue();
    injectedFailure = 'lost-response'; expectedExecuteRequests.add(route.request());
    const response = await route.fetch(); lostReceipt = await response.json();
    return route.abort('failed');
  });
  await mobileModal.getByRole('button', { name: 'Tạo phiếu chi' }).click();
  await expect.poll(async () => voucherCount(ids[1], 'broker'), { timeout: 30_000 }).toBe(1);
  assert.equal(lostReceipt?.status, 'COMPLETED');
  await mobileModal.getByRole('button', { name: 'Để xử lý sau' }).click();
  injectedFailure = null;
  await reload(page);
  await expect.poll(async () => (await list(ids[1])).find(row => row.kind === 'broker')?.state,
    { timeout: 30_000 }).toBe('VOUCHER_CREATED');
  await expect(detail.getByRole('button', { name: 'Tạo phiếu hoa hồng' })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await expect(detail.getByText(/Đã có phiếu/)).toBeVisible({ timeout: 30_000 });
  const saved = await db.query("select request_id from public.contract_commission_requests where contract_id=$1 and kind='broker' limit 1", [ids[1]]);
  const replay = await rpc('execute_commission_request_v1',
    { p_organization_id: ORG, p_contract_id: ids[1], p_kind: 'broker', p_request_id: saved.rows[0].request_id });
  assert.equal(replay.status, 200); assert.equal(replay.json.id, lostReceipt.id);
  assert.equal(await voucherCount(ids[1], 'broker'), 1);
  report.checks.push('Lost after-commit response: reload shows existing voucher, direct server replay returns same receipt and one voucher');
  await shot(page, 'task-2-lost-response-mobile');
  }
  assert.equal(report.blockedProduction.length, 0, 'browser attempted production Supabase access');
  await settle(page);
  await Promise.all(networkJobs);
  assert.deepEqual(report.unexpectedNetwork, [], 'unexpected HTTP or network errors');
  assert.deepEqual(report.console, [], 'unexpected console errors');
} catch (error) { report.failure = error.message; report.failureUrl = activePage?.url();
  if (activePage) await shot(activePage, 'task-2-e2e-failure').catch(() => {});
  process.exitCode = 1; }
finally {
  if (browser) { for (const guard of navigationGuards.values()) guard.snapshot('close'); await browser.close(); }
  await Promise.all(networkJobs);
  if (report.unexpectedNetwork.length || report.console.length || report.blockedProduction.length) {
    report.failure ??= 'Unexpected browser errors remain after closing the context'; process.exitCode = 1;
  }
  try {
    await db.query('rollback');
    await db.query('begin'); await db.query('set local session_replication_role=replica');
    const vouchers = (await db.query('select id from public.income_expenses where contract_id=any($1::uuid[])', [ids])).rows.map(row => row.id);
    await db.query('delete from public.income_expense_items where income_expense_id=any($1::uuid[])', [vouchers]);
    await db.query('delete from public.income_expenses where id=any($1::uuid[])', [vouchers]);
    await db.query('delete from public.contract_commission_events where contract_id=any($1::uuid[])', [ids]);
    await db.query('delete from public.contract_commission_requests where contract_id=any($1::uuid[])', [ids]);
    await db.query('delete from public.contracts where id=any($1::uuid[])', [ids]);
    await db.query('delete from public.accounts where id=$1', [repairedAccount]);
    await db.query('commit');
    const residue = await db.query('select count(*)::int n from public.contracts where id=any($1::uuid[])', [ids]);
    assert.equal(residue.rows[0].n, 0); report.cleanup = true;
  } catch (error) { await db.query('rollback'); report.cleanupError = error.message; process.exitCode = 1; }
  await db.end();
  writeFileSync('.superpowers/sdd/2026-09-29-commission-failure-retry/task-2-e2e-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
