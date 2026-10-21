import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createReadNameResolver, matchBuildings, ROOM_MATCH_LIMIT, ROOM_FILTER_PAGE_LIMIT, ROOM_FILTER_MAX_PAGES, DIRECTORY_RPCS } from './read-name-resolution.mjs';
import { DOMAIN_READS, DOMAIN_SUMMARIES, DOMAIN_TOOLS, READ_NAMES, READ_NAME_LIMITS, domainInput, splitReadNames, summarizeRows } from './domain-contract.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createReadCatalogAuthority } from './read-catalog-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { W2 } from './wave2-registry.mjs';

// B5d (21/10/2026): tên toà/phòng → ID ở connector. Không PostgreSQL ở đây (hai hàm danh bạ dưới RLS:
// name-directory-sql.test.mjs); file này chứng minh hợp đồng phía connector: tách tên trước validator,
// khớp bằng/chứa/hoa thường/mã, 0 và ≥2 toà ⇒ lỗi mang chi tiết, phòng trùng tên ở nhiều toà như web
// (≤5 gộp, hơn thì hỏi lại), cache theo contextVersion, kế hoạch lọc hàng nhiều trang, và đường đi thật
// qua bound-user-operation + domain mount (JWT người hỏi, RPC danh bạ, p_input đã thay ID).
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG, A, B, C, V, CONNECTION, ASSISTANT, USER, SESSION, CREDENTIAL, MEMBER, SCOPE] = Array.from({ length: 12 }, (_, n) => id(n + 1));
const R = n => id(100 + n);
const DIGEST = 'd'.repeat(64), VERSION = 'c'.repeat(64);
const code = expected => error => error instanceof BrokerError && error.code === expected;
const unresolved = pattern => error => error instanceof BrokerError && error.code === 'read_name_unresolved' && pattern.test(error.detail);
const BUILDINGS = [{ id: A, name: 'Toà 950NK', code: '950NK' }, { id: B, name: 'London Garden', code: null }, { id: C, name: 'London Park', code: 'LP' }];
const ROOMS = [{ id: R(1), name: 'London 5', code: null, floor: 5, buildingId: A }, { id: R(2), name: 'London 50', code: null, floor: 5, buildingId: A },
  { id: R(3), name: 'London 5', code: null, floor: 5, buildingId: B }, { id: R(4), name: 'Studio 1', code: 'L5', floor: 1, buildingId: C },
  ...[5, 6, 7, 8, 9, 10].map(n => ({ id: R(n), name: `P${n}`, code: null, floor: 1, buildingId: C })), { id: R(11), name: 'P55', code: null, floor: 5, buildingId: B },
  ...[1, 2, 3, 4, 5, 6].map(n => ({ id: R(20 + n), name: `Căn ${n}`, code: null, floor: 2, buildingId: C }))];
const fold = value => value.toLowerCase().trim();
const buildingName = buildingId => BUILDINGS.find(row => row.id === buildingId).name;
// Cùng luật với SQL: khớp bằng (tên/mã) trước, không có thì chứa; chỉ trong các toà đã cho; sắp theo tên toà, tên phòng, id.
const directoryRooms = ({ p_building_ids, p_room_name }) => {
  const needle = fold(p_room_name), pool = ROOMS.filter(room => p_building_ids.includes(room.buildingId));
  const exact = pool.filter(room => fold(room.name) === needle || (room.code !== null && fold(room.code) === needle));
  const found = exact.length ? exact : pool.filter(room => fold(room.name).includes(needle) || (room.code !== null && fold(room.code).includes(needle)));
  return found.sort((x, y) => buildingName(x.buildingId).localeCompare(buildingName(y.buildingId)) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
};
function fakeRpc(calls = []) {
  return async (name, accessToken, args, { signal }) => {
    assert.ok(signal instanceof AbortSignal); calls.push({ name, accessToken, args: structuredClone(args) });
    if (name === 'hermes_building_directory_v1') return { buildings: BUILDINGS.filter(row => args.p_building_ids.includes(row.id)) };
    if (name === 'hermes_room_directory_v1') return { rooms: directoryRooms(args) };
    if (name === 'hermes_organization_name_v1') return { id: args.p_organization_id, name: 'Công ty Thử' };
    throw new Error(`unexpected rpc ${name}`);
  };
}
const identityOf = (keys, buildingIds = [A, B, C], contextVersion = VERSION) => ({ row: { id: CONNECTION, organizationId: ORG, userId: USER }, contextVersion,
  effective: { read: keys, action: [] }, scopesByPermission: Object.fromEntries(keys.map(key => [key, { buildingIds, cashbookIds: [] }])) });
const KEYS = [...new Set(Object.values(DOMAIN_READS).flatMap(definition => definition.family === 'w2' ? [...W2.permissions] : [definition.permission]))];
const signal = new AbortController().signal;
const setup = (overrides = {}) => {
  const calls = [], clock = { now: 1_800_000_000_000 };
  const resolver = createReadNameResolver({ rpc: fakeRpc(calls), clock: () => clock.now, ...overrides });
  // Like the broker: a validated input when it passes, the model's own when only the resolved names can make it pass.
  const prepared = (operation, input) => { try { return domainInput(operation, input); } catch { return input; } };
  const resolve = (operation, input, names, options = {}) => resolver.resolve({ operation, input: prepared(operation, input), names, lane: 'legacy',
    accessToken: 'bearer-fixture', identity: identityOf(KEYS), tokenDigest: DIGEST, signal, ...options });
  return { calls, clock, resolver, resolve };
};

test('splitReadNames: names leave the arguments before the validator; blanks are absence; shape errors throw; nested params for crm_read_report', () => {
  assert.deepEqual(splitReadNames('customers', { query: '', buildingName: ' 950NK ', roomName: '   ', limit: 5 }), { args: { query: '', limit: 5 }, names: { buildingName: '950NK' } });
  assert.deepEqual(splitReadNames('customers', { query: 'An' }), { args: { query: 'An' }, names: null });
  assert.deepEqual(splitReadNames('customers', { buildingName: null, roomName: undefined }), { args: {}, names: null });
  assert.deepEqual(splitReadNames('report', { report: 'rooms', params: { buildingName: 'Toà A', roomName: 'P1', floor: 2 }, limit: 3 }),
    { args: { report: 'rooms', params: { floor: 2 }, limit: 3 }, names: { buildingName: 'Toà A', roomName: 'P1' } });
  assert.deepEqual(splitReadNames('report', { report: 'rooms' }), { args: { report: 'rooms' }, names: null });
  for (const bad of [{ buildingName: 12 }, { buildingName: 'x'.repeat(READ_NAME_LIMITS.buildingName + 1) }, { roomName: 'x'.repeat(READ_NAME_LIMITS.roomName + 1) },
    { roomName: 'P1\u0000' }, { buildingName: ['A'] }]) assert.throws(() => splitReadNames('customers', bad), TypeError, JSON.stringify(bad));
  // Tools without names (details, catalogue, zalo, approvals) and non-objects pass through untouched; the validator then decides.
  const detail = { customerId: A, buildingName: 'X' };
  assert.equal(splitReadNames('customer_detail', detail).args, detail);
  assert.equal(splitReadNames('customers', null).args, null);
  assert.throws(() => domainInput('customers', { buildingName: 'X' }), /invalid_domain_contract/, 'validator still refuses the key');
  // The advertised schemas and READ_NAMES agree: every list tool with a building filter takes buildingName; room only where rows carry roomId.
  for (const tool of DOMAIN_TOOLS) {
    const operation = tool.name.slice(9), spec = READ_NAMES[operation], properties = tool.inputSchema.properties;
    if (!spec || spec.room === 'param') { assert.equal(properties.buildingName, undefined, tool.name); continue; }
    assert.equal(typeof properties.buildingName.description, 'string', tool.name);
    assert.equal(Object.hasOwn(properties, 'roomName'), spec.room === 'rows', tool.name);
    if (spec.room === 'rows' && !spec.reports) assert.ok(Object.hasOwn(DOMAIN_READS[operation].fields ?? {}, 'roomId') || DOMAIN_READS[operation].reports, `${tool.name}: rows carry roomId`);
  }
  assert.deepEqual(DIRECTORY_RPCS, ['hermes_building_directory_v1', 'hermes_room_directory_v1', 'hermes_organization_name_v1', 'hermes_user_display_name_v1']);
});

test('buildingName: exact name/code first (case-insensitive), then contains; 0 ⇒ detail; ≥2 ⇒ detail lists the names in scope; buildingId must agree', async () => {
  const { calls, resolve } = setup();
  assert.deepEqual(matchBuildings(BUILDINGS, 'london park').map(row => row.id), [C]);
  assert.deepEqual(matchBuildings(BUILDINGS, '950nk').map(row => row.id), [A], 'code match');
  assert.deepEqual(matchBuildings(BUILDINGS, 'LONDON').map(row => row.id), [B, C], 'contains');
  assert.deepEqual(matchBuildings(BUILDINGS, 'lp').map(row => row.id), [C], 'exact code wins over contains');
  const one = await resolve('customers', { query: 'An' }, { buildingName: ' toà 950nk ' });
  assert.deepEqual(one, { input: { query: 'An', limit: 20, cursor: null, buildingId: A, status: null }, plan: null });
  assert.deepEqual(calls.map(call => call.name), ['hermes_building_directory_v1']);
  assert.deepEqual(calls[0].args, { p_organization_id: ORG, p_building_ids: [A, B, C] }); assert.equal(calls[0].accessToken, 'bearer-fixture');
  await assert.rejects(resolve('customers', {}, { buildingName: 'Sài Gòn' }), unresolved(/^Không thấy toà 'Sài Gòn' trong phạm vi được xem\.$/));
  await assert.rejects(resolve('customers', {}, { buildingName: 'london' }), unresolved(/^Nhiều toà khớp 'london': London Garden, London Park — nêu rõ\.$/));
  await assert.rejects(resolve('customers', { buildingId: B }, { buildingName: '950NK' }), unresolved(/^buildingId không phải toà '950NK' \(Toà 950NK\)\.$/));
  assert.equal((await resolve('customers', { buildingId: A }, { buildingName: '950NK' })).input.buildingId, A, 'same building restated is fine');
  // Only the key's own scope is searched: a building outside it is simply unseen.
  await assert.rejects(resolve('customers', {}, { buildingName: 'London Park' }, { identity: identityOf(KEYS, [A, B]) }), unresolved(/Không thấy toà 'London Park'/));
  await assert.rejects(resolve('customers', {}, { buildingName: 'x' }, { identity: identityOf(KEYS, []) }), unresolved(/không có toà nào/));
  // Error codes stay BrokerError(400) and never carry anything but the detail string.
  await assert.rejects(resolve('customers', {}, { buildingName: 'Sài Gòn' }), error => error.status === 400 && Object.keys(error).sort().join() === 'code,detail,name,status');
  // Report tools and the wave-2 entry resolve the same way into their own slot.
  assert.equal((await resolve('contract_search', { status: 'ACTIVE' }, { buildingName: 'London Garden' })).input.buildingId, B);
  const w2 = await resolve('report', { report: 'rooms', params: {} }, { buildingName: 'London Park' });
  assert.equal(w2.input.params.buildingId, C); assert.equal(w2.plan, null);
  await assert.rejects(resolve('report', { report: 'suppliers', params: {} }, { buildingName: 'London Park' }), unresolved(/^Báo cáo suppliers không lọc theo toà\.$/));
  await assert.rejects(resolve('customer_detail', { customerId: A }, { buildingName: 'x' }), unresolved(/không nhận buildingName\/roomName/));
  for (const bad of [{}, { other: 'x' }, { buildingName: '' }, { buildingName: 'a\u0001' }]) await assert.rejects(resolve('customers', {}, bad), code('invalid_request'), JSON.stringify(bad));
});

test('directory cache: one RPC per token+permission for 5 minutes; a new contextVersion, scope or permission reads again; rooms are never cached', async () => {
  const { calls, clock, resolve } = setup();
  await resolve('customers', {}, { buildingName: '950NK' }); await resolve('customers', {}, { buildingName: 'London Garden' });
  assert.equal(calls.length, 1, 'second lookup served from cache');
  await resolve('contracts', {}, { buildingName: '950NK' }); assert.equal(calls.length, 2, 'another permission is another directory');
  await resolve('customers', {}, { buildingName: '950NK' }, { identity: identityOf(KEYS, [A, B, C], 'e'.repeat(64)) }); assert.equal(calls.length, 3, 'contextVersion changed');
  await resolve('customers', {}, { buildingName: '950NK' }, { identity: identityOf(KEYS, [A, B]) }); assert.equal(calls.length, 4, 'scope changed');
  clock.now += 300_000; await resolve('customers', {}, { buildingName: '950NK' }, { identity: identityOf(KEYS, [A, B]) }); assert.equal(calls.length, 5, 'ttl elapsed');
  await resolve('customers', {}, { buildingName: '950NK' }, { tokenDigest: 'f'.repeat(64), identity: identityOf(KEYS, [A, B]) }); assert.equal(calls.length, 6, 'another connection');
  const before = calls.length;
  await resolve('customers', {}, { roomName: 'London 5' }, { identity: identityOf(KEYS, [A, B]) }); await resolve('customers', {}, { roomName: 'London 5' }, { identity: identityOf(KEYS, [A, B]) });
  assert.deepEqual(calls.slice(before).map(call => call.name), ['hermes_room_directory_v1', 'hermes_room_directory_v1']);
  assert.throws(() => createReadNameResolver({ rpc: fakeRpc(), ttlMs: 300_001 }), /invalid_read_name_resolver/);
  assert.throws(() => createReadNameResolver({}), /invalid_read_name_resolver/);
});

test('roomName: searched inside the resolved building or the whole scope; duplicates across buildings pass together up to 5 like the web; more or a one-room report asks for the building', async () => {
  const { calls, resolve } = setup();
  // Inside one building: exactly the room of that building; the directory asks only for that building.
  const inA = await resolve('customers', { limit: 7 }, { buildingName: '950NK', roomName: 'london 5' });
  assert.deepEqual(calls.at(-1).args, { p_organization_id: ORG, p_building_ids: [A], p_room_name: 'london 5' });
  assert.deepEqual(inA.input, { query: '', limit: ROOM_FILTER_PAGE_LIMIT, cursor: null, buildingId: A, status: null }, 'customers: SQL query never matches a room; page limit 50');
  assert.deepEqual([inA.plan.maxPages, typeof inA.plan.next, typeof inA.plan.merge], [ROOM_FILTER_MAX_PAGES, 'function', 'function']);
  // Across the scope: "London 5" exists in A and B — both ids (directory order: building name, room name), no error
  // (output rows carry buildingName/buildingId to tell them apart).
  const both = await resolve('customers', {}, { roomName: 'London 5' });
  assert.deepEqual(calls.at(-1).args.p_building_ids, [A, B, C]); assert.equal(both.input.buildingId, null);
  assert.deepEqual(both.plan.merge([{ organizationId: ORG, domain: 'customers', items: [], nextCursor: null, fetchedAt: 'x' }]).roomFilter.roomIds, [R(3), R(1)]);
  await assert.rejects(resolve('customers', {}, { roomName: 'Phòng 99' }), unresolved(/^Không thấy phòng 'Phòng 99' trong phạm vi được xem\.$/));
  await assert.rejects(resolve('customers', {}, { buildingName: '950NK', roomName: 'Phòng 99' }), unresolved(/^Không thấy phòng 'Phòng 99' ở toà Toà 950NK\.$/));
  // "căn" contains Căn 1..6 (6 rooms, one building) ⇒ over the limit: name the building and the rooms.
  assert.equal(ROOM_MATCH_LIMIT, 5);
  await assert.rejects(resolve('customers', {}, { roomName: 'căn' }), unresolved(/^Phòng 'căn' khớp 6 phòng ở toà London Park: Căn 1, Căn 2, Căn 3, Căn 4, Căn 5, Căn 6 — nêu tên đầy đủ\.$/));
  // "lo" contains three rooms of two buildings ⇒ still ≤ 5 ⇒ all three ids go together (the rows name their building).
  const three = await resolve('customers', {}, { roomName: 'lo' });
  assert.deepEqual(three.plan.merge([{ organizationId: ORG, domain: 'customers', items: [], nextCursor: null, fetchedAt: 'x' }]).roomFilter.roomIds, [R(3), R(1), R(2)]);
  // "5" contains six rooms (name or code) across three buildings ⇒ over the limit: the towers are named, nothing else.
  await assert.rejects(resolve('customers', {}, { roomName: '5' }), unresolved(/^Phòng '5' có ở toà London Garden, London Park, Toà 950NK — nêu toà\.$/));
  await assert.rejects(resolve('customers', {}, { roomName: 'P' }), unresolved(/^Phòng 'P' có ở toà London Garden, London Park — nêu toà\.$/));
  // A tool whose rows have no room, and a wave-2 report with one roomId slot.
  await assert.rejects(resolve('leads', {}, { roomName: 'London 5' }), unresolved(/^crm_read_leads không lọc theo phòng/));
  await assert.rejects(resolve('report', { report: 'room_detail', params: {} }, { roomName: 'London 5' }), unresolved(/^Phòng 'London 5' có ở toà London Garden, Toà 950NK — nêu toà\.$/));
  // room_detail requires roomId: the model's input cannot pass the validator before the name is an id, so the resolver
  // takes it as sent (report/params only) and the service validates the resolved input afterwards.
  const detail = await resolve('report', { report: 'room_detail', params: {} }, { buildingName: 'London Garden', roomName: 'London 5' });
  assert.deepEqual(detail, { input: { report: 'room_detail', params: { roomId: R(3) } }, plan: null });
  assert.deepEqual(domainInput('report', detail.input), { report: 'room_detail', params: { roomId: R(3) }, limit: 20, offset: 0 });
  assert.deepEqual((await resolve('report', { report: 'room_detail' }, { buildingName: 'London Garden', roomName: 'London 5' })).input, { report: 'room_detail', params: { roomId: R(3) } }, 'params omitted');
  for (const bad of [{ report: 'nope', params: {} }, { report: 'room_detail', params: [] }, { report: 7 }]) await assert.rejects(resolve('report', bad, { roomName: 'London 5' }), code('invalid_request'), JSON.stringify(bad));
  await assert.rejects(resolve('customers', { limit: 999 }, { roomName: 'London 5' }), code('invalid_request'), 'an invalid list input stays invalid');
  await assert.rejects(resolve('report', { report: 'suppliers', params: {} }, { roomName: 'London 5' }), unresolved(/^Báo cáo suppliers không lọc theo phòng\.$/));
  await assert.rejects(resolve('invoice_report', { report: 'stats' }, { roomName: 'London 5' }), unresolved(/^roomName chỉ dùng với report=search\.$/));
  // A building the model named by id but outside the key's scope is refused before any room lookup.
  await assert.rejects(resolve('customers', { buildingId: V }, { roomName: 'London 5' }), code('forbidden'));
});

test('query = room name only where that lane\'s SQL matches room.name and the model sent no query; a code-only match never rewrites query', async () => {
  const { resolve } = setup();
  const query = async (operation, lane, input = {}, names = { buildingName: '950NK', roomName: 'London 5' }) => (await resolve(operation, input, names, { lane })).input.query;
  assert.equal(await query('receivables', 'legacy'), 'London 5'); assert.equal(await query('receivables', 'fast'), 'London 5');
  assert.equal(await query('meter_readings', 'legacy'), 'London 5');
  assert.equal(await query('contract_search', 'legacy', { status: 'ACTIVE' }), 'London 5');
  assert.equal(await query('contracts', 'fast'), 'London 5'); assert.equal(await query('contracts', 'legacy'), '', 'v1 matches contract_number only');
  for (const operation of ['customers', 'invoices', 'income_expenses', 'assets', 'tasks']) assert.equal(await query(operation, 'fast'), '', operation);
  assert.equal(await query('receivables', 'legacy', { query: 'HD001' }), 'HD001', 'the model\'s own query wins');
  assert.equal(await query('receivables', 'legacy', {}, { buildingName: 'London Park', roomName: 'L5' }), '', 'room found by code: its name does not contain the needle');
});

test('rows plan: pages of 50 are read until enough rows match or the SQL is exhausted (≤4 pages); the merge keeps SQL order, cuts at the asked limit and keeps a valid cursor/offset', async () => {
  const { resolve } = setup();
  const row = (n, roomId) => ({ id: id(500 + n), name: `K${n}`, phone: null, contractId: null, buildingId: A, roomId, roomName: roomId === R(1) ? 'London 5' : null });
  const page = (items, nextCursor) => ({ organizationId: ORG, domain: 'customers', items, nextCursor, fetchedAt: '2026-10-21T00:00:00.000Z' });
  const { input, plan } = await resolve('customers', { limit: 3 }, { buildingName: '950NK', roomName: 'London 5' });
  assert.equal(input.limit, 50);
  // Page 1: one match, more rows ⇒ next page from the SQL cursor; page 2: two matches ⇒ enough (3) ⇒ stop.
  const first = page([row(1, R(1)), row(2, R(2)), row(3, null)], id(503));
  assert.deepEqual(plan.next(first, input), { ...input, cursor: id(503) });
  const second = page([row(4, R(1)), row(5, R(1)), row(6, R(1))], id(506));
  assert.equal(plan.next(second, { ...input, cursor: id(503) }), null, 'three matches collected');
  const merged = plan.merge([first, second]);
  assert.deepEqual(merged.items.map(item => item.id), [id(501), id(504), id(505)], 'SQL order, cut at the asked limit');
  assert.equal(merged.nextCursor, id(505), 'cut ⇒ cursor is the last kept row');
  assert.deepEqual(merged.roomFilter, { roomIds: [R(1)], roomNames: ['London 5'], buildingIds: [A], scannedRows: 6, pages: 2, more: true, filteredOn: 'page' });
  assert.deepEqual(Object.keys(merged), ['organizationId', 'domain', 'items', 'nextCursor', 'fetchedAt', 'roomFilter']);
  // Exhausted SQL with fewer matches: cursor null, more false. An empty page stops too.
  const tail = plan.merge([page([row(7, R(2))], null)]);
  assert.deepEqual([tail.items, tail.nextCursor, tail.roomFilter.more, tail.roomFilter.scannedRows], [[], null, false, 1]);
  assert.equal(plan.next(page([], null), input), null);
  // Offset paging (reports): absolute positions survive the merge; nextOffset after the last kept row when cut.
  const report = await resolve('invoice_report', { report: 'search', limit: 2, offset: 10 }, { buildingName: '950NK', roomName: 'London 5' });
  assert.deepEqual([report.input.limit, report.input.offset], [50, 10]);
  const rows = (offset, items, nextOffset) => ({ organizationId: ORG, domain: 'invoice_report', fetchedAt: 'x', report: 'search', source: 'crm.invoices', unavailable: null,
    summary: null, items, offset, nextOffset, sourceCapped: false });
  const inv = (n, roomId) => ({ id: id(700 + n), roomId });
  const p1 = rows(10, [inv(1, R(2)), inv(2, R(1)), inv(3, R(2))], 13);
  assert.deepEqual(report.plan.next(p1, report.input), { ...report.input, offset: 13 });
  const p2 = rows(13, [inv(4, R(1)), inv(5, R(1))], 15);
  assert.equal(report.plan.next(p2, { ...report.input, offset: 13 }), null);
  const out = report.plan.merge([p1, p2]);
  assert.deepEqual([out.items.map(item => item.id), out.offset, out.nextOffset, out.roomFilter.more], [[id(702), id(704)], 10, 14, true]);
  assert.equal(report.plan.next(rows(1999, [inv(9, R(2))], 2001), report.input), null, 'the 2000 offset ceiling ends paging');
});

// Through the real services: bound-user-operation (JWT + identity, then the resolver, then the validator again, then the page loop)
// and the domain mount (directory RPCs over the bound transport, p_input carrying the resolved id, roomFilter merged).
function services(t) {
  const clock = { now: 1_800_000_000_000 }, EXPIRES_AT = clock.now + 3_600_000, GRANTS = ['assistant.context.read', ...KEYS];
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const bearer = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: EXPIRES_AT / 1000 })).toString('base64url'), 'signature'].join('.');
  const token = 'hc_' + 'B'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
  const owner = { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION };
  const snapshot = { status: 'active',
    connection: { id: CONNECTION, assistantId: ASSISTANT, organizationId: ORG, userId: USER, state: 'active', epoch: 2, restrictions: { read: GRANTS, action: [] },
      scopeIds: [SCOPE], tokenDigest: digest, credentialRef: CREDENTIAL, expiresAt: clock.now + 600_000 },
    session: { credentialRef: CREDENTIAL, revision: 1, envelope: crypto.seal({ accessToken: bearer, refreshToken: 'SYNTHETIC_REFRESH', expiresAt: EXPIRES_AT }, owner), expiresAt: EXPIRES_AT, binding: owner },
    membership: { membershipId: MEMBER, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, read: GRANTS, action: [], scopeIds: [SCOPE] } };
  const connectionStore = { async readConnection({ tokenDigest }) { return tokenDigest === digest ? structuredClone(snapshot) : null; } };
  const auth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt: EXPIRES_AT }; }, async readAuthorization() { throw new Error('never'); } };
  const branded = new WeakSet();
  const identity = { row: { id: CONNECTION, assistantId: ASSISTANT, userId: USER, organizationId: ORG, state: 'active', epoch: 2, expiresAt: snapshot.connection.expiresAt,
    restrictions: { read: GRANTS, action: [] } }, effective: { read: GRANTS, action: [] }, policyEpoch: '1'.repeat(64), isSuperadmin: false, assistantScopeIds: [SCOPE],
  scopesByPermission: Object.fromEntries(GRANTS.map(key => [key, { buildingIds: [A, B, C], cashbookIds: [] }])), contextVersion: VERSION };
  const authority = { async identifyConnection() { return { connectionId: CONNECTION }; }, async resolve() { const value = structuredClone(identity); branded.add(value); return value; },
    async checkUnchanged(_token, before) { if (!branded.has(before)) throw new BrokerError('context_changed'); } };
  return { clock, crypto, connectionStore, auth, authority, token, digest, bearer, signal: new AbortController().signal };
}

test('bound-user-operation: names reach the resolver with the asker JWT and identity after admission; its input is validated again; no names ⇒ no resolver; names without a resolver ⇒ invalid_request', async t => {
  const f = services(t), executed = [], seen = [];
  const reads = { async execute(operation, value) { executed.push(structuredClone(value.input)); return { operation, cursor: value.input.cursor, items: [] }; } };
  const make = resolveInput => createBoundUserOperationService({ authority: f.authority, connectionStore: f.connectionStore, crypto: f.crypto, auth: f.auth, reads,
    mayUse: () => true, validateInput: (_operation, input) => { if (Object.hasOwn(input, 'bad')) throw new TypeError('bad'); return { ...input }; },
    validateResult: (_operation, result) => result, clock: () => f.clock.now, resolveInput });
  const resolver = make(async request => { seen.push(request); return { input: { ...request.input, buildingId: A }, plan: null }; });
  const run = async (service, options = {}) => { const receipt = await service.prepare(f.token, 'customers', { query: '' }, { signal: f.signal, ...options }); return service.finalize(f.token, receipt, { signal: f.signal }); };
  await run(resolver, { names: { buildingName: '950NK' } });
  assert.equal(seen.length, 1); assert.equal(seen[0].accessToken, f.bearer); assert.equal(seen[0].tokenDigest, f.digest);
  assert.deepEqual([seen[0].operation, seen[0].names, seen[0].input, seen[0].identity.row.organizationId], ['customers', { buildingName: '950NK' }, { query: '' }, ORG]);
  assert.deepEqual(executed.at(-1), { query: '', buildingId: A }, 'the RPC gets the resolved input');
  await run(resolver); assert.equal(seen.length, 1, 'no names ⇒ the resolver is never consulted');
  await assert.rejects(run(make(null), { names: { buildingName: '950NK' } }), code('invalid_request'));
  await assert.rejects(run(resolver, { names: {} }), code('invalid_request'));
  await assert.rejects(run(make(async () => ({ input: { bad: 1 }, plan: null })), { names: { buildingName: 'x' } }), code('invalid_request'), 'resolved input still faces the validator');
  await assert.rejects(run(make(async () => ({ input: {}, plan: { maxPages: 99, next() {}, merge() {} } })), { names: { buildingName: 'x' } }), code('backend_unavailable'), 'plan ceiling');
  await assert.rejects(run(make(async () => { throw Object.assign(new BrokerError('read_name_unresolved'), { detail: 'x' }); }), { names: { buildingName: 'x' } }), unresolved(/^x$/));
  // Page plan: the loop re-validates each next input, reads at most maxPages pages and returns the merge.
  const paged = make(async request => ({ input: { ...request.input, cursor: null }, plan: { maxPages: 3,
    next: (page, input) => page.cursor === 'c2' ? null : { ...input, cursor: page.cursor === null ? 'c1' : 'c2' }, merge: pages => ({ pages: pages.map(page => page.cursor) }) } }));
  assert.deepEqual(await run(paged, { names: { roomName: 'London 5' } }), { pages: [null, 'c1', 'c2'] });
  const unlimited = make(async request => ({ input: request.input, plan: { maxPages: 2, next: (page, input) => ({ ...input, cursor: `${page.cursor}+` }), merge: pages => pages.length } }));
  assert.equal(await run(unlimited, { names: { roomName: 'x' } }), 2, 'maxPages caps the loop');
});

test('domain mount end to end: buildingName/roomName become directory RPCs with the asker JWT, the read RPC gets p_input with the id, rows are filtered and merged; crm_auth_context directory port', async t => {
  const f = services(t), dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const calls = [], fetchedAt = new Date(f.clock.now).toISOString();
  // Dòng đầy đủ sau B5c: buildingName bắt buộc (tolerant đã gỡ 21/10, domain-tolerance.test.mjs).
  const customersRow = (n, roomId) => ({ id: id(600 + n), name: `Khách ${n}`, phone: null, contractId: null, buildingId: A, buildingName: 'Toà 950NK', roomId, roomName: roomId === R(1) ? 'London 5' : null });
  // List reads carry `summary` (required since the R2a release window closed); empty pages carry the summary of no row.
  const empty = domain => Object.hasOwn(DOMAIN_SUMMARIES, domain) ? { summary: summarizeRows(domain, []) } : {};
  let displayUser = USER, displayName = 'Người Dùng Thử';
  const fetch = async (url, options) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''), args = JSON.parse(options.body);
    calls.push({ name, args, bearer: options.headers.authorization });
    if (name === 'hermes_building_directory_v1') return Response.json({ buildings: BUILDINGS.filter(row => args.p_building_ids.includes(row.id)) });
    if (name === 'hermes_room_directory_v1') return Response.json({ rooms: directoryRooms(args) });
    if (name === 'hermes_organization_name_v1') return Response.json({ id: args.p_organization_id, name: 'Công ty Thử' });
    // R2c part 2 (c): the asker's own display name (SQL reads auth.uid() only; no argument).
    if (name === 'hermes_user_display_name_v1') { assert.deepEqual(args, {}); return Response.json({ id: displayUser, name: displayName }); }
    if (name === 'hermes_domain_read_fast_v1' && args.p_domain === 'receivables') return Response.json({ authority: { organizationId: ORG, userId: USER, connectionId: CONNECTION,
      permission: 'invoices.view', buildingIds: [A, B, C], cashbookIds: [] }, result: { organizationId: ORG, domain: 'receivables', ...empty('receivables'), items: [], nextCursor: null, source: 'crm.invoices', fetchedAt } });
    if (name === 'hermes_domain_read_fast_v1') {
      // Full SQL page of 50 (the validator only accepts a cursor on a full page): matches at rows 2 and 50; the tail page holds one more.
      // The SQL summary counts the whole filtered set (52 rows of the building, before the connector filters the room).
      const page = args.p_input.cursor === null
        ? { items: Array.from({ length: 50 }, (_, index) => customersRow(index + 1, [2, 50].includes(index + 1) ? R(1) : index % 2 ? R(2) : null)), nextCursor: id(650) }
        : { items: [customersRow(51, R(1)), customersRow(52, null)], nextCursor: null };
      return Response.json({ authority: { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: 'customers.view', buildingIds: [A, B, C], cashbookIds: [] },
        result: { organizationId: ORG, domain: 'customers', summary: { count: 52, byStatus: {}, sum: {} }, ...page, fetchedAt } });
    }
    if (name === 'hermes_domain_read_v2') return Response.json({ organizationId: ORG, domain: args.p_domain, ...empty(args.p_domain), items: [], nextCursor: null, source: DOMAIN_READS[args.p_domain].source, fetchedAt });
    if (name === 'hermes_w2_read_v1') return Response.json({ organizationId: ORG, domain: 'report', fetchedAt, report: args.p_input.report, source: W2.reports[args.p_input.report].source,
      unavailable: null, summary: null, items: [], offset: 0, nextOffset: null, sourceCapped: false, fence: { buildings: [B], cashbooks: [], orgWide: false } });
    return Response.json({ organizationId: ORG, domain: args.p_domain, ...empty(args.p_domain), items: [], nextCursor: null });
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const readAuthority = createReadCatalogAuthority({ authority: f.authority, connectionStore: f.connectionStore, clock: () => f.clock.now });
  const domains = createDomainMount({ authority: f.authority, connectionStore: f.connectionStore, crypto: f.crypto, auth: f.auth, supabase, dependencyScope, fetch, clock: () => f.clock.now, readAuthority }).createService();
  const run = async (operation, input, names) => {
    const receipt = await domains.prepareDomain(f.token, operation, input, names ? { signal: f.signal, names } : { signal: f.signal });
    return domains.finalizeDomain(f.token, receipt, { signal: f.signal });
  };
  const value = await run('customers', domainInput('customers', { limit: 3 }), { buildingName: '950nk', roomName: 'London 5' });
  assert.deepEqual(calls.map(call => call.name), ['hermes_building_directory_v1', 'hermes_room_directory_v1', 'hermes_domain_read_fast_v1', 'hermes_domain_read_fast_v1']);
  assert.ok(calls.every(call => call.bearer === `Bearer ${f.bearer}`), 'every call carries the asker JWT');
  assert.deepEqual(calls[0].args, { p_organization_id: ORG, p_building_ids: [A, B, C] });
  assert.deepEqual(calls[1].args, { p_organization_id: ORG, p_building_ids: [A], p_room_name: 'London 5' });
  assert.deepEqual(calls[2].args.p_input, { query: '', limit: 50, cursor: null, buildingId: A, status: null }, 'SQL input keys unchanged, id resolved, page 50');
  assert.equal(calls[3].args.p_input.cursor, id(650));
  assert.deepEqual(value.items.map(row => row.id), [id(602), id(650), id(651)]);
  assert.deepEqual(value.roomFilter, { roomIds: [R(1)], roomNames: ['London 5'], buildingIds: [A], scannedRows: 52, pages: 2, more: false, filteredOn: 'page' });
  assert.equal(value.nextCursor, null);
  assert.deepEqual(value.summary, { count: 3, byStatus: null, sum: {}, withoutContract: null },
    'every page read: the summary of the kept rows, never the SQL 52 of the building; their contract status/history is not in the rows (null)');
  // Asking for two: the first page already holds them ⇒ one read, cut, cursor = last kept row, more = true.
  calls.length = 0;
  const two = await run('customers', domainInput('customers', { limit: 2 }), { buildingName: '950nk', roomName: 'London 5' });
  assert.deepEqual([calls.filter(call => call.name === 'hermes_domain_read_fast_v1').length, two.items.map(row => row.id), two.nextCursor, two.roomFilter.more], [1, [id(602), id(650)], id(650), true]);
  assert.equal(two.summary, null, 'rows left unread: no figure rather than a wrong one');
  // Receivables (fast plan since B2): query becomes the room name, the seven v2 keys stay; the cached lane (leads) makes no directory call without names.
  calls.length = 0;
  await run('receivables', domainInput('receivables', {}), { buildingName: '950NK', roomName: 'London 5' });
  assert.deepEqual(calls.map(call => call.name), ['hermes_building_directory_v1', 'hermes_room_directory_v1', 'hermes_domain_read_fast_v1']);
  assert.deepEqual(calls[2].args.p_input, { query: 'London 5', limit: 50, cursor: null, buildingId: A, status: null, fromDate: null, toDate: null });
  calls.length = 0; await run('leads', domainInput('leads', {}));
  assert.deepEqual(calls.map(call => call.name), ['hermes_domain_read_v1'], 'no names ⇒ no directory');
  await assert.rejects(run('leads', domainInput('leads', {}), { buildingName: 'Sài Gòn' }), unresolved(/Không thấy toà 'Sài Gòn'/));
  // A deferred input (room_detail needs roomId): resolved, validated, then granted per report; the read RPC receives the id.
  calls.length = 0;
  await run('report', { report: 'room_detail', params: {} }, { buildingName: 'London Garden', roomName: 'London 5' });
  assert.deepEqual(calls.map(call => call.name), ['hermes_building_directory_v1', 'hermes_room_directory_v1', 'hermes_w2_read_v1']);
  assert.deepEqual(calls[2].args.p_input, { report: 'room_detail', params: { roomId: R(3) }, limit: 20, offset: 0 });
  await assert.rejects(run('report', { report: 'room_detail', params: {} }, { buildingName: 'London Garden' }), unresolved(/^Báo cáo room_detail không lọc theo toà\.$/), 'a building alone fits no slot of room_detail');
  await assert.rejects(run('report', { report: 'room_detail', params: {} }), code('invalid_request'), 'no names: the validator still requires roomId');
  // crm_auth_context directory port: company name and the buildings of the widest read scope.
  calls.length = 0;
  const receipt = await domains.prepareContext(f.token, { organizationId: ORG, buildingIds: [A, B, C], contextVersion: VERSION }, { signal: f.signal });
  const context = await domains.finalizeContext(f.token, receipt, { signal: f.signal });
  assert.deepEqual(context, { organizationName: 'Công ty Thử', userName: 'Người Dùng Thử', buildings: BUILDINGS });
  assert.deepEqual(calls.map(call => call.name).sort(), ['hermes_building_directory_v1', 'hermes_organization_name_v1', 'hermes_user_display_name_v1']);
  // The name must be the connection's own user: another id from SQL fails closed (new token digest, so no cache hit).
  displayUser = A;
  const other = services(t), otherDomains = createDomainMount({ authority: other.authority, connectionStore: other.connectionStore, crypto: other.crypto, auth: other.auth,
    supabase, dependencyScope, fetch, clock: () => other.clock.now }).createService();
  const otherReceipt = await otherDomains.prepareContext(other.token, { organizationId: ORG, buildingIds: [A], contextVersion: VERSION }, { signal: other.signal });
  await assert.rejects(otherDomains.finalizeContext(other.token, otherReceipt, { signal: other.signal }), code('backend_unavailable'));
  displayUser = USER;
  // The name is display text or null (no profile name): a non-text name fails closed; null passes through as null.
  for (const [bad, expected] of [[42, 'backend_unavailable'], ['', 'backend_unavailable'], ['Tên\u0007lạ', 'backend_unavailable'], [null, null]]) {
    displayName = bad;
    const fresh = services(t), freshDomains = createDomainMount({ authority: fresh.authority, connectionStore: fresh.connectionStore, crypto: fresh.crypto, auth: fresh.auth,
      supabase, dependencyScope, fetch, clock: () => fresh.clock.now }).createService();
    const freshReceipt = await freshDomains.prepareContext(fresh.token, { organizationId: ORG, buildingIds: [A], contextVersion: VERSION }, { signal: fresh.signal });
    const outcome = freshDomains.finalizeContext(fresh.token, freshReceipt, { signal: fresh.signal });
    if (expected === null) assert.equal((await outcome).userName, null, 'a user without a profile name: null');
    else await assert.rejects(outcome, code(expected), `name ${JSON.stringify(bad)}`);
  }
  displayName = 'Người Dùng Thử';
  await assert.rejects(domains.prepareContext(f.token, { organizationId: ORG, buildingIds: [A] }, { signal: f.signal }), code('invalid_request'));
  // Directory SQL not deployed yet (PGRST202): crm_auth_context degrades to null (another connection, so no cache hit); name
  // resolution itself still fails closed.
  const absent = async (url, options) => ['_directory_v1', 'organization_name', 'user_display_name'].some(part => new URL(url).pathname.includes(part))
    ? Response.json({ code: 'PGRST202', message: 'absent', details: null, hint: null }, { status: 404 }) : fetch(url, options);
  const g = services(t);
  const degraded = createDomainMount({ authority: g.authority, connectionStore: g.connectionStore, crypto: g.crypto, auth: g.auth, supabase, dependencyScope, fetch: absent, clock: () => g.clock.now }).createService();
  const pending = await degraded.prepareContext(g.token, { organizationId: ORG, buildingIds: [A, B, C], contextVersion: VERSION }, { signal: g.signal });
  assert.deepEqual(await degraded.finalizeContext(g.token, pending, { signal: g.signal }), { organizationName: null, userName: null, buildings: null });
  const receiptAbsent = await degraded.prepareDomain(g.token, 'leads', domainInput('leads', {}), { signal: g.signal, names: { buildingName: '950NK' } }).catch(error => error);
  assert.ok(code('backend_unavailable')(receiptAbsent), 'a read with a name fails closed without the directory');
});
