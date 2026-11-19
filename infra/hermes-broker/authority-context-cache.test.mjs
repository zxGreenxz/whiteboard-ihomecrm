// Nhớ quyền CRM 30 phút (28/10/2026): bộ nhớ chỉ thay phần đọc quyền CRM (auth.readAuthorization) cho ping/initialize,
// tools/list và làn gia hạn; mọi tools/call (đọc/ghi) vẫn dựng authority thật. Đột biến tay đã chạy (ghi trong commit):
// bỏ epoch khỏi khoá ⇒ ca "epoch" đỏ; cho tools/call dùng bộ nhớ ⇒ ca "thu hồi quyền" đỏ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StoreTransportError } from './store-transport.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { BrokerError, createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { AUTHORITY_CACHE_FORGET_CODES, AUTHORITY_CACHE_FORGET_REASONS, AUTHORITY_CONTEXT_CACHE, DEFAULT_AUTHORITY_CACHE_TTL_MS,
  MAX_AUTHORITY_CACHE_TTL_MS, MIN_AUTHORITY_CACHE_TTL_MS, createAuthorityContextCache, forgetsAuthorityContext, validAuthorityCacheTtl } from './authority-context-cache.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { connection: id('1'), assistant: id('2'), user: id('3'), org: id('4'), session: id('5'), credential: id('6'),
  membership: id('7'), assistantScope: id('8'), other: id('b') };
const NOW = 1_800_000_000_000, MINUTE = 60_000;
const token = `hc_${Buffer.alloc(32, 3).toString('base64url')}`;
const tokenDigest = createHash('sha256').update(token).digest('hex');
const binding = () => ({ assistantId: ids.assistant, userId: ids.user, organizationId: ids.org, sessionId: ids.session });
const CONTEXT = 'assistant.context.read', CREATE = 'customers.create';
const scope = () => ({ buildingIds: [], cashbookIds: [] });
const crmGrants = () => ({ read: [CONTEXT], action: [CREATE] });
const code = expected => error => error instanceof BrokerError && error.code === expected;
const cached = signal => ({ signal, [AUTHORITY_CONTEXT_CACHE]: true });

/** Real DurableAuthority over a fake joined store, real AES envelope and counted Auth/CRM reads. */
function fixture(t, { ttlMs = DEFAULT_AUTHORITY_CACHE_TTL_MS, cache = true, sessionLifetimeMs = 60 * MINUTE } = {}) {
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 1)]]) });
  t.after(() => crypto.destroy());
  const state = { clock: NOW, counts: { read: 0, verify: 0, authorize: 0 }, storeError: null, verifyError: null, authorizeError: null };
  const material = (revision = 1) => ({ accessToken: `PRIVATE_ACCESS_TOKEN_${revision}`, refreshToken: 'PRIVATE_REFRESH_TOKEN', expiresAt: NOW + sessionLifetimeMs });
  state.reply = { status: 'active', connection: { id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user,
    state: 'active', epoch: 2, restrictions: crmGrants(), scopeIds: [ids.assistantScope], tokenDigest, credentialRef: ids.credential, expiresAt: NOW + 15 * MINUTE },
  session: { credentialRef: ids.credential, revision: 1, envelope: crypto.seal(material(1), binding()), expiresAt: NOW + sessionLifetimeMs, binding: binding() },
  membership: { membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false },
  policy: { version: 1, ...crmGrants(), scopeIds: [ids.assistantScope] } };
  state.auth = { userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org], epoch: 'crm-1',
    membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: ids.membership, authorizationVersion: 1 },
    permissions: crmGrants(), companyCeilings: crmGrants(), scopesByPermission: { [CONTEXT]: scope(), [CREATE]: scope() } };
  // Provider refresh: next session revision with a new access token (and the same binding).
  state.refresh = () => { const revision = state.reply.session.revision + 1;
    state.reply.session = { ...state.reply.session, revision, envelope: crypto.seal(material(revision), binding()) }; };
  const connectionStore = createDurableConnectionStore({ clock: () => state.clock, transport: { call: async (_operation, payload) => {
    state.counts.read++;
    if (payload.tokenDigest !== tokenDigest) return { status: 'unavailable' }; // unknown/revoked token
    if (state.storeError) throw new StoreTransportError(state.storeError);
    return structuredClone(state.reply);
  } } });
  const auth = {
    async verifySession({ accessToken }) {
      state.counts.verify++; if (state.verifyError) throw new BrokerError(state.verifyError);
      assert.match(accessToken, /^PRIVATE_ACCESS_TOKEN_/);
      return { userId: ids.user, sessionId: ids.session, expiresAt: state.reply.session.expiresAt };
    },
    async readAuthorization() {
      state.counts.authorize++; await state.authorizeHook?.();
      if (state.authorizeError) throw new BrokerError(state.authorizeError);
      return structuredClone(state.auth);
    },
  };
  const contextCache = cache ? createAuthorityContextCache({ ttlMs, clock: () => state.clock }) : undefined;
  const authority = createDurableAuthority({ connectionStore, crypto, auth, clock: () => state.clock, ...(contextCache ? { contextCache } : {}) });
  const signal = new AbortController().signal;
  return { authority, contextCache, state, signal,
    viaContext: () => authority.resolve(token, cached(signal)), // ping/tools/list/gia hạn
    viaCall: () => authority.resolve(token, { signal }) }; // tools/call, dịch vụ
}

test('cấu hình: mặc định 30 phút, 0 = tắt, 1–60 phút; ngoài khoảng hay sai kiểu bị từ chối', () => {
  assert.equal(DEFAULT_AUTHORITY_CACHE_TTL_MS, 1_800_000);
  assert.equal(createAuthorityContextCache().ttlMs, 1_800_000);
  for (const ok of [0, MIN_AUTHORITY_CACHE_TTL_MS, 1_800_000, MAX_AUTHORITY_CACHE_TTL_MS]) {
    assert.equal(validAuthorityCacheTtl(ok), true, String(ok)); assert.equal(createAuthorityContextCache({ ttlMs: ok }).ttlMs, ok);
  }
  for (const bad of [-1, 1, 59_999, 3_600_001, 1.5, '1800000', null, NaN, Infinity]) {
    assert.equal(validAuthorityCacheTtl(bad), false, String(bad));
    assert.throws(() => createAuthorityContextCache({ ttlMs: bad }), /invalid_authority_context_cache/);
  }
  for (const maxEntries of [0, 1025, 1.5]) assert.throws(() => createAuthorityContextCache({ maxEntries }), /invalid_authority_context_cache/);
  assert.throws(() => createAuthorityContextCache({ clock: 1 }), /invalid_authority_context_cache/);
  assert.deepEqual([...AUTHORITY_CACHE_FORGET_CODES], ['unauthorized', 'forbidden', 'context_changed']);
  for (const value of AUTHORITY_CACHE_FORGET_CODES) assert.equal(forgetsAuthorityContext(new BrokerError(value)), true);
  for (const reason of AUTHORITY_CACHE_FORGET_REASONS) assert.equal(forgetsAuthorityContext(Object.assign(new BrokerError('action_rejected'), { reason })), true);
  for (const other of ['timeout', 'backend_unavailable', 'tool_not_available', 'rate_limited']) assert.equal(forgetsAuthorityContext(new BrokerError(other)), false);
  assert.equal(forgetsAuthorityContext(Object.assign(new BrokerError('action_rejected'), { reason: 'state_changed' })), false);
  assert.throws(() => createDurableAuthority({ connectionStore: { readConnection() {} }, crypto: { open() {} },
    auth: { verifySession() {}, readAuthorization() {} }, contextCache: { lookup() {} } }), /invalid_durable_authority_config/);
});

test('bộ nhớ: hết hạn đúng TTL, không vượt hạn phiên, khoá lệch là bỏ, giá trị bị đóng băng và tách khỏi bản gốc, có trần số mục', () => {
  let clock = NOW;
  const cache = createAuthorityContextCache({ ttlMs: 30 * MINUTE, clock: () => clock, maxEntries: 2 });
  const d = n => createHash('sha256').update(String(n)).digest('hex'), key = d('key'), value = { permissions: { read: ['x'] } };
  const put = (digest, notAfter, target = cache) => target.remember(digest, key, value, notAfter, target.mark());
  put(d(1), NOW + 60 * MINUTE); value.permissions.read.push('mutated');
  const stored = cache.lookup(d(1), key);
  assert.deepEqual(stored, { permissions: { read: ['x'] } }); assert.ok(Object.isFrozen(stored.permissions.read));
  assert.equal(cache.lookup(d(1), d('other-key')), undefined, 'a different key never serves'); assert.equal(cache.size(), 0, 'and drops the entry');
  put(d(1), NOW + 60 * MINUTE);
  clock = NOW + 30 * MINUTE - 1; assert.notEqual(cache.lookup(d(1), key), undefined);
  clock = NOW + 30 * MINUTE; assert.equal(cache.lookup(d(1), key), undefined, 'expires exactly at TTL');
  clock = NOW; put(d(2), NOW + 5 * MINUTE);
  clock = NOW + 5 * MINUTE; assert.equal(cache.lookup(d(2), key), undefined, 'never outlives the provider session');
  clock = NOW; put(d(3), NOW); assert.equal(cache.lookup(d(3), key), undefined, 'already expired session is not stored');
  for (const n of [4, 5, 6]) put(d(n), NOW + 60 * MINUTE);
  assert.equal(cache.size(), 2); assert.equal(cache.lookup(d(4), key), undefined, 'oldest entry evicted at the cap');
  cache.forget(token); cache.forgetDigest(d(5)); assert.equal(cache.lookup(d(5), key), undefined);
  put(tokenDigest, NOW + 60 * MINUTE); cache.forget(token); assert.equal(cache.lookup(tokenDigest, key), undefined, 'forget hashes the presented token');
  // A forget (permission refusal) after a read started fences that read out; discard (dead token) does not.
  const fenced = cache.mark(); cache.forgetDigest(d(9));
  cache.remember(d(8), key, value, NOW + 60 * MINUTE, fenced); assert.equal(cache.lookup(d(8), key), undefined, 'read in flight across a forget');
  cache.remember(d(8), key, value, NOW + 60 * MINUTE); assert.equal(cache.lookup(d(8), key), undefined, 'no mark, no entry');
  const open = cache.mark(); cache.discardDigest(d(9));
  cache.remember(d(8), key, value, NOW + 60 * MINUTE, open); assert.notEqual(cache.lookup(d(8), key), undefined);
  const off = createAuthorityContextCache({ ttlMs: 0, clock: () => clock });
  put(d(7), NOW + 60 * MINUTE, off); assert.equal(off.size(), 0); assert.equal(off.lookup(d(7), key), undefined);
});

test('ping/tools/list/gia hạn dùng lại phần đọc quyền CRM trong 30 phút; kho và phiên Auth vẫn đọc thật mỗi lượt', async t => {
  const f = fixture(t);
  const first = await f.viaContext();
  assert.deepEqual(f.state.counts, { read: 2, verify: 1, authorize: 1 });
  // Keepalive every ~3 min for ~27 min while the host lane renews the 15-min token (only its expiry moves).
  for (let n = 0; n < 9; n++) {
    f.state.clock += 3 * MINUTE - 1; f.state.reply.connection.expiresAt = f.state.clock + 15 * MINUTE;
    const current = await f.viaContext();
    assert.equal(current.row.expiresAt, f.state.reply.connection.expiresAt, 'the receipt carries the live token expiry');
    assert.deepEqual(current.effective, first.effective);
  }
  assert.deepEqual(f.state.counts, { read: 20, verify: 10, authorize: 1 }, 'ten keepalives in ~27 min: one CRM read');
  const renewed = await f.viaContext();
  assert.equal(f.state.counts.authorize, 1); assert.notEqual(renewed.contextVersion, first.contextVersion);
  await f.authority.checkUnchanged(token, renewed, cached(f.signal)); // freshly branded receipt
  f.state.clock = NOW + 30 * MINUTE; f.state.reply.connection.expiresAt = f.state.clock + 15 * MINUTE; await f.viaContext();
  assert.equal(f.state.counts.authorize, 2, 'TTL elapsed: CRM permissions read again');
  // Disabled cache (ttl 0) and a missing cache keep the original per-call reads.
  for (const options of [{ ttlMs: 0 }, { cache: false }]) {
    const off = fixture(t, options); await off.viaContext(); await off.viaContext();
    assert.equal(off.state.counts.authorize, 2, JSON.stringify(options));
  }
});

test('tools/call (không cờ) luôn đọc quyền CRM thật dù bộ nhớ còn hạn, rồi làm mới bộ nhớ bằng kết quả thật', async t => {
  const f = fixture(t);
  await f.viaContext(); assert.equal(f.state.counts.authorize, 1);
  for (let n = 0; n < 3; n++) await f.viaCall();
  assert.equal(f.state.counts.authorize, 4, 'every uncached call reads CRM');
  // Thu hồi quyền CRM mà không đổi authorizationVersion (vd. registry/khoá, phạm vi theo staff_assignments).
  f.state.auth.permissions.action = [];
  assert.deepEqual((await f.viaCall()).effective.action, [], 'the write path sees the revocation at once');
  assert.deepEqual((await f.viaContext()).effective.action, [], 'the next ping/tools/list sees the refreshed read');
  assert.equal(f.state.counts.authorize, 5);
});

for (const [label, mutate, reread] of [
  ['epoch kết nối đổi (thu hẹp/đổi cài đặt)', state => { state.reply.connection.epoch++; }, true],
  ['revision phiên đổi (refresh token)', state => { state.refresh(); }, true],
  ['authorizationVersion tổ chức đổi (vai trò/override/phạm vi)', state => { state.reply.membership.authorizationVersion++; state.auth.membership.authorizationVersion++; }, true],
  ['phiên bản chính sách trợ lý đổi', state => { state.reply.policy.version++; }, true],
  ['giới hạn kết nối đổi', state => { state.reply.connection.restrictions.action = []; }, true],
  ['chỉ hạn token đổi (gia hạn)', state => { state.reply.connection.expiresAt += MINUTE; }, false],
]) {
  test(`khoá bộ nhớ: ${label} ⇒ ${reread ? 'đọc lại quyền CRM' : 'vẫn dùng lại'}`, async t => {
    const f = fixture(t); await f.viaContext();
    mutate(f.state); await f.viaContext();
    assert.equal(f.state.counts.authorize, reread ? 2 : 1);
  });
}

test('thu hồi kết nối, kho từ chối (42501), Auth/CRM từ chối hay context_changed ⇒ bỏ ngay mục nhớ', async t => {
  const revoked = fixture(t); await revoked.viaContext(); assert.equal(revoked.contextCache.size(), 1);
  revoked.state.reply = { status: 'unavailable' };
  await assert.rejects(revoked.viaContext(), code('unauthorized'));
  assert.equal(revoked.contextCache.size(), 0); assert.equal(revoked.state.counts.verify, 1, 'refused before Auth');
  const denied = fixture(t); await denied.viaContext(); denied.state.storeError = 'store_denied';
  await assert.rejects(denied.viaContext(), code('forbidden')); assert.equal(denied.contextCache.size(), 0);
  await assert.rejects(denied.authority.identifyConnection(token, { signal: denied.signal }), code('forbidden'));
  const signedOut = fixture(t); await signedOut.viaContext(); signedOut.state.verifyError = 'unauthorized';
  await assert.rejects(signedOut.viaContext(), code('unauthorized'), 'Auth session is verified even on a cached lookup');
  assert.equal(signedOut.contextCache.size(), 0);
  const crmDenied = fixture(t); await crmDenied.viaContext(); crmDenied.state.authorizeError = 'forbidden';
  await assert.rejects(crmDenied.viaCall(), code('forbidden')); assert.equal(crmDenied.contextCache.size(), 0);
  crmDenied.state.authorizeError = null; await crmDenied.viaContext(); assert.equal(crmDenied.state.counts.authorize, 3, 'reads CRM again');
  const changed = fixture(t), before = await changed.viaContext();
  changed.state.auth.permissions.action = []; await changed.viaCall();
  await assert.rejects(changed.authority.checkUnchanged(token, before, cached(changed.signal)), code('context_changed'));
  assert.equal(changed.contextCache.size(), 0);
  // A transient outage keeps the entry (still bounded by TTL and key).
  const outage = fixture(t); await outage.viaContext(); outage.state.storeError = 'store_unavailable';
  await assert.rejects(outage.viaContext(), code('backend_unavailable')); assert.equal(outage.contextCache.size(), 1);
});

test('lượt đọc quyền CRM đang chạy khi lượt khác bị từ chối (42501) không được ghi lại vào bộ nhớ', async t => {
  const f = fixture(t);
  let entered, release;
  const inFlight = new Promise(resolve => { entered = resolve; });
  f.state.authorizeHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const ping = f.viaContext();
  await inFlight;
  f.contextCache.forget(token); // broker: another call of this connection was refused by SQL
  f.state.authorizeHook = null; release();
  await ping;
  assert.equal(f.contextCache.size(), 0, 'the read that started before the refusal is not remembered');
  await f.viaContext(); await f.viaContext();
  assert.equal(f.state.counts.authorize, 2, 'the next read is remembered and reused normally');
  // An unknown/dead token seen by identify only discards its own entry: it neither touches nor fences this connection.
  const g = fixture(t);
  let gEntered, gRelease;
  const gInFlight = new Promise(resolve => { gEntered = resolve; });
  g.state.authorizeHook = () => { gEntered(); return new Promise(resolve => { gRelease = resolve; }); };
  const warming = g.viaContext();
  await gInFlight;
  await assert.rejects(g.authority.identifyConnection(`hc_${'q'.repeat(43)}`, { signal: g.signal }), code('unauthorized'));
  g.state.authorizeHook = null; gRelease(); await warming;
  assert.equal(g.contextCache.size(), 1);
  await assert.rejects(g.authority.resolve(`hc_${'q'.repeat(43)}`, cached(g.signal)), code('unauthorized'));
  await g.viaContext(); assert.equal(g.state.counts.authorize, 1);
});

test('bề mặt authority không đổi: chỉ identifyConnection/resolve/checkUnchanged, không lộ bộ nhớ hay token', async t => {
  const f = fixture(t), result = await f.viaContext();
  assert.deepEqual(Object.keys(f.authority).sort(), ['checkUnchanged', 'identifyConnection', 'resolve']);
  const exposed = JSON.stringify(result);
  for (const secret of [token, tokenDigest, 'PRIVATE_ACCESS_TOKEN_1', 'PRIVATE_REFRESH_TOKEN', ids.credential]) assert(!exposed.includes(secret), secret);
});

/** Real broker + real DurableAuthority with the cache, a fake customer write service (crm_customer_create). */
function brokerFixture(t) {
  const f = fixture(t), scopeHandle = createDependencyScope(), service = { prepared: 0, finalized: 0, failure: null };
  t.after(() => scopeHandle.close());
  const customers = {
    async prepareCustomerAction() { service.prepared++; if (service.failure) throw service.failure; return Object.freeze({}); },
    async finalizeCustomerAction(_token, _receipt, { onDispatch }) { service.finalized++; onDispatch(); return { ok: true }; },
  };
  const broker = createBroker({ authority: f.authority, customers, dependencyScope: scopeHandle, clock: () => f.state.clock, authorityCache: f.contextCache });
  const create = () => broker.callTool(token, 'crm_customer_create', { requestId: id('c'), name: 'Khách thử', phone: '0900000001', email: null, notes: null });
  const listed = async () => (await broker.listTools(token)).tools.map(tool => tool.name);
  return { ...f, broker, service, create, listed };
}

test('broker: ping/initialize và tools/list dùng quyền đã nhớ; mỗi tools/call vẫn đọc quyền CRM hai lần (nhận + kiểm sau audit)', async t => {
  const f = brokerFixture(t);
  await f.broker.authenticate(token);
  assert.equal(f.state.counts.authorize, 1);
  for (let n = 0; n < 5; n++) await f.broker.authenticate(token);
  assert.ok((await f.listed()).includes('crm_customer_create'));
  assert.equal(f.state.counts.authorize, 1, 'keepalives and tools/list reuse the remembered read');
  await f.create();
  assert.equal(f.state.counts.authorize, 3, 'the write admission and its post-audit check both read CRM');
  assert.equal(f.service.finalized, 1);
  assert.throws(() => createBroker({ authority: f.authority, authorityCache: {} }), /invalid_authority_cache/);
});

test('thu hồi quyền ⇒ lệnh ghi bị chặn ngay dù bộ nhớ còn hạn; danh sách tool cập nhật ở lượt sau', async t => {
  const f = brokerFixture(t);
  await f.broker.authenticate(token); assert.ok((await f.listed()).includes('crm_customer_create'));
  // Chủ gỡ quyền tạo khách của người dùng; giả định xấu nhất: không đổi authorizationVersion/epoch/chính sách.
  f.state.auth.permissions.action = [];
  await f.broker.authenticate(token);
  assert.ok((await f.listed()).includes('crm_customer_create'), 'rủi ro còn lại: danh sách còn cũ tới khi có lượt đọc thật hoặc hết 30 phút');
  const before = f.state.counts.authorize;
  await assert.rejects(f.create(), code('tool_not_available'));
  assert.equal(f.service.prepared, 0, 'nothing reaches the CRM write RPC');
  assert.ok(f.state.counts.authorize > before, 'the write admission read CRM permissions, not the cache');
  assert.ok(!(await f.listed()).includes('crm_customer_create'), 'the real read refreshed the remembered permissions');
});

test('lỗi quyền từ RPC (42501/forbidden, action_rejected vì quyền) ⇒ broker bỏ mục nhớ, ping sau đọc lại quyền thật', async t => {
  for (const failure of [new BrokerError('forbidden'), Object.assign(new BrokerError('action_rejected'), { reason: 'forbidden' }),
    new BrokerError('context_changed')]) {
    const f = brokerFixture(t);
    await f.broker.authenticate(token); await f.create();
    const reads = f.state.counts.authorize;
    f.service.failure = failure;
    await assert.rejects(f.create(), error => error instanceof BrokerError && error.code === failure.code);
    assert.equal(f.contextCache.size(), 0, failure.code);
    await f.broker.authenticate(token);
    assert.equal(f.state.counts.authorize, reads + 2, `${failure.code}: one real read for the refused call, then the ping reads again`);
  }
  const other = brokerFixture(t);
  await other.broker.authenticate(token); other.service.failure = new BrokerError('invalid_request');
  await assert.rejects(other.create(), code('invalid_request')); assert.equal(other.contextCache.size(), 1, 'a non-permission error keeps the entry');
});
