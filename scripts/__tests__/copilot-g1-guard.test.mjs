import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createG1Guard, initializeG1Browser, safeG1RequestFailure } from '../lib/copilot-g1-guard.mjs';
const actorId = '10000000-0000-4000-8000-000000000001', org = 'dddd0000-0000-4000-8000-000000000001';
const origin = 'https://project.supabase.co', baseUrl = 'https://reviewed-preview.vercel.app';
const req = (path, body = {}, method = 'POST') => ({ url: origin + path, method, body, headers: { 'x-organization-id': org } });

test('model transport admits the shipped exact completion endpoint only for DEMO', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const endpoint = '/functions/v1/llm-proxy/chat/completions';
  assert.equal(guard.allow(req(endpoint)), true);
  for (const request of [req('/functions/v1/llm-proxy'), req(`${endpoint}/extra`), req(endpoint, {}, 'GET'),
    { ...req(endpoint), headers: { 'x-organization-id': actorId } },
    { ...req(endpoint), url: `https://other.example${endpoint}` }])
    assert.equal(guard.allow(request), false, request.url);
});

test('only source-reviewed font and local model discovery reads are admitted', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const fontUrl = readFileSync('index.html', 'utf8').match(/href="(https:\/\/fonts.googleapis.com\/css2[^\"]+)"/)[1];
  const localUrl = readFileSync('src/copilot/ollama.ts', 'utf8').match(/fetchJson\('(http:\/\/localhost:11434\/api\/tags)'/)[1];
  for (const url of [fontUrl, localUrl, 'https://fonts.gstatic.com/s/bevietnampro/v12/fixture.woff2']) {
    assert.equal(guard.allow({ url, method: 'GET' }), true, url);
    assert.equal(guard.allow({ url, method: 'OPTIONS', headers: { 'access-control-request-method': 'GET' } }), true, url);
    assert.equal(guard.allow({ url, method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' } }), false, url);
    assert.equal(guard.allow({ url, method: 'OPTIONS' }), false, url);
  }
  for (const url of [fontUrl, localUrl, 'https://fonts.gstatic.com/s/bevietnampro/v12/fixture.woff2',
    'http://localhost:11434/api/pull', 'http://localhost:11435/api/tags', 'http://127.0.0.1:11434/api/tags',
    'https://fonts.googleapis.com/unknown', 'https://fonts.gstatic.com/s/unreviewed/v1/file.woff2',
    'https://fonts.gstatic.com/upload', 'https://other.example/api/tags']) {
    assert.equal(guard.allow({ url, method: 'POST' }), false, url);
    if (![fontUrl, localUrl, 'https://fonts.gstatic.com/s/bevietnampro/v12/fixture.woff2'].includes(url))
      assert.equal(guard.allow({ url, method: 'GET' }), false, url);
    if (![fontUrl, localUrl, 'https://fonts.gstatic.com/s/bevietnampro/v12/fixture.woff2'].includes(url))
      assert.equal(guard.allow({ url, method: 'OPTIONS', headers: { 'access-control-request-method': 'GET' } }), false, url);
  }
});

test('blocked diagnostics keep method, origin and path but never credentials, queries, fragments or headers', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  guard.allow({ url: 'https://user:PRIVATE@unknown.example:8443/api/tags?token=PRIVATE#PRIVATE', method: 'POST', headers: { authorization: 'Bearer PRIVATE' } });
  assert.deepEqual(guard.counters().blocked, ['POST https://unknown.example:8443/api/tags']);
});

test('request failures retain only vetted net codes and always remain failure diagnostics', () => {
  const r = { ...req('/rest/v1/notifications?token=PRIVATE#PRIVATE', {}, 'HEAD'), headers: { authorization: 'Bearer PRIVATE' } };
  assert.equal(safeG1RequestFailure(r, 'net::ERR_ABORTED'), `HEAD ${origin}/rest/v1/notifications net::ERR_ABORTED`);
  assert.equal(safeG1RequestFailure(r, 'net::ERR_CONNECTION_RESET'), `HEAD ${origin}/rest/v1/notifications net::ERR_CONNECTION_RESET`);
  for (const text of ['PRIVATE provider prose', 'net::ERR_PRIVATE_TOKEN', 'net::ERR_ABORTED PRIVATE', undefined]) {
    const result = safeG1RequestFailure(r, text);
    assert.equal(result.endsWith('g1_network_failure_unknown'), true);
    assert.equal(result.includes('PRIVATE'), false);
  }
});

const countHead = () => ({ ...req('/rest/v1/notifications?user_id=eq.PRIVATE', {}, 'HEAD'), headers: { prefer: 'count=exact' } });
test('same admitted exact-count HEAD can classify only its observed HTTP 200 header-complete abort', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl }), key = {}, r = countHead();
  assert.equal(guard.allow(r, key), true);
  assert.equal(guard.classifyHeadCountAbort(key, 'net::ERR_ABORTED'), false);
  guard.observeHeadCount(key, 200, '*/42');
  assert.equal(guard.classifyHeadCountAbort({}, 'net::ERR_ABORTED'), false);
  assert.equal(guard.classifyHeadCountAbort(key, 'net::ERR_ABORTED'), true);
  assert.equal(guard.classifyHeadCountAbort(key, 'net::ERR_ABORTED'), false);
  const counters = guard.counters();
  assert.equal(counters.headerCompleteCountReadAborts, 1);
  assert.deepEqual(counters.headerCompleteCountReads.map(r => [r.requestOrdinal, r.method, r.origin, r.pathname, r.status, r.code]),
    [[1, 'HEAD', origin, '/rest/v1/notifications', 200, 'net::ERR_ABORTED']]);
  assert.match(counters.headerCompleteCountReads[0].contentRangeDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(counters).includes('PRIVATE'), false);
});

test('HEAD count classification rejects bad headers, statuses, other failures and already finished requests', () => {
  for (const [status, range, code] of [[200, undefined, 'net::ERR_ABORTED'], [200, '*/unknown', 'net::ERR_ABORTED'],
    [200, '*/-1', 'net::ERR_ABORTED'], [200, '*/9007199254740992', 'net::ERR_ABORTED'],
    [200, '0-42/42', 'net::ERR_ABORTED'], [500, '*/42', 'net::ERR_ABORTED'], [206, '0-9/42', 'net::ERR_ABORTED'],
    [200, '*/42', 'net::ERR_CONNECTION_RESET'], [200, '*/42', 'net::ERR_TIMED_OUT']]) {
    const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl }), key = {};
    guard.allow(countHead(), key); guard.observeHeadCount(key, status, range);
    assert.equal(guard.classifyHeadCountAbort(key, code), false, `${status} ${range} ${code}`);
  }
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl }), key = {};
  guard.allow(countHead(), key); guard.observeHeadCount(key, 200, '*/0'); guard.finished(key);
  assert.equal(guard.classifyHeadCountAbort(key, 'net::ERR_ABORTED'), false);
});

test('HEAD classification never promotes POSTs, RPC execution, unknown origins or non-count reads', () => {
  for (const r of [req('/rest/v1/ai_chat_messages'), req('/rest/v1/notifications', {}, 'GET'),
    req('/rest/v1/rpc/get_my_permissions', {}, 'HEAD'), { ...countHead(), url: 'https://other.example/rest/v1/notifications' },
    { ...countHead(), headers: {} }, { ...countHead(), headers: { prefer: 'count=planned' } }]) {
    const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl }), key = {};
    guard.allow(r, key); guard.observeHeadCount(key, 200, '*/42');
    assert.equal(guard.classifyHeadCountAbort(key, 'net::ERR_ABORTED'), false);
  }
});

test('owned chat writes remain pending through response headers and identity readback until requestfinished', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const key = {}, threadId = '20000000-0000-4000-8000-000000000001';
  const creation = req('/rest/v1/ai_chat_threads', { user_id: actorId, organization_id: org, title: 'G1' });
  assert.equal(guard.allow(creation, key), true);
  assert.equal(guard.counters().pendingChatWrites, 1);
  guard.observeThread(creation, { id: threadId }, 201);
  assert.equal(guard.counters().pendingChatWrites, 1);
  guard.finished(key); assert.equal(guard.counters().pendingChatWrites, 0);
  const first = {}, second = {};
  const message = req('/rest/v1/ai_chat_messages', [{ user_id: actorId, organization_id: org, thread_id: threadId, role: 'user', content: 'G1' }]);
  guard.allow(message, first); guard.allow(message, second);
  guard.finished(first); assert.equal(guard.counters().pendingChatWrites, 1);
  guard.finished(second); assert.equal(guard.counters().pendingChatWrites, 0);
  guard.allow(req('/rest/v1/notifications'), {});
  assert.equal(guard.counters().pendingChatWrites, 0);
});

test('mounted route reads use only inspected signatures; overloads and write-like neighbors stay denied', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const reads = {
    get_my_context: {}, get_my_assignments: {}, is_admin: {}, my_org_ids: {},
    get_customer_stats: { p_status: 'ACTIVE', p_search: 'g1', p_building_id: actorId, p_room_id: actorId },
    get_reservation_deposit_summary: { p_building_ids: [actorId] },
    get_held_deposit_summary: { p_building_ids: [actorId], p_threshold: 10000 },
    get_refund_forfeit_summary: { p_building_ids: [actorId] },
    get_meter_reading_stats: { p_building_id: null, p_month: '2026-09' },
    get_meters_without_readings_v2: { p_building_id: actorId, p_room_id: actorId, p_meter_type: 'WATER', p_month: '2026-09' },
    ie_form_buildings: {}, get_acceptance_geofence_config: {},
    list_my_cashbook_access_v2: {}, list_cashbook_visibility_v2: {}, get_finance_v2_client_flags_v1: {},
    zalo_get_crm_summary: { p_conversation_id: actorId },
    get_income_expense_layer_stats: { p_posting: 'UNPOSTED' },
  };
  for (const [name, args] of Object.entries(reads)) {
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, args)), true, name);
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, { ...args, p_write: true })), false, name);
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, args, 'GET')), false, name);
  }
  for (const name of ['mark_overdue_invoices_v1', 'bulk_create_meter_readings', 'approve_meter_reading_v1',
    'create_reservation_deposit_v1', 'set_cashbook_access_v2', 'zalo_sticker_search', 'zalo_mark_read', 'zalo_send_seen', 'zalo_send_typing'])
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`)), false, name);
});

test('voucher eligibility is limited to the mounted first page of UUIDs, and cashbook inbox remains a read', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  for (const name of ['can_flex_cancel_v1', 'can_cancel_income_voucher_v1']) {
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, { p_ids: [actorId] })), true);
    for (const body of [{}, { p_ids: [] }, { p_ids: actorId }, { p_ids: ['invalid'] },
      { p_ids: Array(21).fill(actorId) }, { p_ids: [actorId], p_write: true }])
      assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, body)), false);
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, { p_ids: [actorId] }, 'GET')), false);
  }
  for (const body of [{}, { p_cashbook: null }, { p_cashbook: actorId }])
    assert.equal(guard.allow(req('/rest/v1/rpc/list_cashbook_closings_v1', body)), true);
  for (const body of [{ p_cashbook: 'invalid' }, { p_cashbook: actorId, p_write: true }])
    assert.equal(guard.allow(req('/rest/v1/rpc/list_cashbook_closings_v1', body)), false);
  assert.equal(guard.allow(req('/rest/v1/rpc/list_cashbook_closings_v1', {}, 'GET')), false);
  for (const name of ['flex_cancel_income_expense_v1', 'cancel_income_voucher_v1', 'close_cashbook_v1'])
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, { p_ids: [actorId] })), false);
});

const storageBuckets = ['income-expense-attachments', 'payment-receipts', 'avatars', 'zalo-media'];
test('storage only signs bounded existing object paths through the reviewed batch SDK endpoint', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const body = { expiresIn: 3600, paths: ['owner/fixture image.png'] };
  for (const bucket of storageBuckets) {
    const path = `/storage/v1/object/sign/${bucket}`;
    assert.equal(guard.allow(req(path, body)), true, bucket);
    assert.equal(guard.allow(req(path, { ...body, paths: Array(100).fill('fixture.png') })), true);
    for (const invalid of [{ ...body, expiresIn: 7200 }, { ...body, expiresIn: '3600' },
      { ...body, paths: [] }, { ...body, paths: Array(101).fill('fixture.png') }, { ...body, paths: [null] },
      { ...body, paths: ['../private'] }, { ...body, paths: ['owner/../private'] }, { ...body, paths: ['/absolute'] },
      { ...body, paths: ['https://other.example/object'] }, { ...body, paths: ['owner\\private'] },
      { ...body, paths: ['owner\u0000private'] }, { ...body, paths: ['%2e%2e/private'] },
      { ...body, upsert: true }, { ...body, download: true }])
      assert.equal(guard.allow(req(path, invalid)), false, JSON.stringify(invalid));
    assert.equal(guard.allow(req(`${path}/fixture.png`, { expiresIn: 3600 })), false);
    assert.equal(guard.allow({ ...req(path, body), url: `https://other.example${path}` }), false);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(guard.allow(req(path, body, method)), false);
  }
  for (const path of ['/storage/v1/object/sign/unreviewed', '/storage/v1/object/sign/meter-images', '/storage/v1/object/sign/job-attachments', '/storage/v1/object/upload/sign/avatars',
    '/storage/v1/object/list/avatars', '/storage/v1/object/avatars', '/storage/v1/bucket'])
    assert.equal(guard.allow(req(path, body)), false, path);
});

test('mounted object reads are same-backend known-bucket image/media GETs, never downloads or uploads', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  for (const bucket of storageBuckets) for (const mode of ['sign', 'public']) {
    const path = `/storage/v1/object/${mode}/${bucket}/owner/fixture%20image.png?token=PRIVATE`;
    for (const resourceType of ['image', 'media']) assert.equal(guard.allow({ ...req(path, {}, 'GET'), resourceType }), true);
    for (const resourceType of ['fetch', 'xhr', 'document', undefined])
      assert.equal(guard.allow({ ...req(path, {}, 'GET'), resourceType }), false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      assert.equal(guard.allow({ ...req(path, {}, method), resourceType: 'image' }), false);
  }
  for (const path of ['/storage/v1/object/public/unreviewed/file.png', '/storage/v1/object/authenticated/avatars/file.png',
    '/storage/v1/render/image/public/avatars/file.png', '/storage/v1/object/public/avatars/owner/%252e%252e/private'])
    assert.equal(guard.allow({ ...req(path, {}, 'GET'), resourceType: 'image' }), false, path);
});

test('Zalo CDN reads use the shipped CSP host boundary and image/media resource types only', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  for (const resourceType of ['image', 'media'])
    assert.equal(guard.allow({ url: 'https://avatar.zdn.vn/PRIVATE?token=PRIVATE', method: 'GET', resourceType }), true);
  for (const url of ['https://zdn.vn/PRIVATE', 'https://evilzdn.vn/PRIVATE', 'https://avatar.zdn.vn.evil.example/PRIVATE',
    'http://avatar.zdn.vn/PRIVATE', 'https://avatar.zdn.vn:444/PRIVATE'])
    assert.equal(guard.allow({ url, method: 'GET', resourceType: 'image' }), false, url);
  for (const resourceType of ['fetch', 'xhr', 'script', 'document', undefined])
    assert.equal(guard.allow({ url: 'https://avatar.zdn.vn/PRIVATE', method: 'GET', resourceType }), false);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
    assert.equal(guard.allow({ url: 'https://avatar.zdn.vn/PRIVATE', method, resourceType: 'image' }), false);
});

test('storage and CDN diagnostics omit all object paths and query values', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const requests = [req('/storage/v1/object/sign/payment-receipts/PRIVATE/file.png?token=PRIVATE'),
    req('/storage/v1/object/upload/sign/avatars/PRIVATE.png'),
    { url: 'https://avatar.zdn.vn/PRIVATE/file.png?token=PRIVATE', method: 'POST' }];
  for (const r of requests) {
    assert.equal(guard.allow(r), false);
    assert.equal(safeG1RequestFailure(r, 'net::ERR_FAILED').includes('PRIVATE'), false);
  }
  assert.deepEqual(guard.counters().blocked, [`POST ${origin}/storage/v1/object/sign/payment-receipts`,
    `POST ${origin}/storage/v1/object/upload/sign/avatars`, 'POST https://avatar.zdn.vn']);
});

test('browser bootstrap reuses existing local throttles without executing server or business actions', () => {
  const local = new Map(), session = new Map(), now = 1788969600000;
  vm.runInNewContext(`(${initializeG1Browser.toString()})(input)`, {
    input: { actorId, organizationId: org }, Date: { now: () => now },
    localStorage: { setItem: (key, value) => local.set(key, value) },
    sessionStorage: { setItem: (key, value) => session.set(key, value) },
  });
  assert.deepEqual([...local], [['ihomecrm.selectedOrganizationId', org], [`schedNotif:lastRun:${actorId}`, String(now)]]);
  assert.deepEqual([...session], [['invoices:overdue-checked-at', String(now)]]);
  assert.equal(now - Number(session.get('invoices:overdue-checked-at')) < 10 * 60_000, true);
});
test('allows only reviewed POST read signatures and scoped DEMO identity, never an unknown or financial writer', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  assert.equal(guard.allow(req('/rest/v1/rpc/get_dashboard_summary', { p_building_id: null })), true);
  assert.equal(guard.allow(req('/rest/v1/rpc/copilot_memory_list_v1', { p_organization_id: org })), true);
  for (const request of [req('/rest/v1/rpc/get_dashboard_summary', { dangerous_new_arg: true }),
    req('/rest/v1/rpc/copilot_memory_list_v1', { p_organization_id: actorId }), req('/rest/v1/rpc/get_unknown_safe_read'),
    req('/rest/v1/rpc/copilot_execute_room_pass_active_v1'), req('/rest/v1/notifications', { user_id: actorId }),
    req('/rest/v1/rpc/approve_invoice_v1', {}, 'GET'), req('/rest/v1/profiles', {}, 'PATCH'),
    req('/functions/v1/unknown-function'), { ...req('/rest/v1/notifications'), url: 'https://other.example/rest/v1/notifications' }])
    assert.equal(guard.allow(request), false, request.url);
});
test('only a successfully observed fresh owned chat thread permits chat message persistence', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const threadId = '20000000-0000-4000-8000-000000000001';
  const creation = req('/rest/v1/ai_chat_threads', { user_id: actorId, organization_id: org, title: 'G1' });
  const message = req('/rest/v1/ai_chat_messages', [{ user_id: actorId, organization_id: org, thread_id: threadId, role: 'user', content: 'G1' }]);
  assert.equal(guard.allow(message), false);
  assert.equal(guard.allow(creation), true);
  guard.observeThread(creation, { id: threadId }, 201);
  assert.equal(guard.allow(message), true);
  assert.equal(guard.allow({ ...message, body: [{ ...message.body[0], organization_id: actorId }] }), false);
  assert.equal(guard.allow({ ...creation, body: { ...creation.body, user_id: org } }), false);
});
