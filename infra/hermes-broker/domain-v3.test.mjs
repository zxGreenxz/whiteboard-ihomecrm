import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sharedFullRead, changedFunctions, fullReadSql, fullReadFixSql, fullReadParitySql, fullReadOwnerSql, BUILDING, OTHER_BUILDING, ROOM, SCOPE, ORG_SCOPE, binding, USER, ORG, FOREIGN, SESSION,
  CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CUSTOMER_F, CO_TENANT, CONTRACT_A, CONTRACT_B, CONTRACT_F, SERVICE, PHONE_A, CCCD_A, BANK_A, SECRET_IMAGE } from './full-read-sql-fixture.mjs';
import { DOMAIN_READS, DOMAIN_TOOLS, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { CUSTOMER_DETAIL_FIELDS, CONTRACT_DETAIL_FIELDS, PRIVATE_HINT } from './full-read-contract.mjs';
import { randomBytes } from 'node:crypto';
import { ASSISTANT, token } from './finance-fixture.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const code = expected => error => error.code === expected;
// Một PGlite cho cả file; mỗi ca chạy trong BEGIN … ROLLBACK (inCase), đột biến chỉ thay thân hàm trong ca.
let shared;
before(async () => { shared = await sharedFullRead(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
// Ảnh chụp quyền CRM có phạm vi cho từng khoá đã cấp (inScope đóng khi thiếu khoá — P3-8).
const identity = (permission, buildings = [BUILDING, OTHER_BUILDING]) => ({ row: { organizationId: ORG },
  scopesByPermission: Object.fromEntries([].concat(permission).map(key => [key, { buildingIds: buildings }])) });
const list = (extra = {}) => domainInput('customers', extra);
const ids = rows => rows.map(row => row.id).sort();

test('contract: v3 tools are fixed, read-only, keyed on existing permissions, and say private data is for the asker only', () => {
  assert.deepEqual(['customers', 'customer_detail', 'contract_detail'].map(key => [DOMAIN_READS[key].family, DOMAIN_READS[key].permission]),
    [['v3', 'customers.view'], ['v3', 'customers.view'], ['v3', 'contracts.view']]);
  for (const name of ['crm_read_customers', 'crm_read_customer_detail', 'crm_read_contract_detail']) {
    const tool = DOMAIN_TOOLS.find(item => item.name === name);
    assert.ok(tool.description.includes(PRIVATE_HINT), name); assert.equal(tool.annotations.readOnlyHint, true);
    assert.doesNotMatch(tool.description, /hermes_|copilot_|rpc|SELECT/i, name);
  }
  assert.equal(mayUseDomain({ read: ['customers.view'] }, 'customer_detail'), true);
  assert.equal(mayUseDomain({ read: ['contracts.view'] }, 'customer_detail'), false);
  assert.deepEqual(domainInput('customer_detail', { customerId: CUSTOMER_A }), { customerId: CUSTOMER_A });
  for (const bad of [{}, { customerId: 'x' }, { customerId: CUSTOMER_A, organizationId: ORG }, { customerId: CUSTOMER_A, includeImages: true }, null])
    assert.throws(() => domainInput('customer_detail', bad), JSON.stringify(bad));
  assert.throws(() => domainInput('contract_detail', { customerId: CONTRACT_A }));
  assert.throws(() => domainInput('customers', { status: 'ACTIVE' }), 'customers has no status filter');
});

test('SQL customers (v3): full phone, same overlay/CRM scope as v1; Toàn tổ chức also lists customers without a contract', { timeout: 90000 }, t => inCase(async env => {
  const { db, read3, orgWide } = env;
  const first = await read3('customers', list());
  assert.deepEqual(ids(first.items), [CUSTOMER_A, CO_TENANT].sort(), 'building overlay only; foreign org never');
  const a = first.items.find(row => row.id === CUSTOMER_A);
  assert.deepEqual(a, { id: CUSTOMER_A, name: 'Nguyễn Văn An', phone: PHONE_A, contractId: CONTRACT_A, buildingId: BUILDING, roomId: ROOM, roomName: 'P101' });
  assert.deepEqual(domainResult('customers', first, identity('customers.view'), list()), first);
  assert.deepEqual(ids((await read3('customers', list({ query: '4567' }))).items), [CUSTOMER_A], 'phone digits search');
  assert.deepEqual(ids((await read3('customers', list({ query: '090 123' }))).items), [CUSTOMER_A], 'spaced digits');
  assert.deepEqual(ids((await read3('customers', list({ query: 'văn an' }))).items), [CUSTOMER_A]);
  // CRM org-wide alone is not enough: the connection must have selected Toàn tổ chức.
  await db.exec("UPDATE public.fixture_acl SET org_wide=true WHERE permission='customers.view'");
  assert.deepEqual(ids((await read3('customers', list())).items), [CUSTOMER_A, CO_TENANT].sort());
  await db.exec("UPDATE public.fixture_acl SET org_wide=false WHERE permission='customers.view'");
  await orgWide('customers.view');
  assert.deepEqual(ids((await read3('customers', list())).items), [CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CO_TENANT].sort());
  // P2-2: như RLS customers_select_rbac, chủ hồ sơ (customers.user_id) phải là thành viên ACTIVE — kể cả khách có hợp đồng.
  await db.exec(`DELETE FROM public.fixture_visible_owners`);
  assert.deepEqual(ids((await read3('customers', list())).items), [], 'no row without a visible owner');
  await db.exec(`INSERT INTO public.fixture_visible_owners VALUES('${USER}')`);
  assert.deepEqual(ids((await read3('customers', list({ buildingId: BUILDING }))).items), [CUSTOMER_A, CO_TENANT].sort(), 'buildingId drops the org-wide branch');
  const page = await read3('customers', list({ limit: 2 }));
  assert.equal(page.items.length, 2); assert.equal(page.nextCursor, page.items[1].id);
  const rest = await read3('customers', list({ limit: 2, cursor: page.nextCursor }));
  assert.deepEqual([...ids(page.items), ...ids(rest.items)].sort(), [CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CO_TENANT].sort());
}));

test('SQL customer_detail: the /customers/:id fields in full, never images, bank account or fingerprint; out of scope is null', { timeout: 90000 }, t => inCase(async env => {
  const { db, read3, orgWide } = env;
  const result = await read3('customer_detail', { customerId: CUSTOMER_A });
  assert.deepEqual(Object.keys(result).sort(), ['domain', 'fetchedAt', 'item', 'organizationId']);
  const item = result.item;
  assert.deepEqual(Object.keys(item).sort(), Object.keys(CUSTOMER_DETAIL_FIELDS).sort());
  assert.equal(item.phone, PHONE_A); assert.equal(item.idNumber, CCCD_A); assert.equal(item.dateOfBirth, '1990-05-01');
  assert.equal(item.idIssueDate, '2021-04-10'); assert.equal(item.permanentAddress, 'Thôn Đông\nXã Tây, Tỉnh Nam', 'newline kept');
  assert.equal(item.notes, 'khách quen ghi chú', 'control characters dropped');
  assert.deepEqual(item.emergencyContact, { name: 'Trần Thị Bình', phone: '0912345678', relationship: 'Mẹ' });
  assert.deepEqual(item.contracts, [{ id: CONTRACT_A, number: 'HD-A', status: 'ACTIVE', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101',
    startDate: '2026-01-02', endDate: '2027-01-01', rentPrice: '3500000.00', isRepresentative: true }]);
  const raw = JSON.stringify(result);
  for (const secret of [SECRET_IMAGE, BANK_A, 'FP-1', 'VCB', 'PUBLIC-CODE-A']) assert.equal(raw.includes(secret), false, secret);
  const input = domainInput('customer_detail', { customerId: CUSTOMER_A });
  assert.deepEqual(domainResult('customer_detail', result, identity(['customers.view', 'contracts.view']), input), result);
  assert.throws(() => domainResult('customer_detail', result, identity('customers.view'), input), 'P3-8: contracts without a contracts.view scope are refused');
  assert.deepEqual(domainResult('customer_detail', { ...result, item: { ...item, contractsVisible: false, contracts: [] } }, identity('customers.view'), input).item.contracts, []);
  assert.equal(item.contractsVisible, true);
  assert.throws(() => domainResult('customer_detail', result, identity('contracts.view', [OTHER_BUILDING]), input), 'contracts fenced by the contracts.view CRM scope');
  assert.throws(() => domainResult('customer_detail', { ...result, item: { ...item, idImages: SECRET_IMAGE } }, identity('customers.view'), input));
  assert.throws(() => domainResult('customer_detail', { ...result, item: { ...item, id: CUSTOMER_B } }, identity('customers.view'), input));
  assert.throws(() => domainResult('customer_detail', { ...result, organizationId: FOREIGN }, identity('customers.view'), input));
  for (const hidden of [CUSTOMER_B, CUSTOMER_C, CUSTOMER_F, CONTRACT_A])
    assert.equal((await read3('customer_detail', { customerId: hidden })).item, null, hidden);
  await orgWide('customers.view');
  assert.equal((await read3('customer_detail', { customerId: CUSTOMER_C })).item.idNumber, '003200000003');
  assert.equal((await read3('customer_detail', { customerId: CUSTOMER_B })).item.contracts[0].id, CONTRACT_B);
  assert.equal((await read3('customer_detail', { customerId: CUSTOMER_F })).item, null, 'other company stays invisible');
  await db.exec(`UPDATE public.customers SET deleted_at=clock_timestamp() WHERE id='${CUSTOMER_C}'`);
  assert.equal((await read3('customer_detail', { customerId: CUSTOMER_C })).item, null);
}));

test('SQL contract_detail: /contracts/:id terms, deposit, tenants and services; no file, public code or bank data', { timeout: 90000 }, t => inCase(async env => {
  const { db, read3 } = env;
  const result = await read3('contract_detail', { contractId: CONTRACT_A }), item = result.item;
  assert.deepEqual(Object.keys(item).sort(), Object.keys(CONTRACT_DETAIL_FIELDS).sort());
  assert.deepEqual([item.number, item.status, item.rentPrice, item.paymentCycle, item.totalDeposit, item.depositPaid, item.depositRemaining, item.depositDebtMode],
    ['HD-A', 'ACTIVE', '3500000.00', 'MONTHLY', '6000000', '4000000', '2000000', 'DEBT']);
  assert.equal(item.buildingAddress, '12 Lê Lợi, Phường 1, Quận 3, TP HCM'); assert.equal(item.notes, 'Hợp đồng A\ndòng 2');
  assert.deepEqual(item.tenants.map(row => [row.customerId, row.isRepresentative, row.phone, row.idNumber]),
    [[CUSTOMER_A, true, PHONE_A, CCCD_A], [CO_TENANT, false, '0933333333', '001200000001']]);
  assert.deepEqual(item.services, [{ serviceId: SERVICE, name: 'Điện', unit: 'kWh', type: 'ELECTRICITY', pricingType: 'PER_UNIT', unitPrice: '3800', initialReading: '120.5' }]);
  const raw = JSON.stringify(result);
  for (const secret of ['contracts/secret-file.pdf', 'PUBLIC-CODE-A', SECRET_IMAGE, BANK_A]) assert.equal(raw.includes(secret), false, secret);
  const input = domainInput('contract_detail', { contractId: CONTRACT_A });
  assert.deepEqual(domainResult('contract_detail', result, identity(['contracts.view', 'customers.view']), input), result);
  assert.throws(() => domainResult('contract_detail', result, identity('contracts.view'), input), 'P3-8: tenants without a customers.view scope are refused');
  assert.throws(() => domainResult('contract_detail', { ...result, item: { ...item, contractFileUrl: 'x' } }, identity('contracts.view'), input));
  for (const hidden of [CONTRACT_B, CONTRACT_F, CUSTOMER_A]) assert.equal((await read3('contract_detail', { contractId: hidden })).item, null, hidden);
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids=array_append(scope_ids,'${ORG_SCOPE}'::uuid);
    UPDATE app_private.hermes_org_policies SET scope_ids=array_append(scope_ids,'${ORG_SCOPE}'::uuid)`);
  assert.equal((await read3('contract_detail', { contractId: CONTRACT_B })).item.id, CONTRACT_B, 'Toàn tổ chức overlay ∩ CRM buildings');
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='contracts.view'`);
  assert.equal((await read3('contract_detail', { contractId: CONTRACT_B })).item, null, 'CRM building scope still applies');
}));

test('SQL v3 denials: CRM grant, registry, company policy, connection overlay, caller, session and binding versions', { timeout: 90000 }, t => inCase(async env => {
  const { db, read3 } = env;
  const probe = () => read3('customer_detail', { customerId: CUSTOMER_A });
  assert.ok((await probe()).item);
  for (const [label, off, on] of [
    ['CRM grant', "UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'", "UPDATE public.fixture_acl SET allowed=true WHERE permission='customers.view'"],
    ['registry', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.view'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.view'"],
    ['company policy', "UPDATE app_private.hermes_org_policies SET read_capabilities=array_remove(read_capabilities,'customers.view')", "UPDATE app_private.hermes_org_policies SET read_capabilities=read_capabilities||ARRAY['customers.view']"],
    ['connection overlay', "UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')", "UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['customers.view']"],
  ]) {
    await db.exec(off);
    try { await assert.rejects(probe(), code('42501'), label); } finally { await db.exec(on); }
  }
  await assert.rejects(read3('contract_detail', { contractId: CONTRACT_A }, binding, { role: 'anon' }), /permission denied/);
  await assert.rejects(read3('customer_detail', { customerId: CUSTOMER_A }, binding, { actor: FOREIGN }), code('42501'));
  await assert.rejects(read3('customer_detail', { customerId: CUSTOMER_A }, binding, { session: FOREIGN }), code('42501'));
  for (const key of ['expectedEpoch', 'expectedPolicyVersion', 'expectedAuthorizationVersion', 'expectedSessionRevision'])
    await assert.rejects(read3('customer_detail', { customerId: CUSTOMER_A }, { ...binding, [key]: 2 }), code('PT409'), key);
  await assert.rejects(read3('customers', list({ buildingId: OTHER_BUILDING })), code('42501'), 'building outside the overlay');
  for (const [domain, input] of [['customer_detail', { customerId: CUSTOMER_A, extra: 1 }], ['contract_detail', { customerId: CUSTOMER_A }],
    ['nope', { customerId: CUSTOMER_A }], ['customers', { ...list(), status: 'ACTIVE' }]]) await assert.rejects(read3(domain, input), code('22023'), domain);
}));

test('group path untouched: the four full-read migrations define only their own reviewed functions and no group/sale-listing projection', () => {
  const sql = [fullReadSql(), fullReadFixSql(), fullReadParitySql(), fullReadOwnerSql()].join('\n').replace(/--[^\n]*/g, '');
  const created = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z0-9_]+)/gi)].map(match => match[1]).sort();
  assert.ok(created.length > 0);
  for (const name of created) assert.match(name, /^(public\.hermes_(room_pass_upsert_v2|domain_read_v3)|app_private\.hermes_(full_text_v1|full_read_scope_v1|pnl_pending_v1|report_[a-z_]+_v[12]))$/, name);
  assert.doesNotMatch(sql, /hermes_group_|sale_listing|room_read|zalo_broadcast|hermes_capabilities\s+SET|INSERT\s+INTO\s+app_private\.hermes_capabilities/i);
});

test('composition: broker → domain mount → bound user JWT → hermes_domain_read_v3; tools follow the CRM ∩ overlay grant', { timeout: 120000 }, t => inCase(async env => {
  const { db, call } = env, events = [];
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const SQL = { hermes_domain_capabilities_v1: 'SELECT public.hermes_domain_capabilities_v1($1::uuid) result', hermes_domain_capabilities_v2: 'SELECT public.hermes_domain_capabilities_v2($1::uuid) result',
    hermes_domain_read_v3: 'SELECT public.hermes_domain_read_v3($1::jsonb,$2::text,$3::jsonb) result' };
  const fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''), args = JSON.parse(options.body); events.push(name);
    // Họ khoá đợt 2 (20261018000000) vắng trong fixture đợt 1: như SQL chưa deploy (PGRST202).
    if (name === 'hermes_domain_capabilities_v3') return Response.json({ code: 'PGRST202', message: 'missing', details: null, hint: null }, { status: 404 });
    assert.ok(Object.hasOwn(SQL, name), `unexpected RPC ${name}`);
    try { return Response.json(await call(SQL[name], name.includes('capabilities') ? [args.p_organization_id] : [JSON.stringify(args.p_binding), args.p_domain, JSON.stringify(args.p_input)])); }
    catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 }); }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const baseAuth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
      membershipId: USER, authorizationVersion: 1 }, permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createDomainAuthAdapter({ baseAuth, reads: createSupabaseDomainReads({ ...supabase, fetch, dependencyScope }) });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) { return env.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const domains = createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch }).createService();
  // Trần kết quả như server.mjs (65 536 byte): tools/list của kết nối này vượt mặc định 16 KB.
  const broker = createBroker({ authority, domains, dependencyScope, limits: { maxResultBytes: 65_536 },
    audit: async entry => { events.push(`audit:${entry.outcome}`); } });
  const listed = (await broker.listTools(token)).tools.map(tool => tool.name);
  for (const name of ['crm_read_customers', 'crm_read_customer_detail', 'crm_read_contract_detail']) assert.ok(listed.includes(name), name);
  events.length = 0;
  const reply = await broker.callTool(token, 'crm_read_customer_detail', { customerId: CUSTOMER_A });
  const value = JSON.parse(reply.content[0].text);
  assert.equal(value.item.idNumber, CCCD_A); assert.equal(value.item.phone, PHONE_A);
  assert.ok(events.indexOf('audit:prepared') < events.lastIndexOf('hermes_domain_read_v3'), 'final SQL after the audit');
  assert.equal(JSON.stringify(reply).includes(accessToken), false);
  const people = JSON.parse((await broker.callTool(token, 'crm_read_customers', { query: '' })).content[0].text);
  assert.equal(people.items.find(row => row.id === CUSTOMER_A).phone, PHONE_A);
  await assert.rejects(broker.callTool(token, 'crm_read_customer_detail', { customerId: CUSTOMER_A, organizationId: FOREIGN }), code('invalid_request'));
  // Removing the saved Read overlay hides the tools at once.
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(array_remove(read_capabilities,'customers.view'),'contracts.view')");
  const after = (await broker.listTools(token)).tools.map(tool => tool.name);
  assert.equal(after.some(name => ['crm_read_customers', 'crm_read_customer_detail', 'crm_read_contract_detail'].includes(name)), false);
  await assert.rejects(broker.callTool(token, 'crm_read_contract_detail', { contractId: CONTRACT_A }), code('tool_not_available'));
}));

// P1 (review 9aef3a21): như web — người ở chỉ qua customers.view, hợp đồng của khách chỉ
// qua contracts.view (quyền CRM ∩ Read kết nối ∩ toà overlay). Kế toán chỉ có contracts.view.
const PII = [PHONE_A, CCCD_A, '1990-05-01', 'Thôn Đông', 'Công ty X', '0933333333', '001200000001'];
const removeRead = permission => [`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${permission}')`,
  `UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['${permission}']`];
test('P1 contract_detail: an accountant with contracts.view but no customers.view sees terms, never tenant PII', { timeout: 120000 }, t => inCase(async env => {
  const { db, read3 } = env;
  const input = domainInput('contract_detail', { contractId: CONTRACT_A });
  const full = await read3('contract_detail', input);
  assert.deepEqual([full.item.tenantsVisible, full.item.tenants.length], [true, 2]);
  for (const [label, off, on] of [
    ['connection Read without customers.view', ...removeRead('customers.view')],
    ['CRM grant without customers.view', "UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'", "UPDATE public.fixture_acl SET allowed=true WHERE permission='customers.view'"],
    ['registry customers.view off', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.view'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.view'"],
    ['customers.view CRM scope outside the contract building', `UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='customers.view'`,
      `UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid] WHERE permission='customers.view'`],
  ]) {
    await db.exec(off);
    try {
      const value = await read3('contract_detail', input), raw = JSON.stringify(value);
      assert.deepEqual([value.item.id, value.item.number, value.item.rentPrice, value.item.tenantsVisible, value.item.tenants], [CONTRACT_A, 'HD-A', '3500000.00', false, []], label);
      for (const secret of PII) assert.equal(raw.includes(secret), false, `${label}: ${secret}`);
      assert.deepEqual(domainResult('contract_detail', value, identity('contracts.view'), input).item.tenants, []);
    } finally { await db.exec(on); }
  }
  assert.throws(() => domainResult('contract_detail', { ...full, item: { ...full.item, tenantsVisible: false } }, identity('contracts.view'), input),
    'broker refuses tenants marked invisible');
}));
test('P1 customer side: without contracts.view the profile and list keep the customer but drop contracts', { timeout: 120000 }, t => inCase(async env => {
  const { db, read3 } = env;
  const [off, on] = removeRead('contracts.view');
  await db.exec(off);
  try {
    const detail = await read3('customer_detail', { customerId: CUSTOMER_A });
    assert.deepEqual([detail.item.idNumber, detail.item.contractsVisible, detail.item.contracts], [CCCD_A, false, []]);
    assert.equal(JSON.stringify(detail).includes('HD-A'), false);
    const people = await read3('customers', list());
    assert.deepEqual(people.items.map(row => row.contractId), [null, null], 'contractId only with contracts.view');
    // P3-6: phòng/toà gần nhất đi cùng hợp đồng nên cũng cần contracts.view.
    assert.deepEqual(people.items.map(row => [row.buildingId, row.roomId, row.roomName]), [[null, null, null], [null, null, null]]);
  } finally { await db.exec(on); }
  assert.equal((await read3('customers', list())).items.find(row => row.id === CUSTOMER_A).contractId, CONTRACT_A);
}));

const STRANGER = '0e0e0e0e-0000-4000-8000-000000000040';
test('P2-2: a customer whose owner (customers.user_id) is not an active member is hidden in list, profile and tenants, like the web RLS', { timeout: 120000 }, t => inCase(async env => {
  const { db, read3 } = env;
  await db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CO_TENANT}'`);
  assert.deepEqual(ids((await read3('customers', list())).items), [CUSTOMER_A]);
  assert.equal((await read3('customer_detail', { customerId: CO_TENANT })).item, null);
  const contract = (await read3('contract_detail', { contractId: CONTRACT_A })).item;
  assert.deepEqual([contract.tenantsVisible, contract.tenants.map(row => row.customerId)], [true, [CUSTOMER_A]]);
  assert.equal(JSON.stringify(contract).includes('0933333333'), false);
  await db.exec(`INSERT INTO public.fixture_visible_owners VALUES('${STRANGER}')`);
  assert.deepEqual(ids((await read3('customers', list())).items), [CUSTOMER_A, CO_TENANT].sort(), 'owner joins the company: visible again');
  assert.equal((await read3('customer_detail', { customerId: CO_TENANT })).item.id, CO_TENANT);
}));

// Mutation evidence: each mutant removes ONE fence; the same probe that the
// reviewed SQL refuses must then succeed, so the probes are not vacuous.
// Định nghĩa sống của v3 ở file sửa sau review 20261017033630: đột biến nhắm vào đó.
const reviewed = fullReadOwnerSql();
const mutate = (from, to = '') => { assert.equal(reviewed.split(from).length, 2, `anchor: ${from}`); return reviewed.replace(from, to); };
const probes = [
  { name: 'connection overlay building scope', sql: mutate(`  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND state->'buildingIds' ? b.id::text
    AND EXISTS(`, `  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND state->'buildingIds' ? b.id::text
    AND true OR EXISTS(`),
    run: async ({ read3 }) => (await read3('contract_detail', { contractId: CONTRACT_B })).item !== null },
  { name: 'org-wide needs the selected Toàn tổ chức overlay', sql: mutate(`  org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;`, `  org_wide:=state->'orgWide'='true'::jsonb OR overlay_org;`),
    run: async ({ db, read3 }) => {
      await db.exec("UPDATE public.fixture_acl SET org_wide=true WHERE permission='customers.view'");
      return (await read3('customer_detail', { customerId: CUSTOMER_C })).item !== null;
    } },
  { name: 'company isolation of the detail row', sql: mutate(`      WHERE cu.id=v_target AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
        AND (EXISTS(`, `      WHERE cu.id=v_target AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
        AND (true OR EXISTS(`),
    run: async ({ read3 }) => (await read3('customer_detail', { customerId: CUSTOMER_F })).item !== null },
  { name: 'connection Read overlay key', sql: mutate(` OR NOT(permission=ANY(c.read_capabilities))`),
    run: async ({ db, read3 }) => {
      await db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')");
      return (await read3('customer_detail', { customerId: CUSTOMER_A })).item !== null;
    } },
  { name: 'P1 tenants need customers.view', sql: mutate(`      'tenants',CASE WHEN room.building_id=ANY(COALESCE(v_customer_scope,'{}'::uuid[])) THEN`, `      'tenants',CASE WHEN true THEN`),
    run: async ({ db, read3 }) => {
      await db.exec(removeRead('customers.view')[0]);
      return JSON.stringify(await read3('contract_detail', { contractId: CONTRACT_A })).includes(CCCD_A);
    } },
  { name: 'P1 customer contracts need contracts.view', sql: mutate(`AND room.building_id=ANY(v_contract_scope)
        JOIN public.buildings building`, `AND room.building_id=ANY(buildings)
        JOIN public.buildings building`),
    run: async ({ db, read3 }) => {
      await db.exec(removeRead('contracts.view')[0]);
      return (await read3('customer_detail', { customerId: CUSTOMER_A })).item.contracts.length > 0;
    } },
  // crm_read_occupancy (v3) dùng snapshot web trên toà đã giao: bỏ lọc toà ⇒ lộ toà B.
  { name: 'occupancy domain stays inside the connection buildings', sql: mutate(`      WHERE snapshot.building_id=ANY(buildings) AND (cursor_id IS NULL`, `      WHERE true AND (cursor_id IS NULL`)
      .split('public.occupancy_snapshot_v2(public.org_today_v1(c.organization_id),buildings)').join('public.occupancy_snapshot_v2(public.org_today_v1(c.organization_id),NULL)'),
    run: async ({ db, read3 }) => {
      await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='reports_real_estate.occupancy'");
      for (const table of ['hermes_org_policies', 'hermes_connections'])
        await db.exec(`UPDATE app_private.${table} SET read_capabilities=read_capabilities||ARRAY['reports_real_estate.occupancy']`);
      return (await read3('occupancy', domainInput('occupancy', {}))).items.some(row => row.buildingId === OTHER_BUILDING);
    } },
  // P2-2: chủ hồ sơ khách không còn là thành viên ACTIVE ⇒ web không thấy khách (RLS customers).
  { name: 'P2-2 customer list needs a visible owner', sql: mutate(`        AND customer.user_id=ANY(v_owners) AND (latest.id IS NOT NULL OR org_wide)
`, `        AND (latest.id IS NOT NULL OR org_wide)
`),
    run: async ({ db, read3 }) => { await db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CO_TENANT}'`);
      return (await read3('customers', list())).items.some(row => row.id === CO_TENANT); } },
  { name: 'P2-2 customer profile needs a visible owner', sql: mutate(`AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
        AND (EXISTS(`, `AND cu.deleted_at IS NULL
        AND (EXISTS(`),
    run: async ({ db, read3 }) => { await db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CO_TENANT}'`);
      return (await read3('customer_detail', { customerId: CO_TENANT })).item !== null; } },
  { name: 'P2-2 tenants need a visible owner', sql: mutate(`          AND cu.user_id=ANY(v_owners)
        WHERE cc.contract_id=ct.id`, `
        WHERE cc.contract_id=ct.id`),
    run: async ({ db, read3 }) => { await db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CO_TENANT}'`);
      return JSON.stringify(await read3('contract_detail', { contractId: CONTRACT_A })).includes('0933333333'); } },
  { name: 'P3-6 room of the customer list needs contracts.view', sql: mutate(`        'roomName',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN app_private.hermes_domain_text_v1(latest.room_name) END) item`,
    `        'roomName',app_private.hermes_domain_text_v1(latest.room_name)) item`),
    run: async ({ db, read3 }) => { await db.exec(removeRead('contracts.view')[0]);
      return (await read3('customers', list())).items.some(row => row.roomName !== null); } },
];
for (const probe of probes) {
  // Chỉ các hàm khác bản sống, tính ngay khi nạp file (neo sai ⇒ đỏ sớm).
  const changed = changedFunctions(reviewed, probe.sql);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'reviewed SQL refuses'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'mutant breaches');
    });
  });
}
