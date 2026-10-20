import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setup, readsSql, HOOK_PATH, binding, token, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, UNSELECTED_ORG_SCOPE, USER, ORG, FOREIGN, SESSION, ASSISTANT } from './finance-fixture.mjs';
import { reviewFixesSql } from './review-fixes-fixture.mjs';
import { DOMAIN_READS, DOMAIN_TOOLS, DOMAIN_READ_CAPABILITIES, DOMAIN_READ_CAPABILITIES_V2, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createReadCatalogAuthority } from './read-catalog-authority.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const code = expected => error => error.code === expected;
const V2 = Object.keys(DOMAIN_READS).filter(key => DOMAIN_READS[key].family === 'v2');
const uuid = () => randomUUID();
const sorted = values => [...values].sort();
const identity = (permission, buildings = [BUILDING, OTHER_BUILDING]) => ({ row: { organizationId: ORG }, scopesByPermission: { [permission]: { buildingIds: buildings } } });

// Synthetic, disposable rows only. Amounts are arbitrary fixture numbers.
async function seed(db) {
  const ids = Object.fromEntries(['spend', 'income', 'pnlExpense', 'restricted', 'salary', 'otherBuilding', 'foreignOrg', 'deleted',
    'debt', 'paid', 'draft', 'otherDebt', 'reading', 'otherReading', 'contract', 'otherContract'].map(key => [key, uuid()]));
  // Multi-statement seed: every parameter is a UUID literal generated here.
  const literal = (sql, params) => sql.replace(/\$(\d+)/g, (_, index) => `'${params[Number(index) - 1]}'`);
  await db.exec(literal(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,
      has_restricted_item,salary_staff_id,payer_name,receive_bank_account,notes,kqkd_amount,deleted_at) VALUES
    ($1,$17,$18,'PC1','EXPENSE','Sửa điện',$19,$20,'2026-10-02',150000,'UNAPPROVED',false,null,'Người nhận','0123456789','ghi chú nội bộ',0,null),
    ($2,$17,$18,'PT1','INCOME','Thu tiền phòng',$19,$20,'2026-10-05',2500000,'APPROVED',false,null,null,null,null,2500000,null),
    ($3,$17,$18,'PC2','EXPENSE','Vật tư',$19,null,'2026-10-03',500000,'APPROVED',false,null,null,null,null,500000,null),
    ($4,$17,$18,'PC3','EXPENSE','Hạn chế',$19,null,'2026-10-03',1,'APPROVED',true,null,null,null,null,0,null),
    ($5,$17,$18,'PC4','EXPENSE','Lương',$19,null,'2026-10-03',1,'APPROVED',false,$18,null,null,null,0,null),
    ($6,$17,$18,'PC5','EXPENSE','Toà khác',$21,null,'2026-10-03',1,'APPROVED',false,null,null,null,null,1,null),
    ($7,$22,$18,'PC6','EXPENSE','Lệch tổ chức',$19,null,'2026-10-03',1,'APPROVED',false,null,null,null,null,0,null),
    ($8,$17,$18,'PC7','EXPENSE','Đã xoá',$19,null,'2026-10-03',1,'APPROVED',false,null,null,null,null,1,clock_timestamp());
  INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,notes) VALUES
    ($9,$17,'HD1','APPROVED',$19,$20,'2026-10','2026-10-10',3000000,1000000,'nội bộ'),
    ($10,$17,'HD2','PAID',$19,$20,'2026-09','2026-09-10',3000000,3000000,null),
    ($11,$17,'HD3','DRAFT',$19,$20,'2026-11','2026-11-10',3000000,0,null),
    ($12,$17,'HD4','OVERDUE',$21,$23,'2026-10','2026-10-10',3000000,0,null);
  INSERT INTO public.meter_readings(id,organization_id,reading_code,building_id,room_id,meter_type,settlement_month,reading_date,previous_reading,current_reading,status,notes,meter_image_url) VALUES
    ($13,$17,'CS1',$19,$20,'ELECTRICITY','2026-10','2026-10-01',100,150,'APPROVED','nội bộ','https://example.invalid/a.jpg'),
    ($14,$17,'CS2',$21,$23,'WATER','2026-10','2026-10-01',10,12,'UNAPPROVED',null,null);
  INSERT INTO public.contracts VALUES($15,$17,$20,'ACTIVE',3000000,3000000,0,null,null),($16,$17,$23,'ACTIVE',3000000,0,3000000,null,null);`,
  [ids.spend, ids.income, ids.pnlExpense, ids.restricted, ids.salary, ids.otherBuilding, ids.foreignOrg, ids.deleted, ids.debt, ids.paid, ids.draft, ids.otherDebt,
    ids.reading, ids.otherReading, ids.contract, ids.otherContract, ORG, USER, BUILDING, ROOM, OTHER_BUILDING, FOREIGN, OTHER_ROOM].map(value => {
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new TypeError('seed accepts UUID literals only'); return value; })));
  return ids;
}
const input = (domain, extra = {}) => domainInput(domain, { ...(DOMAIN_READS[domain].requiresDates ? { fromDate: '2026-10-01', toDate: '2026-10-31' } : {}), ...extra });
async function ready(t, options) { const env = await setup(t, options); env.ids = await seed(env.db); return env; }

// Reusable security checks. Mutation tests below prove each one can turn red.
const checks = {
  async projection(env) {
    const vouchers = await env.read('income_expenses', input('income_expenses'));
    assert.deepEqual(sorted(vouchers.items.map(row => row.id)), sorted([env.ids.spend, env.ids.income, env.ids.pnlExpense]),
      'only own-org, overlay-scoped, non-restricted, non-salary, live vouchers');
    assert.equal(JSON.stringify(vouchers).includes('0123456789'), false); assert.equal(JSON.stringify(vouchers).includes('nội bộ'), false);
  },
  async crmScope(env) {
    await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='income_expenses.view'`);
    try { assert.equal((await env.read('income_expenses', input('income_expenses'))).items.length, 0, 'overlay building outside CRM scope'); }
    finally { await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid] WHERE permission='income_expenses.view'`); }
  },
  async revoked(env) {
    await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.view'");
    try { await assert.rejects(env.read('income_expenses', input('income_expenses')), code('42501')); }
    finally { await env.db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='income_expenses.view'"); }
  },
  async registry(env) {
    await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.view'");
    try { await assert.rejects(env.read('income_expenses', input('income_expenses')), code('42501')); }
    finally { await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='income_expenses.view'"); }
  },
  async connection(env) {
    await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'income_expenses.view')");
    try { await assert.rejects(env.read('income_expenses', input('income_expenses')), code('42501')); }
    finally { await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['income_expenses.view']"); }
  },
};

test('v2 contract: registry-driven tools, exact family inputs and fail-closed projections', () => {
  assert.deepEqual(V2.sort(), ['building_profit', 'deposits_held', 'income_expenses', 'meter_readings', 'receivables']);
  assert.equal(DOMAIN_TOOLS.length, Object.keys(DOMAIN_READS).length);
  assert.deepEqual(DOMAIN_READ_CAPABILITIES.length, 8, 'family v1 export unchanged');
  assert.equal(DOMAIN_READS.receivables.permission, 'invoices.view', 'debts reuse the existing CRM invoice permission');
  assert.equal(mayUseDomain({ read: ['invoices.view'] }, 'receivables'), true); assert.equal(mayUseDomain({ read: ['income_expenses.view'] }, 'receivables'), false);
  assert.deepEqual(Object.keys(domainInput('income_expenses', {})).sort(), ['buildingId', 'cursor', 'fromDate', 'limit', 'query', 'status', 'toDate']);
  assert.deepEqual(Object.keys(domainInput('customers', {})).sort(), ['buildingId', 'cursor', 'limit', 'query', 'status'], 'v1 SQL input stays exact');
  for (const [domain, extra] of [['customers', { fromDate: '2026-01-01' }], ['deposits_held', { fromDate: '2026-01-01' }], ['building_profit', {}],
    ['building_profit', { fromDate: '2025-01-01', toDate: '2026-12-31' }], ['income_expenses', { fromDate: '2026-02-30' }], ['income_expenses', { fromDate: '2026-10-02', toDate: '2026-10-01' }],
    ['income_expenses', { status: 'PAID' }], ['receivables', { status: 'DRAFT' }], ['income_expenses', { organizationId: FOREIGN }], ['meter_readings', { table: 'x' }]])
    assert.throws(() => domainInput(domain, extra), `${domain} ${JSON.stringify(extra)}`);
  const row = { id: BUILDING, code: 'PC1', type: 'EXPENSE', name: 'x', buildingId: BUILDING, buildingName: 'Toà A', roomId: null, roomName: null, voucherDate: '2026-10-02', totalAmount: '150000.00', approvalStatus: 'UNAPPROVED' };
  const value = { organizationId: ORG, domain: 'income_expenses', items: [row], nextCursor: null, source: 'crm.income_expenses', fetchedAt: '2026-10-15T01:02:03.004Z' };
  const filtered = input('income_expenses', { status: 'UNAPPROVED', fromDate: '2026-10-01', toDate: '2026-10-31' });
  assert.deepEqual(domainResult('income_expenses', value, identity('income_expenses.view'), filtered), value);
  // Text bound = SQL left(...,200) in code points: 200 emoji (400 UTF-16 units) pass, 201 do not.
  const emoji = { ...value, items: [{ ...row, name: '🏠'.repeat(200) }] };
  assert.deepEqual(domainResult('income_expenses', emoji, identity('income_expenses.view'), filtered), emoji);
  assert.throws(() => domainResult('income_expenses', { ...value, items: [{ ...row, name: '🏠'.repeat(201) }] }, identity('income_expenses.view'), filtered));
  assert.throws(() => domainResult('income_expenses', { ...value, items: [{ ...row, name: 'x'.repeat(201) }] }, identity('income_expenses.view'), filtered));
  for (const changed of [{ ...value, source: 'crm.other' }, { ...value, fetchedAt: 'now' }, { ...value, items: [{ ...row, approvalStatus: 'APPROVED' }] },
    { ...value, items: [{ ...row, voucherDate: '2026-09-30' }] }, { ...value, items: [{ ...row, notes: 'x' }] }, { ...value, items: [{ ...row, totalAmount: 150000 }] }])
    assert.throws(() => domainResult('income_expenses', changed, identity('income_expenses.view'), filtered));
  assert.throws(() => domainResult('income_expenses', value, identity('income_expenses.view', [OTHER_BUILDING]), filtered), 'CRM scope fence');
  const debt = { id: BUILDING, number: null, status: 'APPROVED', buildingId: BUILDING, buildingName: '', buildingCode: null, roomId: ROOM, roomName: null, billingMonth: null, dueDate: null, totalAmount: '1', paidAmount: '1', remainingAmount: '0.00' };
  assert.throws(() => domainResult('receivables', { ...value, domain: 'receivables', source: 'crm.invoices', items: [debt] }, identity('invoices.view'), input('receivables')), 'settled invoice is not a debt');
  const profit = { id: ROOM, buildingId: BUILDING, name: 'x', revenue: '1', expense: '0', net: '1', months: 1 };
  assert.throws(() => domainResult('building_profit', { ...value, domain: 'building_profit', source: 'crm.fa_monthly_pnl', items: [profit] }, identity('reports_finance.analysis'), input('building_profit')), 'per-building row id');
});

test('B2: receivables joins the fixed private read plan with family v2 input and result semantics', () => {
  assert.deepEqual([...FAST_READ_OPERATIONS], ['customers', 'contracts', 'invoices', 'receivables']);
  assert.equal(DOMAIN_READS.receivables.family, 'v2');
  const connection = uuid(), fastInput = domainInput('receivables', { fromDate: '2026-10-01', toDate: '2026-10-31', status: 'OVERDUE' });
  assert.deepEqual(Object.keys(fastInput).sort(), ['buildingId', 'cursor', 'fromDate', 'limit', 'query', 'status', 'toDate'], 'the fast RPC receives the seven v2 keys');
  // The live business statement supplies the output scope; the identity row only fixes actor, company and connection.
  const fastIdentity = { row: { id: connection, userId: USER, organizationId: ORG }, scopesByPermission: {} };
  const debt = { id: uuid(), number: 'HD1', status: 'OVERDUE', buildingId: BUILDING, buildingName: 'Toà A', buildingCode: 'A', roomId: ROOM, roomName: 'P101', billingMonth: '2026-10',
    dueDate: '2026-10-10', totalAmount: '3000000.00', paidAmount: '1000000.00', remainingAmount: '2000000.00' };
  const envelope = { authority: { organizationId: ORG, userId: USER, connectionId: connection, permission: 'invoices.view', buildingIds: [BUILDING], cashbookIds: [] },
    result: { organizationId: ORG, domain: 'receivables', items: [debt], nextCursor: null, source: 'crm.invoices', fetchedAt: '2026-10-20T01:02:03.004Z' } };
  assert.deepEqual(domainFastResult('receivables', envelope, fastIdentity, fastInput), envelope.result);
  for (const [label, change] of [
    ['v1-shaped result without source/fetchedAt', value => { delete value.result.source; delete value.result.fetchedAt; }],
    ['source of another domain', value => { value.result.source = 'crm.income_expenses'; }],
    ['time that is not an instant', value => { value.result.fetchedAt = '2026-10-20'; }],
    ['permission of another domain', value => { value.authority.permission = 'customers.view'; }],
    ['row outside the live building scope', value => { value.authority.buildingIds = [OTHER_BUILDING]; }],
    ['settled invoice', value => { value.result.items[0].remainingAmount = '0.00'; }],
    ['due date outside the requested range', value => { value.result.items[0].dueDate = '2026-11-01'; }],
    ['status outside the requested filter', value => { value.result.items[0].status = 'APPROVED'; }],
    ['private field on the row', value => { value.result.items[0].notes = 'x'; }],
    ['cursor without a full page', value => { value.result.nextCursor = debt.id; value.result.items = []; }],
    // B5c: the building columns are typed when present; a non-text name/code is refused.
    ['building name that is not text', value => { value.result.items[0].buildingName = null; }],
    ['building code that is not text', value => { value.result.items[0].buildingCode = 7; }],
  ]) { const value = structuredClone(envelope); change(value); assert.throws(() => domainFastResult('receivables', value, fastIdentity, fastInput), label); }
  const unnamed = structuredClone(envelope); unnamed.result.items[0].buildingName = ''; unnamed.result.items[0].buildingCode = null;
  assert.deepEqual(domainFastResult('receivables', unnamed, fastIdentity, fastInput), unnamed.result, 'an unnamed building (empty text, null code) is a valid row');
  // Cửa sổ phát hành (SQL và connector không đổi cùng lúc): dòng của SQL trước B5c, không có hai khoá mới, vẫn qua —
  // tolerant một bản phát hành, xem domain-tolerance.test.mjs.
  const preB5c = structuredClone(envelope); delete preB5c.result.items[0].buildingName; delete preB5c.result.items[0].buildingCode;
  assert.deepEqual(domainFastResult('receivables', preB5c, fastIdentity, fastInput), preB5c.result, 'pre-B5c row passes during the release window');
});

test('v2 SQL: five fixed projections on real foundation binding; synthetic CRM ACL ports, no live JWT proof', { timeout: 120000 }, async t => {
  const env = await ready(t), { db, read, ids } = env;
  await t.test('thu chi, công nợ, chỉ số, cọc, lãi lỗ: typed strings, overlay scope, source and time', async () => {
    await checks.projection(env);
    for (const domain of V2) {
      const result = await read(domain, input(domain));
      const permission = DOMAIN_READS[domain].permission;
      assert.deepEqual(domainResult(domain, result, identity(permission), input(domain)), result, domain);
      assert.equal(result.source, DOMAIN_READS[domain].source); assert.ok(Date.parse(result.fetchedAt) > 0);
      for (const item of result.items) assert.equal(item.buildingId, BUILDING, `${domain}: overlay building only`);
    }
    const debts = await read('receivables', input('receivables'));
    assert.deepEqual(debts.items.map(row => [row.id, row.remainingAmount, row.roomName, row.buildingName, row.buildingCode]), [[ids.debt, '2000000.00', 'P101', 'Toà A', null]],
      'B5c: the reserve lane names the building of the debt (code null when the building has none)');
    const readings = await read('meter_readings', input('meter_readings'));
    assert.deepEqual(readings.items.map(row => [row.id, row.consumption, row.buildingName, row.roomName]), [[ids.reading, '50.00', 'Toà A', 'P101']]); assert.equal(JSON.stringify(readings).includes('example.invalid'), false);
    // B5c step 2: vouchers name their building too (room only when the voucher has one).
    const vouchers = await read('income_expenses', input('income_expenses'));
    assert.deepEqual(vouchers.items.map(row => `${row.buildingName}|${row.roomId === null ? String(row.roomName) : 'room'}`).sort(), ['Toà A|null', 'Toà A|room', 'Toà A|room']);
    const deposits = await read('deposits_held', input('deposits_held'));
    assert.deepEqual(deposits.items, [{ id: BUILDING, buildingId: BUILDING, name: 'Toà A', contractCount: 1, expected: '3000000', held: '3000000',
      shortfallAll: '0', shortfallShort: '0', fullCount: 1, shortCount: 0, firstInvoiceCount: 0 }]);
    const profit = await read('building_profit', input('building_profit'));
    assert.deepEqual(profit.items.map(row => [row.id, row.revenue, row.expense, row.net, row.months]), [[BUILDING, '2500000.00', '500000.00', '2000000.00', 1]]);
  });
  await t.test('filters are applied server-side: status, date range, building and literal query', async () => {
    assert.deepEqual((await read('income_expenses', input('income_expenses', { status: 'UNAPPROVED' }))).items.map(row => row.id), [ids.spend]);
    assert.deepEqual(sorted((await read('income_expenses', input('income_expenses', { fromDate: '2026-10-03' }))).items.map(row => row.id)), sorted([ids.income, ids.pnlExpense]));
    assert.equal((await read('income_expenses', input('income_expenses', { query: '%_' }))).items.length, 0);
    assert.equal((await read('building_profit', input('building_profit', { fromDate: '2026-11-01', toDate: '2026-11-30' }))).items.length, 0);
    await assert.rejects(read('income_expenses', input('income_expenses', { buildingId: OTHER_BUILDING })), code('42501'));
    const first = await read('income_expenses', input('income_expenses', { limit: 1 }));
    assert.equal(first.items.length, 1); assert.equal(first.nextCursor, first.items[0].id);
  });
  await t.test('invalid shapes, roles, actor, provider session and binding versions fail closed', async () => {
    for (const [domain, bad] of [['building_profit', { ...input('building_profit'), fromDate: null }], ['building_profit', { ...input('building_profit'), fromDate: '2025-01-01' }],
      ['deposits_held', { ...input('deposits_held'), fromDate: '2026-10-01' }], ['income_expenses', { ...input('income_expenses'), status: 'PAID' }],
      ['income_expenses', { ...input('income_expenses'), fromDate: '2026-02-30' }], ['receivables', { ...input('receivables'), status: 'DRAFT' }]])
      await assert.rejects(read(domain, bad), code('22023'), `${domain} ${JSON.stringify(bad)}`);
    await assert.rejects(read('income_expenses', domainInput('customers', {})), code('22023'), 'v1 shape is not accepted by v2');
    for (const role of ['anon', 'service_role']) await assert.rejects(read('income_expenses', input('income_expenses'), binding, { role }), /permission denied/);
    await assert.rejects(read('income_expenses', input('income_expenses'), binding, { actor: FOREIGN }), code('42501'));
    await assert.rejects(read('income_expenses', input('income_expenses'), binding, { session: FOREIGN }), code('42501'));
    for (const key of ['connectionId', 'expectedMembershipId', 'expectedEpoch', 'expectedPolicyVersion', 'expectedAuthorizationVersion', 'expectedSessionRevision'])
      await assert.rejects(read('income_expenses', input('income_expenses'), { ...binding, [key]: typeof binding[key] === 'number' ? 2 : FOREIGN }), code('PT409'));
  });
  await t.test('CRM scope, revoked CRM grant, registry, connection overlay and offboarding all deny', async () => {
    await checks.crmScope(env); await checks.revoked(env); await checks.registry(env); await checks.connection(env);
    await db.query('INSERT INTO public.fixture_offboarded VALUES($1)', [USER]);
    await assert.rejects(read('income_expenses', input('income_expenses')), code('42501'));
    await db.exec('DELETE FROM public.fixture_offboarded');
    await db.exec(`UPDATE public.authorization_scopes SET building_id='${OTHER_BUILDING}'`);
    assert.equal((await read('meter_readings', input('meter_readings'))).items.map(row => row.buildingId).every(id => id === OTHER_BUILDING), true);
    await db.exec(`UPDATE public.authorization_scopes SET building_id='${BUILDING}'`);
    await db.exec('UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()');
    await assert.rejects(read('income_expenses', input('income_expenses')), code('42501'));
  });
});

test('v2 SQL mutations: removing overlay, CRM scope, org, restricted, permission, registry or connection checks turns a check red', { timeout: 300000 }, async t => {
  // The applied v2 file with the live B5c body of hermes_domain_read_v2 swapped in (finance-fixture.readsSql).
  const candidate = readsSql();
  for (const [label, before, after, check] of [
    ['unselected overlay scope accepted', 'WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id', 'WHERE scope.organization_id=c.organization_id', 'projection'],
    ['building overlay matches any building', "(scope.scope_type='BUILDING' AND scope.building_id=b.id)", "scope.scope_type='BUILDING'", 'projection'],
    ['CRM building scope ignored', "AND state->'buildingIds' ? b.id::text", '', 'crmScope'],
    ['organization filter dropped', 'WHERE ie.organization_id=c.organization_id AND', 'WHERE', 'projection'],
    ['restricted vouchers exposed', 'AND NOT COALESCE(ie.has_restricted_item,true)', '', 'projection'],
    ['revoked CRM grant becomes empty success', "IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR", 'IF false OR', 'revoked'],
    ['registry kill switch ignored', "h.capability=permission AND h.mode='read' AND h.enabled", 'true', 'registry'],
    ['connection read restriction ignored', 'OR NOT(permission=ANY(c.read_capabilities))', '', 'connection'],
  ]) {
    await t.test(label, async t2 => {
      assert.ok(candidate.includes(before), `mutation applies: ${label}`);
      const env = await ready(t2, { reads: candidate.replace(before, after) });
      // Killed only by the security assertion itself, never by a SQL/setup error.
      // The unmutated file passes every check in the SQL test above.
      await assert.rejects(checks[check](env), { code: 'ERR_ASSERTION' }, `${label} must be detected by ${check}`);
    });
  }
});

test('finance options hook adds only enabled registry choices and permitted scopes; context needs restriction, ceiling and connection scope', { timeout: 120000 }, async t => {
  const env = await setup(t, { hook: readFileSync(HOOK_PATH, 'utf8'), fixes: reviewFixesSql() }), { db, call } = env;
  const extend = (value, kind) => call('SELECT app_private.hermes_finance_extend_options_v1($1::jsonb,$2::text) result', [JSON.stringify(value), kind], { role: 'postgres' });
  const base = { organizationId: ORG, userId: USER, membershipId: USER, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1, enabled: true,
    read: ['assistant.memory.read'], action: [], scopes: [] };
  const options = await extend(base, 'connection_options');
  assert.deepEqual(sorted(options.read), sorted(['assistant.memory.read', ...DOMAIN_READ_CAPABILITIES_V2]));
  assert.deepEqual(options.action, ['income_expenses.create'], 'approve overlay stays out while its registry row is disabled');
  assert.deepEqual(options.scopes.map(scope => scope.scopeId), [SCOPE]);
  await assert.rejects(call('SELECT app_private.hermes_finance_extend_options_v1($1::jsonb,$2::text) result', [JSON.stringify(base), 'connection_options']), /permission denied/);
  const org = await extend({ ...base, choices: { read: [], action: [], scopes: [] } }, 'org_options');
  assert.deepEqual(sorted(org.choices.read), sorted(DOMAIN_READ_CAPABILITIES_V2)); assert.deepEqual(org.choices.action, ['income_expenses.create']);
  const contextOf = scopeIds => ({ ...base, scopeIds, restrictions: { read: ['income_expenses.view'], action: ['income_expenses.create'] },
    companyCeilings: { read: DOMAIN_READ_CAPABILITIES_V2, action: ['income_expenses.create'] }, effective: { read: [], action: [] } });
  const context = await extend(contextOf([SCOPE]), 'context');
  assert.deepEqual(context.effective, { read: ['income_expenses.view'], action: ['income_expenses.create'] });
  // Review fix P3b: effective also needs the connection's own saved scope (as the task hooks).
  for (const scopeIds of [[], [UNSELECTED_ORG_SCOPE]])
    assert.deepEqual((await extend(contextOf(scopeIds), 'context')).effective, { read: [], action: [] }, JSON.stringify(scopeIds));
  assert.deepEqual((await extend({ ...contextOf([SCOPE]), scopeIds: undefined }, 'context')).effective, { read: [], action: [] }, 'missing scopeIds fails closed');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.view'");
  assert.equal((await extend(base, 'connection_options')).read.includes('income_expenses.view'), false, 'revoked CRM grant is not offered');
  await db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='income_expenses.view'");
  await db.exec("UPDATE app_private.hermes_org_policies SET scope_ids='{}'");
  const none = await extend(base, 'connection_options');
  assert.deepEqual(none.read, base.read); assert.deepEqual(none.action, []); assert.deepEqual(none.scopes, []);
  assert.deepEqual(await extend({ ...base, enabled: false }, 'connection_options'), { ...base, enabled: false });
  await assert.rejects(extend({ ...base, policyVersion: 2 }, 'connection_options'), code('PT409'));
});

test('review fix P3b mutation: dropping the connection-scope condition lets context grant an unscoped key', { timeout: 120000 }, async t => {
  const fixes = reviewFixesSql(), anchor = "AND result->'scopeIds' ? scope.id::text AND (";
  assert.ok(fixes.includes(anchor), 'mutation applies');
  const env = await setup(t, { hook: readFileSync(HOOK_PATH, 'utf8'), fixes: fixes.replace(anchor, 'AND (') });
  const context = await env.call('SELECT app_private.hermes_finance_extend_options_v1($1::jsonb,$2::text) result', [JSON.stringify({
    organizationId: ORG, userId: USER, membershipId: USER, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1, scopeIds: [],
    restrictions: { read: ['income_expenses.view'], action: [] }, companyCeilings: { read: DOMAIN_READ_CAPABILITIES_V2, action: [] },
    effective: { read: [], action: [] } }), 'context'], { role: 'postgres' });
  assert.deepEqual(context.effective.read, ['income_expenses.view'], 'the unmutated fix denies this exact input (test above)');
});

test('domain mount routes v2 tools to the v2 RPC with the bound user JWT and merges both capability families', { timeout: 120000 }, async t => {
  const env = await ready(t), { db, call } = env, events = [];
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const sql = { '/rest/v1/rpc/hermes_domain_capabilities_v1': 'SELECT public.hermes_domain_capabilities_v1($1::uuid) result',
    '/rest/v1/rpc/hermes_domain_capabilities_v2': 'SELECT public.hermes_domain_capabilities_v2($1::uuid) result',
    '/rest/v1/rpc/hermes_domain_read_v2': 'SELECT public.hermes_domain_read_v2($1::jsonb,$2::text,$3::jsonb) result' };
  const fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken); assert.equal(options.redirect, 'error');
    const name = new URL(url).pathname, args = JSON.parse(options.body); events.push(name);
    // Họ khoá đợt 2 (20261018000000) là file forward sau, vắng trong fixture v2 này.
    if (name === '/rest/v1/rpc/hermes_domain_capabilities_v3') return Response.json({ code: 'PGRST202', message: 'missing', details: null, hint: null }, { status: 404 });
    assert.ok(Object.hasOwn(sql, name), `unexpected RPC ${name}`);
    try { return Response.json(await call(sql[name], name.includes('capabilities') ? [args.p_organization_id] : [JSON.stringify(args.p_binding), args.p_domain, JSON.stringify(args.p_input)])); }
    catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 }); }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' }, reads = createSupabaseDomainReads({ ...supabase, fetch, dependencyScope });
  const baseAuth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'synthetic-base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
    permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createDomainAuthAdapter({ baseAuth, reads });
  const merged = await auth.readAuthorization({ accessToken, userId: USER, organizationId: ORG, signal: new AbortController().signal });
  for (const key of ['invoices.view', ...DOMAIN_READ_CAPABILITIES_V2]) assert.ok(merged.permissions.read.includes(key), key);
  assert.deepEqual(merged.scopesByPermission['income_expenses.view'].buildingIds, [BUILDING, OTHER_BUILDING].sort());
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) { assert.equal(operation, 'readConnection'); return env.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const service = createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch }).createService(), options = { signal: new AbortController().signal };
  const receipt = await service.prepareDomain(token, 'receivables', {}, options);
  const result = await service.finalizeDomain(token, receipt, options);
  assert.equal(events.at(-1), '/rest/v1/rpc/hermes_domain_read_v2'); assert.equal(result.items.length, 1); assert.equal(result.source, 'crm.invoices');
  const stale = await service.prepareDomain(token, 'income_expenses', {}, options);
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.view'");
  const before = events.filter(name => name.endsWith('read_v2')).length;
  await assert.rejects(service.finalizeDomain(token, stale, options), code('context_changed'));
  assert.equal(events.filter(name => name.endsWith('read_v2')).length, before, 'no data RPC after a permission change');
});

test('B2-2 cached admission: income_expenses keeps hermes_domain_read_v2 with the live seven-key binding; the statement alone refuses a lost grant (42501) and a moved session (PT409); a changed snapshot re-resolves', { timeout: 120000 }, async t => {
  const env = await ready(t), { db, call } = env, events = [], bindings = [];
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const sql = { '/rest/v1/rpc/hermes_domain_capabilities_v1': 'SELECT public.hermes_domain_capabilities_v1($1::uuid) result',
    '/rest/v1/rpc/hermes_domain_capabilities_v2': 'SELECT public.hermes_domain_capabilities_v2($1::uuid) result',
    '/rest/v1/rpc/hermes_domain_read_v2': 'SELECT public.hermes_domain_read_v2($1::jsonb,$2::text,$3::jsonb) result' };
  const fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    const name = new URL(url).pathname, args = JSON.parse(options.body); events.push(name);
    if (name === '/rest/v1/rpc/hermes_domain_capabilities_v3') return Response.json({ code: 'PGRST202', message: 'missing', details: null, hint: null }, { status: 404 });
    assert.ok(Object.hasOwn(sql, name), `unexpected RPC ${name}`);
    if (name.endsWith('read_v2')) bindings.push(args.p_binding);
    try { return Response.json(await call(sql[name], name.includes('capabilities') ? [args.p_organization_id] : [JSON.stringify(args.p_binding), args.p_domain, JSON.stringify(args.p_input)])); }
    catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 }); }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' }, reads = createSupabaseDomainReads({ ...supabase, fetch, dependencyScope });
  let verifications = 0;
  const baseAuth = { async verifySession() { verifications++; return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'synthetic-base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
    permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createDomainAuthAdapter({ baseAuth, reads });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) { assert.equal(operation, 'readConnection'); return env.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const readAuthority = createReadCatalogAuthority({ authority: createDurableAuthority({ connectionStore, crypto, auth }), connectionStore });
  const service = createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, readAuthority }).createService(), options = { signal: new AbortController().signal };
  assert.ok(service.cachedReadOperations.includes('income_expenses')); assert.ok(service.fastReadOperations.includes('receivables'));
  const run = async () => { const receipt = await service.prepareDomain(token, 'income_expenses', {}, options); return service.finalizeDomain(token, receipt, options); };
  const first = await run();
  assert.deepEqual(sorted(first.items.map(row => row.id)), sorted([env.ids.spend, env.ids.income, env.ids.pnlExpense]));
  assert.equal(events.at(-1), '/rest/v1/rpc/hermes_domain_read_v2'); assert.deepEqual(bindings.at(-1), binding, 'the seven keys of the full lane, read from the live snapshot');
  const cold = verifications; assert.equal(cold, 1, 'one catalog resolve');
  await run(); await run();
  assert.equal(verifications, cold, 'warm reads: no provider verification, no second authority build');
  assert.equal(bindings.length, 3);
  // Grant lost between prepare and finalize: the full lane answered context_changed before any RPC (test above);
  // here the reviewed statement itself is asked and answers 42501 ⇒ forbidden.
  const stale = await service.prepareDomain(token, 'income_expenses', {}, options);
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.view'");
  await assert.rejects(service.finalizeDomain(token, stale, options), code('forbidden'));
  assert.equal(bindings.length, 4, 'the statement decided');
  await db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='income_expenses.view'");
  // Session moved on after prepare: the receipt binds revision 1, SQL sees 2 ⇒ PT409 ⇒ context_changed.
  const moved = await service.prepareDomain(token, 'income_expenses', {}, options);
  await db.exec('UPDATE app_private.hermes_sessions SET revision=2');
  await assert.rejects(service.finalizeDomain(token, moved, options), code('context_changed'));
  assert.equal(bindings.at(-1).expectedSessionRevision, 1);
  // The persisted snapshot changed, so the next read misses the catalog, resolves again and binds revision 2.
  const next = await run();
  assert.equal(next.items.length, 3); assert.equal(verifications, cold + 1); assert.equal(bindings.at(-1).expectedSessionRevision, 2);
  assert.deepEqual(bindings.at(-1), { ...binding, expectedSessionRevision: 2 });
});
