import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFullRead, fullReadSql, REPORT_KEYS, BUILDING, OTHER_BUILDING, ORG_SCOPE, binding, ORG, FOREIGN, CONTRACT_A, CONTRACT_B,
  INVOICE_A, INVOICE_B, PENDING, VOUCHER, CONVERSATION, ZALO_PHONE } from './full-read-sql-fixture.mjs';
import { DOMAIN_READS, DOMAIN_TOOLS, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { REPORTS, PRIVATE_HINT } from './full-read-contract.mjs';

// Báo cáo bọc copilot_* (họ v3): khoá ĐÃ CÓ, lọc theo toà đã giao, Toàn tổ chức
// cho hàm không lọc được theo toà, cờ trang báo rõ. Cổng copilot_* là tổng hợp
// cùng chữ ký (full-read-sql-fixture), không chứng minh thân hàm production.
const code = expected => error => error.code === expected;
const identity = permission => ({ row: { organizationId: ORG }, scopesByPermission: { [permission]: { buildingIds: [BUILDING, OTHER_BUILDING] } } });
const setup = (t, options = {}) => setupFullRead(t, { reads: REPORT_KEYS, ...options });
async function run(env, domain, args) {
  const input = domainInput(domain, args), value = await env.read3(domain, input);
  return { value, checked: domainResult(domain, value, identity(DOMAIN_READS[domain].permission), input) };
}
async function orgWideOverlay(db, on = true, crm = on) {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await db.query(on ? `UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)` : `UPDATE app_private.${table} SET scope_ids=array_remove(scope_ids,$1::uuid)`, [ORG_SCOPE]);
  await db.query('UPDATE public.fixture_acl SET org_wide=$1', [crm]);
}

test('contract: one tool per existing permission key, SQL catalog matches the JS table, tools/list fragment stays small', async t => {
  const { db } = await setup(t);
  const expected = { occupancy_report: 'reports_real_estate.occupancy', invoice_report: 'invoices.view', monthly_pnl: 'reports_finance.analysis',
    pending_approvals: 'income_expenses.view', zalo_conversations: 'chat_zalo.view', contract_search: 'contracts.view' };
  assert.deepEqual(Object.fromEntries(Object.entries(REPORTS).map(([key, value]) => [key, value.permission])), expected);
  for (const [domain, { reports, permission }] of Object.entries(REPORTS)) {
    assert.equal(DOMAIN_READS[domain].permission, permission); assert.equal(DOMAIN_READS[domain].family, 'v3');
    assert.ok(mayUseDomain({ read: [permission] }, domain)); assert.equal(mayUseDomain({ read: ['rooms.view'] }, domain), false);
    for (const [name, spec] of Object.entries(reports)) {
      const sql = (await db.query('SELECT app_private.hermes_report_catalog_v1($1,$2) spec', [domain, name])).rows[0].spec;
      assert.deepEqual([sql.permission, sql.source, sql.scope, Boolean(sql.buildingFilter), Boolean(sql.month), Boolean(sql.fromDate), Boolean(sql.toDate),
        Boolean(sql.requiresDates), Boolean(sql.days), sql.statuses ?? null],
      [permission, spec.source, spec.scope, spec.buildingFilter, spec.month, spec.fromDate, spec.toDate, spec.requiresDates, spec.days, spec.statuses ? [...spec.statuses] : null], `${domain}:${name}`);
    }
    assert.equal((await db.query('SELECT app_private.hermes_report_catalog_v1($1,$2) spec', [domain, 'nope'])).rows[0].spec, null);
  }
  const tools = DOMAIN_TOOLS.filter(tool => Object.hasOwn(REPORTS, tool.name.slice(9)));
  assert.equal(tools.length, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < 7000, 'six report tools fit the remaining tools/list budget');
  assert.match(DOMAIN_TOOLS.find(tool => tool.name === 'crm_read_zalo_conversations').description, new RegExp(PRIVATE_HINT));
  for (const bad of [{ report: 'nope' }, { report: 'search', status: 'PAID' }, { report: 'stats', days: 3 }, { report: 'search', month: '2026-13' },
    { report: 'search', limit: 51 }, { report: 'search', offset: -1 }, { report: 'search', query: 'a\nb' }, { report: 'search', organizationId: ORG }])
    assert.throws(() => domainInput('invoice_report', bad), JSON.stringify(bad));
  assert.throws(() => domainInput('monthly_pnl', { fromDate: '2026-01-01' }), 'requires both dates');
  assert.throws(() => domainInput('monthly_pnl', { fromDate: '2025-01-01', toDate: '2026-10-01' }), '≤ 366 days');
  assert.throws(() => domainInput('pending_approvals', { buildingId: BUILDING }), 'organization-only report has no building filter');
});

test('SQL row reports: only the connection buildings, buildingId narrows, paging and amounts as decimal strings', { timeout: 120000 }, async t => {
  const env = await setup(t);
  const snapshot = await run(env, 'occupancy_report', { report: 'snapshot' });
  assert.deepEqual(snapshot.value.items.map(row => row.buildingId), [BUILDING], 'overlay drops OTHER_BUILDING');
  assert.deepEqual([snapshot.value.items[0].occupancyPct, snapshot.value.items[0].missedRevenue, snapshot.value.unavailable], ['50.00', '1500000.00', null]);
  const upcoming = await run(env, 'occupancy_report', { report: 'upcoming', fromDate: '2026-12-15', days: 30 });
  assert.deepEqual(upcoming.value.items.map(row => row.contractId), [CONTRACT_A]);
  assert.equal(upcoming.value.items[0].daysRemaining, 17);
  const search = await run(env, 'invoice_report', { report: 'search', month: '2026-10' });
  assert.deepEqual(search.value.items.map(row => [row.id, row.totalAmount]), [[INVOICE_A, '3500000.00']]);
  const stats = await run(env, 'invoice_report', { report: 'stats', month: '2026-10' });
  assert.deepEqual([stats.value.summary.totalCount, stats.value.summary.totalAmount, stats.value.summary.totalRemaining], [1, '3500000.00', '2500000.00'],
    'stats only over the connection buildings, not the whole CRM scope');
  const pnl = await run(env, 'monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31', limit: 2 });
  assert.deepEqual(pnl.value.items.map(row => row.month), ['2026-08-01', '2026-09-01']); assert.equal(pnl.value.nextOffset, 2);
  const next = await run(env, 'monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31', limit: 2, offset: 2 });
  assert.deepEqual([next.value.items.map(row => row.month), next.value.nextOffset], [['2026-10-01'], null]);
  assert.ok(pnl.value.items.every(row => row.buildingId === BUILDING && row.net === '600000'));
  // The organization-wide overlay sees both buildings; buildingId outside the overlay is refused.
  await assert.rejects(env.read3('invoice_report', domainInput('invoice_report', { report: 'search', buildingId: OTHER_BUILDING })), code('42501'));
  await orgWideOverlay(env.db);
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search' })).value.items.map(row => row.id).sort(), [INVOICE_A, INVOICE_B].sort());
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', buildingId: OTHER_BUILDING })).value.items.map(row => row.id), [INVOICE_B]);
  assert.equal((await run(env, 'invoice_report', { report: 'stats' })).value.summary.totalCount, 2);
});

test('SQL organization-only reports: unavailable without Toàn tổ chức; full data (phone, last message) with it', { timeout: 120000 }, async t => {
  const env = await setup(t);
  for (const [domain, args] of [['pending_approvals', {}], ['zalo_conversations', {}], ['contract_search', {}]]) {
    const { value, checked } = await run(env, domain, args);
    assert.deepEqual([value.unavailable, value.items, value.summary], ['organization_scope_required', [], null], domain);
    assert.equal(checked.unavailable, 'organization_scope_required');
  }
  // Only the overlay matters here: the copilot function enforces the CRM scope of the
  // same key itself, so a building-scoped CRM grant behind a Toàn tổ chức overlay is fine.
  await orgWideOverlay(env.db, true, false);
  const pending = await run(env, 'pending_approvals', {});
  assert.deepEqual(pending.value.items, [{ requestId: PENDING, submissionNo: 1, submittedAt: '2026-10-15T03:04:05.678Z', amount: '2500000', voucherId: VOUCHER,
    voucherCode: 'PC-9', voucherName: 'Sửa máy bơm', voucherType: 'EXPENSE', makerName: 'Kế toán A', stepNo: 1 }]);
  const zalo = await run(env, 'zalo_conversations', { query: 'khách' });
  assert.deepEqual(zalo.value.summary, { conversations: 3, unreadConversations: 1, unreadMessages: 4, pinned: 0 });
  assert.deepEqual([zalo.value.items[0].conversationId, zalo.value.items[0].phone, zalo.value.items[0].lastMessage, zalo.value.items[0].lastMessageAt],
    [CONVERSATION, ZALO_PHONE, 'Anh ơi\nphòng còn không?', '2026-10-16T01:02:03.000Z']);
  const contracts = await run(env, 'contract_search', { status: 'ACTIVE' });
  assert.deepEqual(contracts.value.items.map(row => row.contractId).sort(), [CONTRACT_A, CONTRACT_B].sort());
  // A page flag of copilot_feature_flags that is off/expired is reported, not a vague error.
  await env.db.exec("INSERT INTO public.fixture_disabled_flags VALUES('contract_search')");
  const flagged = await run(env, 'contract_search', {});
  assert.deepEqual([flagged.value.unavailable, flagged.value.items], ['copilot_feature_disabled', []]);
});

test('SQL report denials: CRM grant, registry, connection overlay, caller and other company', { timeout: 120000 }, async t => {
  const env = await setup(t), { db } = env;
  const probe = () => env.read3('invoice_report', domainInput('invoice_report', { report: 'search' }));
  assert.equal((await probe()).items.length, 1);
  for (const [label, off, on] of [
    ['CRM grant', "UPDATE public.fixture_acl SET allowed=false WHERE permission='invoices.view'", "UPDATE public.fixture_acl SET allowed=true WHERE permission='invoices.view'"],
    ['registry', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='invoices.view'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='invoices.view'"],
    ['connection overlay', "UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'invoices.view')", "UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['invoices.view']"],
  ]) { await db.exec(off); try { await assert.rejects(probe(), code('42501'), label); } finally { await db.exec(on); } }
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'chat_zalo.view')");
  await assert.rejects(env.read3('zalo_conversations', domainInput('zalo_conversations', {})), code('42501'));
  await assert.rejects(env.read3('invoice_report', domainInput('invoice_report', { report: 'search' }), binding, { actor: FOREIGN }), code('42501'));
  for (const input of [{ ...domainInput('invoice_report', { report: 'search' }), report: 'drop' }, { ...domainInput('invoice_report', { report: 'search' }), days: 3 },
    { ...domainInput('pending_approvals', {}), buildingId: BUILDING }, (({ offset, ...rest }) => rest)(domainInput('monthly_pnl', { fromDate: '2026-01-01', toDate: '2026-02-01' }))])
    await assert.rejects(env.read3(input.report === 'by_month' || !input.report ? 'monthly_pnl' : input.report === 'inbox' ? 'pending_approvals' : 'invoice_report', input), code('22023'), JSON.stringify(input));
});

test('broker fence: report rows outside the CRM scope, wrong source or forged unavailable reasons are refused', () => {
  const input = domainInput('invoice_report', { report: 'search' });
  const row = { id: INVOICE_A, number: 'INV-A', billingMonth: '2026-10', totalAmount: '1', status: 'APPROVED', buildingId: BUILDING, buildingName: 'Toà A', roomId: INVOICE_B, roomName: 'P' };
  const value = { organizationId: ORG, domain: 'invoice_report', fetchedAt: '2026-10-16T00:00:00.000Z', report: 'search', source: 'crm.copilot_invoice_search_v1',
    unavailable: null, summary: null, items: [row], offset: 0, nextOffset: null, sourceCapped: false };
  assert.deepEqual(domainResult('invoice_report', value, identity('invoices.view'), input).items, [row]);
  for (const bad of [{ ...value, source: 'crm.other' }, { ...value, items: [{ ...row, buildingId: FOREIGN }] }, { ...value, items: [{ ...row, phone: '0900000000' }] },
    { ...value, unavailable: 'organization_scope_required', items: [] }, { ...value, nextOffset: 5 }, { ...value, report: 'stats' }, { ...value, organizationId: FOREIGN }])
    assert.throws(() => domainResult('invoice_report', bad, identity('invoices.view'), input), JSON.stringify(bad).slice(0, 80));
  const narrow = { row: { organizationId: ORG }, scopesByPermission: { 'invoices.view': { buildingIds: [OTHER_BUILDING] } } };
  assert.throws(() => domainResult('invoice_report', value, narrow, input), 'earlier CRM scope fences output');
});

// Mutation evidence for the two report fences.
const reviewed = fullReadSql();
const mutate = (from, to) => { assert.equal(reviewed.split(from).length, 2, `anchor: ${from}`); return reviewed.replace(from, to); };
for (const probe of [
  { name: 'row reports filter by the connection buildings', sql: mutate("        WHERE (e->>'building_id')::uuid=ANY(p_buildings);", '        WHERE true;'),
    run: async env => (await env.read3('invoice_report', domainInput('invoice_report', { report: 'search' }))).items.some(row => row.id === INVOICE_B) },
  { name: 'organization-only reports need Toàn tổ chức', sql: mutate("  IF v_spec->>'scope'='organization' AND NOT COALESCE(p_overlay_org,false) THEN", "  IF false THEN"),
    run: async env => (await env.read3('pending_approvals', domainInput('pending_approvals', {}))).items.length > 0 },
  { name: 'stats receive the connection buildings', sql: mutate('v_raw:=public.get_invoice_statistics_v2(NULL,NULL,NULL,NULL,NULL,v_month,NULL,p_buildings)::jsonb;',
    'v_raw:=public.get_invoice_statistics_v2(NULL,NULL,NULL,NULL,NULL,v_month,NULL,NULL)::jsonb;'),
    run: async env => (await env.read3('invoice_report', domainInput('invoice_report', { report: 'stats' }))).summary.totalCount === 2 },
]) {
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async t => {
    assert.equal(await probe.run(await setup(t)), false, 'reviewed SQL refuses');
    assert.equal(await probe.run(await setup(t, { sql: probe.sql })), true, 'mutant breaches');
  });
}
