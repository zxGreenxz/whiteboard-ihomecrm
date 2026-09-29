#!/usr/bin/env node
// Real TEST contract creation/signing and retained commission popup. No document-byte claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { testConnection, signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
import { createNavigationReadGuard } from './lib/commission-e2e-network.mjs';

const BASE = 'http://127.0.0.1:4186';
const OUT = '.superpowers/sdd/2026-09-29-commission-failure-retry';
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const ctx = await testConnection();
assert.equal(ctx.cred.testRef, 'hzulujxgonszuleqticb');
const email = 'nguyentam@username.ihomecrm.local';
const owner = await signInTest(ctx, email, matKhauTest(ctx.cred.passwordSeed, email));
const db = new pg.Client({ host: ctx.cred.testPoolerHost, port: 5432, user: `postgres.${ctx.cred.testRef}`,
  password: ctx.cred.testDbPassword, database: 'postgres', ssl: { rejectUnauthorized: false } });
await db.connect();
const f = { rooms: [randomUUID(), randomUUID()], customer: randomUUID(), draft: randomUUID(), template: randomUUID(),
  marker: `E2E-POPUP-${Date.now()}`, createdAt: new Date().toISOString() };
const report = { target: ctx.cred.testRef, fixture: f, checks: [], errors: [], network: [], successfulHeadReceipts: [], navigationCancelledReads: [], blockedProduction: [], cleanup: false,
  limitation: 'Draft signing uses synthetic registered DOCX metadata. Actual DOCX bytes/export/download are not validated.' };
let browser, page, navigation;
const networkJobs = [];
const settle = () => page.waitForLoadState('networkidle', { timeout: 30_000 });
const go = async path => { await settle(); if (new URL(page.url()).pathname !== path) {
  navigation.snapshot('spa-route');
  await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
} };
const shot = name => page.screenshot({ path: `${OUT}/${name}.png` });
try {
  assert.equal((await db.query('select ref from test_env.danh_dau limit 1')).rows[0]?.ref, ctx.cred.testRef);
  const scope = await request(ctx, owner.access_token, 'rpc/list_contract_commission_followups_v2',
    { p_organization_id: ORG, p_unresolved_only: false, p_limit: 100 });
  assert.equal(scope.status, 200);
  const source = scope.json.rows.find(row => row.can_manage); assert(source);
  f.building = source.building_id;
  const dates = (await db.query("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text today, ((now() at time zone 'Asia/Ho_Chi_Minh')::date+interval '1 year')::date::text ending, (date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')+interval '1 month -1 day')::date::text billing_end")).rows[0];
  const phone = `09${String(Date.now()).slice(-8)}`, identity = `9${String(Date.now()).slice(-11)}`;
  await db.query('begin');
  await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",
    [JSON.stringify({ sub: owner.user.id, role: 'authenticated' }), owner.user.id]);
  for (const [i, room] of f.rooms.entries()) await db.query("insert into public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) values($1,$2,$3,$4,0,0,'AVAILABLE')",
    [room, ORG, f.building, `${f.marker}-${i}`]);
  await db.query('insert into public.customers(id,organization_id,user_id,full_name,phone,id_number) values($1,$2,$3,$4,$5,$6)',
    [f.customer, ORG, owner.user.id, f.marker, phone, identity]);
  await db.query("insert into public.document_templates(id,organization_id,user_id,code,name,category,type,file_url,file_name,is_active) values($1,$2,$3,$4,$4,'CONTRACT_NEW','lease_contract','e2e/synthetic-only.docx','synthetic-only.docx',true)",
    [f.template, ORG, owner.user.id, f.marker]);
  const payload = { form: { room_id: f.rooms[1], signed_date: dates.today, start_date: dates.today, end_date: dates.ending,
    rent_price: 0, total_deposit: 0, payment_cycle: 'MONTHLY', start_billing_date: dates.today, end_billing_date: dates.billing_end,
    notes: f.marker, discount_months: 0, discount_amount_per_month: 0 },
    customers: [{ id: f.customer, full_name: f.marker, phone, id_number: identity, is_representative: true, notes: null }],
    services: [], use_custom_services: false };
  await db.query('select public.save_contract_draft($1,$2,$3,$4,$5,$6,null,$7)',
    [ORG, f.building, f.rooms[1], payload, f.template, f.draft, randomUUID()]);
  await db.query('commit');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(/https:\/\/[^/]+\.supabase\.co\//, route => {
    if (new URL(route.request().url()).hostname !== `${ctx.cred.testRef}.supabase.co`) {
      report.blockedProduction.push(new URL(route.request().url()).pathname); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.addInitScript(({ org, key, session }) => {
    localStorage.setItem('ihomecrm.selectedOrganizationId', org); localStorage.setItem(key, JSON.stringify(session));
  }, { org: ORG, key: `sb-${ctx.cred.testRef}-auth-token`, session: owner });
  page = await context.newPage();
  navigation = createNavigationReadGuard({ appOrigin: BASE, testOrigin: ctx.url });
  page.on('request', navigation.started); page.on('requestfinished', navigation.finished);
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ text: message.text(), location: message.location().url }); });
  page.on('response', response => { if (response.status() >= 400) report.network.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('requestfailed', failed => { networkJobs.push((async () => {
    navigation.finished(failed);
    const entry = { path: new URL(failed.url()).pathname, method: failed.method(), responseStatus: (await failed.response())?.status(), failure: failed.failure()?.errorText };
    // Chromium reports loadingFailed for this body-less successful HEAD; retain its HTTP receipt.
    const cancelled = navigation.cancelled(failed, entry.failure, entry.responseStatus);
    if (cancelled) report.navigationCancelledReads.push(cancelled);
    else (entry.path === '/rest/v1/notifications' && entry.method === 'HEAD' && entry.responseStatus === 200
      && entry.failure === 'net::ERR_ABORTED' ? report.successfulHeadReceipts : report.network).push(entry);
  })()); });
  navigation.snapshot('goto');
  await page.goto(`${BASE}/contracts`);
  await expect(page.getByRole('tablist', { name: 'Các mục hợp đồng' })).toBeVisible({ timeout: 30_000 });
  await settle();
  // Real new-contract editor, with a zero-money isolated room/customer fixture.
  await page.locator('button.bg-green-500.h-8.w-8').click();
  let editor = page.getByRole('dialog', { name: /Tạo hợp đồng mới/ });
  await expect(editor).toBeVisible();
  await editor.getByRole('combobox').filter({ hasText: 'Chọn toà nhà' }).click();
  await page.getByRole('option', { name: source.building_name, exact: true }).click();
  await editor.getByRole('combobox', { name: /Phòng/ }).click();
  await page.getByRole('option', { name: `${f.marker}-0`, exact: true }).click();
  for (const [name, value] of [['start_date', dates.today], ['end_date', dates.ending]]) {
    await editor.locator(`input[name="${name}"]`).fill(value.split('-').reverse().join('/'));
    await editor.locator(`input[name="${name}"]`).blur();
  }
  await editor.getByRole('button', { name: 'Thêm khách hàng', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Chọn khách hàng' });
  await picker.getByPlaceholder('Tìm theo tên, SĐT, CCCD...').fill(f.marker);
  await picker.getByRole('checkbox').check();
  await picker.getByRole('button', { name: /Xác nhận/ }).click();
  await settle();
  while (await editor.locator('button[title="Xoá dòng"]:visible').count()) await editor.locator('button[title="Xoá dòng"]:visible').first().click();
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click();
  const directResponse = page.waitForResponse(response => response.url().endsWith('/rpc/create_contract_v2'));
  await page.getByRole('dialog', { name: 'Bạn muốn lưu hợp đồng thế nào?' }).getByRole('button', { name: 'Xác nhận ký', exact: true }).click();
  assert.equal((await directResponse).status(), 200);
  const commission = page.getByRole('dialog', { name: 'Tạo phiếu chi hoa hồng' });
  await expect(commission).toBeVisible({ timeout: 30_000 });
  await expect(commission.getByRole('button', { name: 'Tạo phiếu chi', exact: true })).toBeEnabled({ timeout: 30_000 });
  await shot('task-2-direct-create-popup');
  await commission.getByRole('button', { name: 'Để xử lý sau' }).click();
  report.checks.push('Real direct create_contract_v2 from new-contract form retained the commission popup after creation');

  const openDraft = async () => {
    await go('/contracts');
    await page.getByRole('tablist', { name: 'Các mục hợp đồng' }).getByRole('tab', { name: /Hợp đồng nháp/ }).click();
    const row = page.getByRole('region', { name: 'Hợp đồng nháp', exact: true }).locator('div.p-4.flex').filter({ hasText: f.marker });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await row.getByRole('button', { name: 'Sửa nháp', exact: true }).click();
    const form = page.getByRole('dialog', { name: /Tạo hợp đồng mới/ }); await expect(form).toBeVisible(); return form;
  };
  editor = await openDraft(); await settle();
  while (await editor.locator('button[title="Xoá dòng"]:visible').count()) await editor.locator('button[title="Xoá dòng"]:visible').first().click();
  await editor.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  await expect(page.getByText(/Đã lưu bản nháp · phiên bản/)).toBeVisible({ timeout: 30_000 });
  await editor.getByRole('button', { name: 'Hủy', exact: true }).click();
  const draft = (await db.query('select * from public.contract_drafts where id=$1 and organization_id=$2', [f.draft, ORG])).rows[0];
  await db.query(`insert into public.contract_draft_documents(id,draft_id,revision,organization_id,building_id,document_path,template_path,document_sha256,template_sha256,template_snapshot,document_data,created_by)
    values($1,$2,$3,$4,$5,'e2e/synthetic-document.docx','e2e/synthetic-template.docx',$6,$7,$8,$9,$10)`,
    [randomUUID(), f.draft, draft.revision, ORG, f.building, 'a'.repeat(64), 'b'.repeat(64),
      { id: f.template, name: f.marker, updated_at: f.createdAt }, { REPRESENT_NAME: f.marker, REPRESENT_ID_NUMBER: identity }, owner.user.id]);
  // Fixture metadata was registered outside the app; reload source truth rather than reuse its cached draft.
  await settle(); navigation.snapshot('reload'); await page.reload();
  await expect(page.getByRole('tablist', { name: 'Các mục hợp đồng' })).toBeVisible({ timeout: 30_000 });
  editor = await openDraft();
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Bạn muốn lưu hợp đồng thế nào?' }).getByRole('button', { name: 'Xác nhận ký', exact: true }).click();
  const signing = page.getByRole('dialog', { name: 'Xác nhận đã ký và nhận phòng ngay' });
  await expect(signing).toBeVisible({ timeout: 30_000 });
  await signing.getByLabel(/Khách đã ký đúng tài liệu nháp/).check();
  await signing.getByLabel('Phòng đã sẵn sàng và được bàn giao cho khách mới.', { exact: true }).check();
  const signButton = signing.getByRole('button', { name: 'Xác nhận đã ký và nhận phòng', exact: true });
  await expect(signButton).toBeEnabled({ timeout: 30_000 });
  const signResponse = page.waitForResponse(response => response.url().endsWith('/rpc/sign_and_checkin_contract_draft_v1'));
  await signButton.click(); assert.equal((await signResponse).status(), 200);
  await expect(commission).toBeVisible({ timeout: 30_000 });
  await expect(signing).toHaveCount(0);
  await expect(commission.getByRole('button', { name: 'Tạo phiếu chi', exact: true })).toBeEnabled({ timeout: 30_000 });
  await shot('task-2-draft-sign-popup');
  await commission.getByRole('button', { name: 'Để xử lý sau' }).click();
  await settle();
  const contracts = (await db.query('select id from public.contracts where room_id=any($1::uuid[])', [f.rooms])).rows;
  assert.equal(contracts.length, 2);
  assert.equal((await db.query('select count(*)::int n from public.contract_commission_requests where contract_id=any($1::uuid[])', [contracts.map(row => row.id)])).rows[0].n, 0);
  report.checks.push('Saved draft reopened and signed through real RPC; popup retained; closing both popups created no commission request');
  await Promise.all(networkJobs);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.network, []); assert.deepEqual(report.blockedProduction, []);
} catch (error) {
  report.failure = error.message; report.url = page?.url(); if (page) await shot('task-2-popup-failure').catch(() => {}); process.exitCode = 1;
} finally {
  if (browser) { navigation?.snapshot('close'); await browser.close(); }
  await Promise.all(networkJobs);
  if (report.network.length || report.errors.length || report.blockedProduction.length) {
    report.failure ??= 'Unexpected browser errors remain after closing the context'; process.exitCode = 1;
  }
  try {
    await db.query('rollback'); await db.query('begin');
    const contracts = (await db.query('select id from public.contracts where room_id=any($1::uuid[])', [f.rooms])).rows.map(row => row.id);
    const fixtures = [...f.rooms, f.customer, f.draft, f.template, ...contracts];
    const targets = (await db.query(`select n.nspname,c.relname,array_agg(a.attname::text) cols from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
      where n.nspname in ('public','app_private') and c.relkind in ('r','p') and not c.relispartition and a.attnum>0 and not a.attisdropped and a.atttypid='uuid'::regtype
      and a.attname in ('id','contract_id','draft_id','room_id','customer_id','template_id') group by n.nspname,c.relname`)).rows;
    await db.query('set local session_replication_role=replica');
    for (const target of targets) await db.query(`delete from "${target.nspname}"."${target.relname}" where ${target.cols.map(col => `"${col}"=any($1::uuid[])`).join(' or ')}`, [fixtures]);
    for (const target of targets) assert.equal((await db.query(`select count(*)::int n from "${target.nspname}"."${target.relname}" where ${target.cols.map(col => `"${col}"=any($1::uuid[])`).join(' or ')}`, [fixtures])).rows[0].n, 0);
    await db.query('commit'); report.cleanup = true;
  } catch (error) { await db.query('rollback'); report.cleanupError = error.message; process.exitCode = 1; }
  await db.end(); writeFileSync(`${OUT}/task-2-popup-e2e-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
