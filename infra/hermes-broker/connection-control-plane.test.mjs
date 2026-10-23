import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import { ConnectionControlError, createConnectionControlPlane, createSupabaseConnectionPreparation, createSupabaseAssistantSignIn } from './connection-control-plane.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { StoreTransportError } from './store-transport.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { user: id('1'), org: id('2'), browser: id('3'), session: id('4'), assistant: id('5'), connection: id('6'), other: id('7'), scope: id('8') };
const NOW = 1800000000000;
const clone = value => structuredClone(value);
const rights = () => ({ read: ['assistant.context.read'], action: [] });
const request = () => ({ browserAccessToken: 'BROWSER_ACCESS', email: 'fixture@example.invalid', password: 'PRIVATE_PASSWORD',
  organizationId: ids.org, restrictions: rights(), scopeIds: [ids.scope] });
const prepared = () => ({ id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user, state: 'pending', epoch: 1,
  restrictions: rights(), scopeIds: [ids.scope], intentSecret: 'a'.repeat(64), intentExpiresAt: NOW + 300000 });
const authorization = () => ({ userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org],
  membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null },
  permissions: rights(), companyCeilings: rights() });
const code = expected => error => error instanceof ConnectionControlError && error.code === expected && error.message === expected && error.cause === undefined;
function fixture(t, options = {}) {
  const calls = [], controller = new AbortController();
  const crypto = createSessionCrypto({ activeKeyVersion: 'test-key', keys: new Map([['test-key', Buffer.alloc(32, 4)]]) });
  t.after(() => crypto.destroy());
  const state = { now: NOW, pair: { accessToken: 'FRESH_ACCESS', refreshToken: 'FRESH_REFRESH' },
    prepared: prepared(), auth: authorization(), activation: null,
    browser: { userId: ids.user, sessionId: ids.browser, expiresAt: NOW + 3600000 },
    assistant: { userId: ids.user, sessionId: ids.session, expiresAt: NOW + 3600000 } };
  const auth = {
    verifySession: async input => {
      calls.push({ operation: 'verify', ...input }); await options.beforeVerify?.(state, input);
      return clone(input.accessToken === 'BROWSER_ACCESS' ? state.browser : state.assistant);
    },
    readAuthorization: async input => { calls.push({ operation: 'authorize', ...input }); await options.beforeRead?.(state, input); return clone(state.auth); },
  };
  const signInProvider = {
    signIn: async input => { calls.push({ operation: 'signIn', email: input.email, signal: input.signal });
      await options.beforeSignIn?.(state, input); return state.pair; },
  };
  const preparation = { prepareConnection: async (input, opts) => {
    calls.push({ operation: 'prepare', ...clone(input), signal: opts.signal }); await options.beforePrepare?.(state, input); return clone(state.prepared);
  } };
  const connectionStore = createDurableConnectionStore({ clock: () => state.now, transport: { call: async (operation, payload, opts) => {
    calls.push({ operation, payload: clone(payload), signal: opts.signal }); state.activation = clone(payload);
    await options.beforeActivate?.(state, payload);
    return { ok: true, status: 'activated', connection: { id: ids.connection, assistantId: ids.assistant, organizationId: ids.org,
      userId: ids.user, state: 'active', epoch: 2, restrictions: clone(state.prepared.restrictions), scopeIds: [ids.scope],
      ...(state.prepared.permissionMode ? {permissionMode:state.prepared.permissionMode,exclusions:clone(state.prepared.exclusions),scopeMode:state.prepared.scopeMode}: {}) }, credentialRef: payload.credentialRef };
  } } });
  const factory = createConnectionControlPlane({ auth, signInProvider, preparation, connectionStore, crypto,
    clock: () => state.now, ...options.factory });
  return { factory, crypto, state, calls, controller, connect: (input = request()) => factory.connect(input, { signal: controller.signal }) };
}

test('one backend sign-in creates an independently verified session, then primary-user prepare and atomic encrypted activation issue opaque token', async t => {
  const f = fixture(t), result = await f.connect();
  assert.deepEqual(f.calls.map(call => call.operation), ['verify', 'authorize', 'signIn', 'verify',
    'authorize', 'verify', 'authorize', 'prepare', 'activate']);
  assert.equal(result.status, 'active'); assert.match(result.token, /^hc_[A-Za-z0-9_-]{43}$/);
  assert.equal(result.tokenExpiresAt, NOW + 900000);
  assert.equal(f.state.activation.tokenDigest, createHash('sha256').update(result.token).digest('hex'));
  assert.equal(f.state.activation.providerSessionId, ids.session);
  const opened = f.crypto.open(f.state.activation.sessionEnvelope,
    { assistantId: ids.assistant, userId: ids.user, organizationId: ids.org, sessionId: ids.session });
  assert.deepEqual(opened, { ...f.state.pair, expiresAt: f.state.assistant.expiresAt });
  const sentPrepare = f.calls.find(call => call.operation === 'prepare');
  assert.equal(sentPrepare.accessToken, 'BROWSER_ACCESS');
  for (const secret of ['BROWSER_ACCESS', 'PRIVATE_PASSWORD', 'FRESH_ACCESS', 'FRESH_REFRESH', 'intentSecret', 'credentialRef']) {
    assert(!JSON.stringify(result).includes(secret), secret);
    assert(!JSON.stringify(f.state.activation).includes(secret) || secret === 'intentSecret' || secret === 'credentialRef', secret);
  }
  assert(f.calls.every(call => call.signal instanceof AbortSignal));
  assert.deepEqual(Object.keys(f.factory), ['connect']);
});

test('caller cannot submit existing session pairs, actor, endpoint, operation ids, unsupported actions or malformed credentials', async t => {
  for (const mutate of [input => { input.userId = ids.other; }, input => { input.password = ''; },
    input => { input.endpoint = 'https://foreign.invalid'; }, input => { input.operationId = ids.other; },
    input => { input.restrictions.read.push('future.unsupported_read'); }, input => { input.restrictions.action.push('rooms.delete'); },
    input => { input.scopeIds = new Array(1); }, input => { input.scopeIds.push(ids.scope); },
    input => { input.assistantSession = { accessToken: 'OWNED_ACCESS', refreshToken: 'OWNED_REFRESH' }; },
    input => { input.refreshToken = 'OWNED_REFRESH'; }, input => { input.email = 'invalid'; },
    input => { input.password = 'x'.repeat(4097); }]) {
    const f = fixture(t), input = request(); mutate(input);
    await assert.rejects(f.connect(input), code('invalid_request')); assert.equal(f.calls.length, 0);
  }
  for (const mutation of [{ sessionId: ids.browser }, { userId: ids.other }, { expiresAt: NOW }]) {
    const f = fixture(t); Object.assign(f.state.assistant, mutation);
    await assert.rejects(f.connect(), code('reauthentication_required'));
    assert.equal(f.calls.filter(call => call.operation === 'signIn').length, 1);
    assert(!f.calls.some(call => call.operation === 'prepare'));
  }
});

test('fresh provider session must verify as the same user with a different session before prepare or encryption', async t => {
  for (const mutation of [{ userId: ids.other }, { sessionId: ids.browser }, { sessionId: 'bad' }, { expiresAt: NOW },
    { expiresAt: NOW + 86400001 }]) {
    const f = fixture(t); Object.assign(f.state.assistant, mutation);
    await assert.rejects(f.connect(), code('reauthentication_required'));
    assert.equal(f.calls.filter(call => call.operation === 'signIn').length, 1);
    assert(!f.calls.some(call => call.operation === 'prepare'));
  }
  for (const pair of [null, { accessToken: 'FRESH_ACCESS', refreshToken: '' }, { accessToken: 'FRESH_ACCESS', refreshToken: 'FRESH_REFRESH', userId: ids.user }]) {
    const f = fixture(t); f.state.pair = pair;
    await assert.rejects(f.connect(), code('reauthentication_required'));
  }
});

test('current membership and permissions gate both browser and new session, including drift after provider call', async t => {
  for (const mutate of [auth => { auth.activeOrganizationIds.push(ids.other); }, auth => { auth.membership.revokedAt = NOW; },
    auth => { auth.membership.validTo = NOW; }, auth => { auth.membership.validFrom = NOW + 1; },
    auth => { auth.membership.organizationId = ids.other; }, auth => { auth.permissions.read = []; },
    auth => { auth.companyCeilings.read = []; }, auth => { auth.isSuperadmin = true; auth.activeOrganizationIds = []; }]) {
    const f = fixture(t); mutate(f.state.auth);
    await assert.rejects(f.connect(), code('forbidden')); assert(!f.calls.some(call => call.operation === 'signIn'));
  }
  const f = fixture(t, { beforeSignIn: state => { state.auth.permissions.read = []; } });
  await assert.rejects(f.connect(), code('forbidden')); assert(!f.calls.some(call => call.operation === 'prepare'));
  const g = fixture(t, { beforeSignIn: state => { state.browser.sessionId = ids.other; } });
  await assert.rejects(g.connect(), code('reauthentication_required'));
  assert(!g.calls.some(call => call.operation === 'prepare'));
});

test('mutating caller input or provider result during awaits cannot change bound token material or intent', async t => {
  const input = request();
  let submittedPassword;
  const f = fixture(t, { beforeVerify: () => { input.organizationId = ids.other; input.scopeIds.length = 0; input.password = 'FOREIGN'; },
    beforeSignIn: (_state, value) => { submittedPassword = value.password; },
    beforeRead: (state, value) => { if (value.accessToken === 'FRESH_ACCESS') state.pair.refreshToken = 'FOREIGN'; } });
  await f.connect(input);
  assert.equal(submittedPassword, 'PRIVATE_PASSWORD');
  assert.equal(f.calls.find(call => call.operation === 'prepare').organizationId, ids.org);
  assert.deepEqual(f.calls.find(call => call.operation === 'prepare').scopeIds, [ids.scope]);
  assert.equal(f.crypto.open(f.state.activation.sessionEnvelope, { assistantId: ids.assistant, userId: ids.user,
    organizationId: ids.org, sessionId: ids.session }).refreshToken, 'FRESH_REFRESH');
});

test('prepare ACK must attest exact actor, organization, requested restrictions, scopes and live intent', async t => {
  for (const mutate of [value => { value.userId = ids.other; }, value => { value.organizationId = ids.other; },
    value => { value.intentSecret = 'bad'; }, value => { value.intentExpiresAt = NOW; },
    value => { value.intentExpiresAt = NOW + 330001; }, value => { value.restrictions.read = []; },
    value => { value.scopeIds = []; }, value => { value.state = 'active'; }, value => { value.token = 'PRIVATE'; }]) {
    const f = fixture(t); mutate(f.state.prepared);
    await assert.rejects(f.connect(), code('prepare_outcome_unknown'));
    assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 1);
    assert(!f.calls.some(call => call.operation === 'activate'));
  }
});

test('provider uncertainty does not retry login or create a pending intent; error never exposes credentials', async t => {
  const f = fixture(t, { beforeSignIn: () => { throw new Error('PRIVATE_PASSWORD private upstream'); } });
  await assert.rejects(f.connect(), code('sign_in_outcome_unknown'));
  assert.equal(f.calls.filter(call => call.operation === 'signIn').length, 1);
  assert(!f.calls.some(call => call.operation === 'prepare'));
});

test('unknown prepare/activate ACK never retries, compensates or returns an opaque credential', async t => {
  const f = fixture(t, { beforePrepare: () => { throw new Error('intent-secret unknown write'); } });
  await assert.rejects(f.connect(), code('prepare_outcome_unknown'));
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 1);
  assert(!f.calls.some(call => call.operation === 'activate'));
  const g = fixture(t, { beforeActivate: () => { throw new StoreTransportError('store_outcome_unknown'); } });
  await assert.rejects(g.connect(), error => {
    assert(code('activation_outcome_unknown')(error));
    assert.deepEqual(Object.keys(error.receipt).sort(), ['connectionId', 'operationId']);
    assert.equal(error.receipt.connectionId, ids.connection);
    assert(!JSON.stringify(error).includes('token')); return true;
  });
  assert.equal(g.calls.filter(call => call.operation === 'activate').length, 1);
  assert.equal(g.calls.filter(call => call.operation === 'signIn').length, 1);
});

test('atomic denial/conflict remain final denials, while malformed successful ACK stays unknown', async t => {
  for (const [upstream, expected] of [['store_denied', 'forbidden'], ['store_conflict', 'context_changed'], ['store_rejected', 'activation_rejected']]) {
    const f = fixture(t, { beforeActivate: () => { throw new StoreTransportError(upstream); } });
    await assert.rejects(f.connect(), code(expected));
  }
  for (const result of [null, { ok: false }, { ok: true, status: 'activated', connection: {}, credentialRef: ids.other }]) {
    const f = fixture(t, { factory: { connectionStore: { activate: async () => result } } });
    await assert.rejects(f.connect(), code('activation_outcome_unknown'));
  }
});

test('cancellation and timeout stop late provider/activation completion without issuing or retrying', async t => {
  const prior = fixture(t); prior.controller.abort();
  await assert.rejects(prior.connect(), code('cancelled')); assert.equal(prior.calls.length, 0);
  let settle;
  const f = fixture(t, { factory: { timeoutMs: 10 }, beforeSignIn: () => new Promise(resolve => { settle = resolve; }) });
  await assert.rejects(f.connect(), code('sign_in_outcome_unknown'));
  settle(); await new Promise(resolve => setImmediate(resolve));
  assert(!f.calls.some(call => call.operation === 'prepare')); assert(f.calls.every(call => call.signal.aborted));
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const g = fixture(t, { beforeActivate: async () => { entered(); await blocked; } });
  const result = g.connect(); await ready;
  const denied = assert.rejects(result, code('activation_outcome_unknown')); g.controller.abort(); await denied;
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.calls.filter(call => call.operation === 'activate').length, 1);
});

test('opaque lifetime is capped by actual verified session and no output survives expiry while activation awaits', async t => {
  const f = fixture(t); f.state.assistant.expiresAt = NOW + 12345;
  assert.equal((await f.connect()).tokenExpiresAt, NOW + 12345);
  const g = fixture(t, { beforeActivate: state => { state.now += 900001; } });
  await assert.rejects(g.connect(), code('activation_outcome_unknown'));
  assert.throws(() => createConnectionControlPlane({}), /invalid_connection_control_config/);
});

test('host ahead of database cannot extend opaque expiry beyond the SQL activation maximum', async t => {
  for (const elapsedAfterPrepare of [0, 1500]) {
    const f = fixture(t, {
      beforePrepare: state => { state.now += elapsedAfterPrepare; },
      beforeActivate: (_state, payload) => {
        // Simulate the existing SQL clock bound, not a relaxed API mock.
        if (payload.tokenExpiresAt > NOW + 900000) throw new StoreTransportError('store_conflict');
      },
    });
    f.state.now = NOW + 7000;
    const result = await f.connect();
    assert.equal(result.tokenExpiresAt, NOW + 900000);
    assert.equal(f.calls.filter(call => call.operation === 'activate').length, 1);
  }
});

test('bounded database-ahead prepare response does not extend configured TTL or the database maximum', async t => {
  for (const ahead of [7000, 30000]) {
    const f = fixture(t); f.state.prepared.intentExpiresAt = NOW + ahead + 300000;
    assert.equal((await f.connect()).tokenExpiresAt, NOW + 900000);
  }
  const invalid = fixture(t); invalid.state.prepared.intentExpiresAt = NOW + 30001 + 300000;
  await assert.rejects(invalid.connect(), code('prepare_outcome_unknown'));
  assert(!invalid.calls.some(call => call.operation === 'activate'));
});

test('short server-anchored TTL already expired on this host is rejected before activation dispatch', async t => {
  const f = fixture(t, { factory: { tokenLifetimeMs: 1000 } }); f.state.now = NOW + 7000;
  await assert.rejects(f.connect(), code('reauthentication_required'));
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 1);
  assert(!f.calls.some(call => call.operation === 'activate'));
});

test('server expiry anchor remains capped by configured lifetime and verified assistant expiry', async t => {
  const short = fixture(t, { factory: { tokenLifetimeMs: 60000 } }); short.state.now = NOW + 7000;
  assert.equal((await short.connect()).tokenExpiresAt, NOW + 60000);
  const session = fixture(t); session.state.now = NOW + 7000; session.state.assistant.expiresAt = NOW + 20000;
  assert.equal((await session.connect()).tokenExpiresAt, NOW + 20000);
});

test('current SQL prepare contract still issues a five-minute database-clock intent', () => {
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  let current;
  for (const name of readdirSync(directory).filter(name => /hermes.*\.sql$/i.test(name)).sort()) {
    for (const statement of splitSqlStatements(readFileSync(new URL(name, directory), 'utf8'))) {
      const definition = statement.replace(/--[^\n]*/g, '').trim();
      if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.hermes_prepare_connection_v1\(/i.test(definition)) current = definition;
    }
  }
  assert(current, 'latest Hermes prepare definition must be found');
  assert.match(current, /clock_timestamp\(\)\s*\+\s*interval\s*'5 minutes'/i);
});

test('already-owned assistant credentials have no input path; parallel connects each require their own fresh provider sign-in', async t => {
  const a = fixture(t), b = fixture(t); b.state.assistant.sessionId = ids.other;
  const oldInput = { browserAccessToken: 'BROWSER_ACCESS', assistantSession: { accessToken: 'OWNED_ACCESS', refreshToken: 'OWNED_REFRESH' },
    organizationId: ids.org, restrictions: rights(), scopeIds: [ids.scope] };
  await assert.rejects(a.connect(oldInput), code('invalid_request')); assert.equal(a.calls.length, 0);
  await Promise.all([a.connect(), b.connect()]);
  assert.equal(a.state.activation.providerSessionId, ids.session);
  assert.equal(b.state.activation.providerSessionId, ids.other);
  for (const f of [a, b]) {
    assert.equal(f.calls.filter(call => call.operation === 'signIn').length, 1);
    assert(!f.calls.some(call => call.operation === 'refresh'));
  }
});

test('password input references are dropped after sign-in and additional-auth requirements never reach prepare', async t => {
  let captured;
  const f = fixture(t, { beforeSignIn: (_state, input) => { captured = input; assert.equal(input.password, 'PRIVATE_PASSWORD'); } });
  const result = await f.connect(); assert.equal(captured.password, '');
  assert(!JSON.stringify([result, f.state.activation]).includes('PRIVATE_PASSWORD'));
  const blocked = fixture(t, { beforeSignIn: () => { throw new ConnectionControlError('additional_authentication_required'); } });
  await assert.rejects(blocked.connect(), code('additional_authentication_required'));
  assert(!blocked.calls.some(call => call.operation === 'prepare'));
});

const prepInput = () => ({ accessToken: 'BROWSER_ACCESS', organizationId: ids.org, restrictions: rights(), scopeIds: [ids.scope] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function prepAdapter(options = {}) {
  const calls = [], controller = new AbortController();
  const adapter = createSupabaseConnectionPreparation({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    fetch: async (url, input) => { calls.push({ url, ...input }); return options.respond ? options.respond(input) : json(prepared()); }, ...options.config });
  return { adapter, calls, controller, run: (input = prepInput()) => adapter.prepareConnection(input, { signal: controller.signal }) };
}

test('preparation adapter fixes public RPC, browser bearer and public schema profiles; no runtime-selected endpoint', async () => {
  const f = prepAdapter(); assert.deepEqual(await f.run(), prepared());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://fixture.supabase.co/rest/v1/rpc/hermes_prepare_connection_v1');
  assert.equal(f.calls[0].headers.authorization, 'Bearer BROWSER_ACCESS');
  assert.equal(f.calls[0].headers['accept-profile'], 'public'); assert.equal(f.calls[0].headers['content-profile'], 'public');
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { p_org: ids.org, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [ids.scope] });
});

test('preparation writes distinguish known rejection from network/HTTP5xx or malformed ACK uncertainty without retry', async () => {
  for (const [response, expected] of [[() => json({ code: '42501', message: 'private detail' }, 403), 'forbidden'],
    [() => json({ message: 'invalid token' }, 401), 'reauthentication_required'],
    [() => json({ code: '22023' }, 400), 'prepare_rejected'], [() => json({ code: '40001' }, 409), 'prepare_rejected'],
    [() => json({ code: 'XX000' }, 500), 'prepare_outcome_unknown'],
    [() => json({ error: 'private error envelope' }), 'prepare_outcome_unknown'],
    [() => new Response('<html>PRIVATE</html>'), 'prepare_outcome_unknown'],
    [() => { throw new Error('PRIVATE'); }, 'prepare_outcome_unknown']]) {
    const f = prepAdapter({ respond: response });
    await assert.rejects(f.run(), code(expected)); assert.equal(f.calls.length, 1);
  }
});

test('preparation I/O is bounded and cancellation cannot turn a dispatched write into a safe retry', async () => {
  const oversized = prepAdapter({ config: { maxResponseBytes: 50 } });
  await assert.rejects(oversized.run(), code('prepare_outcome_unknown'));
  const unresponsive = prepAdapter({ config: { timeoutMs: 10 }, respond: () => new Promise(() => {}) });
  await assert.rejects(unresponsive.run(), code('prepare_outcome_unknown'));
  assert.equal(unresponsive.calls.length, 1); assert(unresponsive.calls[0].signal.aborted);
  const prior = prepAdapter(); prior.controller.abort(); await assert.rejects(prior.run(), code('cancelled'));
  assert.equal(prior.calls.length, 0);
  for (const config of [{ url: 'http://fixture.supabase.co' }, { url: 'https://fixture.supabase.co/other' },
    { url: 'https://user:pass@fixture.supabase.co' }, { publishableKey: 'sb_secret_private' }]) {
    assert.throws(() => prepAdapter({ config }), /invalid_connection_preparation_config/);
  }
});

const loginInput = signal => ({ email: 'fixture@example.invalid', password: 'PRIVATE_PASSWORD', signal });
const authResponse = () => ({ access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', token_type: 'bearer',
  user: { id: ids.user, factors: [] }, expires_in: 3600, expires_at: NOW / 1000 + 3600 });
function signInAdapter(options = {}) {
  const calls = [], controller = new AbortController();
  const adapter = createSupabaseAssistantSignIn({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    fetch: async (url, input) => { calls.push({ url, ...input }); return options.respond ? options.respond(input) : json(authResponse()); }, ...options.config });
  return { adapter, calls, controller, run: (input = loginInput(controller.signal)) => adapter.signIn(input) };
}

test('fresh sign-in adapter fixes HTTPS password endpoint and returns only provider-issued pair', async () => {
  const f = signInAdapter(); assert.deepEqual(await f.run(), { accessToken: 'NEW_ACCESS', refreshToken: 'NEW_REFRESH' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://fixture.supabase.co/auth/v1/token?grant_type=password');
  assert.deepEqual(JSON.parse(f.calls[0].body), { email: 'fixture@example.invalid', password: 'PRIVATE_PASSWORD' });
  assert.equal(f.calls[0].headers.apikey, 'sb_publishable_fixture');
  assert.equal(f.calls[0].headers.authorization, undefined); assert.equal(f.calls[0].redirect, 'error');
  for (const bad of [{ refreshToken: 'OWNED', signal: f.controller.signal }, { ...loginInput(f.controller.signal), accessToken: 'OWNED' },
    { ...loginInput(f.controller.signal), password: '' }, { ...loginInput(f.controller.signal), email: 'not-email' }]) {
    await assert.rejects(f.run(bad), code('invalid_request'));
  }
  assert.equal(f.calls.length, 1);
});

test('MFA-enrolled users and challenge/SSO/captcha requirements are refused without downgrade or retry', async () => {
  for (const value of [
    { ...authResponse(), user: { id: ids.user, factors: [{ status: 'verified', factor_type: 'totp' }] } },
    { ...authResponse(), mfa_required: true }, { error_code: 'mfa_verification_failed' },
    { code: 'insufficient_aal' }, { error_code: 'captcha_failed' }, { error_code: 'sso_provider_not_found' },
  ]) {
    const f = signInAdapter({ respond: () => json(value, value.access_token ? 200 : 400) });
    await assert.rejects(f.run(), code('additional_authentication_required')); assert.equal(f.calls.length, 1);
  }
  const pending = signInAdapter({ respond: () => json({ ...authResponse(), user: { id: ids.user, factors: [{ status: 'unverified' }] } }) });
  assert.equal((await pending.run()).accessToken, 'NEW_ACCESS');
});

test('fresh sign-in denial and unknown outcomes expose no password, pair or cause; dispatched attempts are never retried', async () => {
  for (const [respond, expected] of [
    [() => json({ error: 'invalid_grant', error_description: 'PRIVATE_PASSWORD' }, 400), 'reauthentication_required'],
    [() => json({ message: 'private' }, 429), 'reauthentication_required'],
    [() => json({ error: 'PRIVATE_PASSWORD' }, 500), 'sign_in_outcome_unknown'],
    [() => { throw new Error('PRIVATE_PASSWORD NEW_REFRESH'); }, 'sign_in_outcome_unknown'],
    [() => json({ ...authResponse(), token_type: 'other' }), 'sign_in_outcome_unknown'],
    [() => json({ ...authResponse(), user: { id: ids.user, factors: null } }), 'sign_in_outcome_unknown'],
    [() => json({ ...authResponse(), refresh_token: '' }), 'sign_in_outcome_unknown'],
  ]) {
    const f = signInAdapter({ respond });
    await assert.rejects(f.run(), error => {
      assert(code(expected)(error)); assert(!JSON.stringify(error).includes('PRIVATE')); return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('fresh sign-in bounds streamed result and late timeout; invalid config cannot select credentials/HTTP endpoint', async () => {
  const oversized = signInAdapter({ config: { maxResponseBytes: 16 } });
  await assert.rejects(oversized.run(), code('sign_in_outcome_unknown'));
  let finish;
  const timed = signInAdapter({ config: { timeoutMs: 10 }, respond: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects(timed.run(), code('sign_in_outcome_unknown'));
  finish(json(authResponse())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timed.calls.length, 1); assert(timed.calls[0].signal.aborted);
  const prior = signInAdapter(); prior.controller.abort(); await assert.rejects(prior.run(), code('cancelled'));
  assert.equal(prior.calls.length, 0);
  for (const config of [{ url: 'http://fixture.supabase.co' }, { url: 'https://fixture.supabase.co/other' },
    { url: 'https://user:pass@fixture.supabase.co' }, { publishableKey: 'sb_secret_private' }]) {
    assert.throws(() => signInAdapter({ config }), /invalid_assistant_sign_in_config/);
  }
});


test('host handoff persists exact verified owner and opaque token before activation, without provider secrets', { timeout: 1000 }, async t => {
  let captured, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { factory: { handoff: { async stage(record, { signal }) {
    captured = structuredClone(record); assert(signal instanceof AbortSignal); entered(); await hold;
    return { status: 'stored', connectionId: record.connectionId, operationId: record.operationId };
  } } } });
  const pending = f.connect(); await waiting;
  try {
    assert.equal(f.calls.filter(call => call.operation === 'activate').length, 0);
    assert.deepEqual(Object.keys(captured).sort(), ['assistantId', 'connectionId', 'operationId', 'organizationId', 'token', 'userId']);
    assert.deepEqual([captured.connectionId, captured.assistantId, captured.userId, captured.organizationId],
      [ids.connection, ids.assistant, ids.user, ids.org]);
    for (const secret of ['BROWSER_ACCESS', 'PRIVATE_PASSWORD', 'FRESH_ACCESS', 'FRESH_REFRESH', 'intentSecret', 'credentialRef']) {
      assert(!JSON.stringify(captured).includes(secret));
    }
  } finally { release(); }
  const result = await pending;
  assert.equal(result.token, captured.token);
  assert.equal(f.state.activation.operationId, captured.operationId);
  assert.equal(f.state.activation.tokenDigest, createHash('sha256').update(captured.token).digest('hex'));
});

test('host handoff malformed or foreign ACK prevents activation and returns only an unknown enrollment receipt', async t => {
  for (const mutate of [ack => null, ack => ({ ...ack, connectionId: ids.other }),
    ack => ({ ...ack, operationId: ids.other }), ack => ({ ...ack, status: 'pending' }),
    ack => ({ ...ack, secret: 'PRIVATE' }), ack => Object.defineProperty(ack, 'status', { get() { throw Error('getter invoked'); } })]) {
    let seen;
    const f = fixture(t, { factory: { handoff: { async stage(record) {
      seen = structuredClone(record); return mutate({ status: 'stored', connectionId: record.connectionId, operationId: record.operationId });
    } } } });
    await assert.rejects(f.connect(), error => {
      assert(code('activation_outcome_unknown')(error));
      assert.deepEqual(error.receipt, { connectionId: ids.connection, operationId: seen.operationId });
      assert(!JSON.stringify(error).includes(seen.token)); return true;
    });
    assert.equal(f.calls.filter(call => call.operation === 'activate').length, 0);
  }
});

test('host handoff failure or cancelled late persistence never retries stage, signs in again or activates', async t => {
  for (const cancel of [false, true]) {
    let count = 0, finish, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, { factory: { handoff: { async stage(record) {
      count++; entered();
      if (!cancel) throw Error('PRIVATE_STORAGE_PATH token-secret');
      await new Promise(resolve => { finish = resolve; });
      return { status: 'stored', connectionId: record.connectionId, operationId: record.operationId };
    } } } });
    const work = f.connect(), rejected = assert.rejects(work, code('activation_outcome_unknown'));
    await waiting;
    if (cancel) f.controller.abort();
    await rejected;
    if (cancel) { finish(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(count, 1); assert.equal(f.calls.filter(call => call.operation === 'signIn').length, 1);
    assert.equal(f.calls.filter(call => call.operation === 'activate').length, 0);
  }
});

test('unknown activation leaves pre-staged handoff available for read-only host reconciliation', async t => {
  const records = [];
  const f = fixture(t, { factory: { handoff: { async stage(record) {
    records.push(structuredClone(record)); return { status: 'stored', connectionId: record.connectionId, operationId: record.operationId };
  } } }, beforeActivate: () => { throw new StoreTransportError('store_outcome_unknown'); } });
  await assert.rejects(f.connect(), code('activation_outcome_unknown'));
  assert.equal(records.length, 1); assert.equal(f.calls.filter(call => call.operation === 'activate').length, 1);
  assert.equal(f.state.activation.tokenDigest, createHash('sha256').update(records[0].token).digest('hex'));
});

test('handoff configuration rejects missing, accessor or unknown methods without executing them', t => {
  for (const handoff of [null, {}, { stage: false }, { stage() {}, list() {} }, Object.defineProperty({}, 'stage', { get() { throw Error('PRIVATE'); } })]) {
    assert.throws(() => fixture(t, { factory: { handoff } }), /invalid_connection_control_config/);
  }
});

test('rooms enrollment is allowed only through both current user permissions and the company ceiling', async t => {
  const read=['assistant.context.read','rooms.view'];
  const f=fixture(t); f.state.auth.permissions.read=[...read]; f.state.auth.companyCeilings.read=[...read]; f.state.prepared.restrictions.read=[...read];
  const result=await f.connect({...request(),restrictions:{read,action:[]}});
  assert.deepEqual(result.connection.restrictions,{read,action:[]});
  assert.deepEqual(f.calls.find(c=>c.operation==='prepare').restrictions,{read,action:[]});
  for(const denied of ['permissions','companyCeilings']) {
    const g=fixture(t);g.state.auth.permissions.read=[...read];g.state.auth.companyCeilings.read=[...read];g.state.auth[denied].read=['assistant.context.read'];
    await assert.rejects(g.connect({...request(),restrictions:{read,action:[]}}),code('forbidden'));
    assert(!g.calls.some(c=>c.operation==='signIn'||c.operation==='prepare'));
  }
});
test('rooms authority revoked during fresh assistant authentication prevents enrollment without replay', async t=>{
  let reads=0;
  const f=fixture(t,{beforeRead(state){if(++reads===2)state.auth.permissions.read=['assistant.context.read'];}});
  f.state.auth.permissions.read=['assistant.context.read','rooms.view'];f.state.auth.companyCeilings.read=['assistant.context.read','rooms.view'];
  await assert.rejects(f.connect({...request(),restrictions:{read:['rooms.view'],action:[]}}),code('forbidden'));
  assert.equal(f.calls.filter(c=>c.operation==='signIn').length,1);assert(!f.calls.some(c=>c.operation==='prepare'));
});

test('explicit fixed action is preserved through user-policy checks, prepare, activation and opaque result',async t=>{
 const f=fixture(t),input=request();input.restrictions.action=['chat_zalo.send'];f.state.auth.permissions.action=['chat_zalo.send'];f.state.auth.companyCeilings.action=['chat_zalo.send'];f.state.prepared.restrictions.action=['chat_zalo.send'];
 const result=await f.connect(input);assert.deepEqual(result.connection.restrictions.action,['chat_zalo.send']);assert.deepEqual(f.calls.find(c=>c.operation==='prepare').restrictions.action,['chat_zalo.send']);assert.equal(f.calls.filter(c=>c.operation==='activate').length,1);
});

test('sale actions remain opt-in and each requested action needs both current user rights and company permission', async t => {
  const actions = ['rooms.edit', 'sale_phong.edit', 'sale_phong.manage_images', 'sale_phong.lock_room', 'deposits.create', 'deposits.edit'];
  const unrequested = fixture(t);
  unrequested.state.auth.permissions.action = [...actions];
  unrequested.state.auth.companyCeilings.action = [...actions];
  assert.deepEqual((await unrequested.connect()).connection.restrictions.action, []);
  assert.deepEqual(unrequested.calls.find(call => call.operation === 'prepare').restrictions.action, []);
  for (const action of actions) {
    const accepted = fixture(t), input = request();
    input.restrictions.action = [action];
    accepted.state.auth.permissions.action = [...actions];
    accepted.state.auth.companyCeilings.action = [...actions];
    accepted.state.prepared.restrictions.action = [action];
    assert.deepEqual((await accepted.connect(input)).connection.restrictions.action, [action]);
    assert.deepEqual(accepted.calls.find(call => call.operation === 'prepare').restrictions.action, [action]);
    for (const authority of ['permissions', 'companyCeilings']) {
      const denied = fixture(t);
      denied.state.auth.permissions.action = [...actions];
      denied.state.auth.companyCeilings.action = [...actions];
      denied.state.auth[authority].action = actions.filter(key => key !== action);
      await assert.rejects(denied.connect(input), code('forbidden'));
      assert(!denied.calls.some(call => ['signIn', 'prepare', 'activate'].includes(call.operation)));
    }
  }
});

test('group read can enroll with no rooms or send grant',async t=>{
 const f=fixture(t),input=request();input.restrictions={read:['chat_zalo.view'],action:[]};
 f.state.auth.permissions=input.restrictions;f.state.auth.companyCeilings=input.restrictions;f.state.prepared.restrictions=input.restrictions;
 const result=await f.connect(input);assert.deepEqual(result.connection.restrictions,{read:['chat_zalo.view'],action:[]});
});
test('fixed action cannot exceed current user or company ceilings and rejects before sign-in',async t=>{
 for(const kind of ['permissions','companyCeilings']){const f=fixture(t),input=request();input.restrictions.action=['chat_zalo.send'];f.state.auth.permissions.action=['chat_zalo.send'];f.state.auth.companyCeilings.action=['chat_zalo.send'];f.state.auth[kind].action=[];await assert.rejects(f.connect(input),code('forbidden'));assert(!f.calls.some(c=>c.operation==='signIn'));}
});
test('prepare action ACK must exactly equal requested action and cannot add or drop one',async t=>{
 for(const requested of [[],['chat_zalo.send']]){const f=fixture(t),input=request();input.restrictions.action=requested;f.state.auth.permissions.action=['chat_zalo.send'];f.state.auth.companyCeilings.action=['chat_zalo.send'];f.state.prepared.restrictions.action=requested.length?[]:['chat_zalo.send'];await assert.rejects(f.connect(input),code('prepare_outcome_unknown'));assert(!f.calls.some(c=>c.operation==='activate'));}
});
test('activation dropping the selected action is an unknown outcome with no returned token',async t=>{
 const f=fixture(t,{beforeActivate(state){state.prepared.restrictions.action=[]}}),input=request();input.restrictions.action=['chat_zalo.send'];f.state.auth.permissions.action=['chat_zalo.send'];f.state.auth.companyCeilings.action=['chat_zalo.send'];f.state.prepared.restrictions.action=['chat_zalo.send'];await assert.rejects(f.connect(input),code('activation_outcome_unknown'));
});
test('control-plane independently rejects an activation port that adds or drops fixed action',async t=>{
 for(const requested of [[],['chat_zalo.send']]){
  const f=fixture(t,{factory:{connectionStore:{async activate(input){const p=input.prepared;return {ok:true,status:'activated',credentialRef:input.credentialRef,connection:{id:p.id,assistantId:p.assistantId,organizationId:p.organizationId,userId:p.userId,state:'active',epoch:p.epoch+1,restrictions:{...p.restrictions,action:requested.length?[]:['chat_zalo.send']},scopeIds:p.scopeIds}}}}}}),input=request();input.restrictions.action=requested;f.state.prepared.restrictions.action=requested;f.state.auth.permissions.action=['chat_zalo.send'];f.state.auth.companyCeilings.action=['chat_zalo.send'];await assert.rejects(f.connect(input),code('activation_outcome_unknown'));
 }
});


test('inheritance enrollment attests explicit exclusions instead of requiring every registry projection key as a CRM grant',async t=>{
 const f=fixture(t), input=request();delete input.restrictions;
 Object.assign(input,{permissionMode:'inherit_crm',exclusions:{read:['customers.view'],action:['tasks.create']},scopeMode:'unrestricted',scopeIds:[]});
 Object.assign(f.state.prepared,{permissionMode:input.permissionMode,exclusions:structuredClone(input.exclusions),scopeMode:'unrestricted'});
 // Projection includes supported capabilities the user does not have yet.
 f.state.prepared.restrictions.read.push('rooms.view');
 const value=await f.connect(input);assert.equal(value.connection.permissionMode,'inherit_crm');assert.deepEqual(value.connection.exclusions,input.exclusions);
 const prepare=f.calls.find(c=>c.operation==='prepare');assert.equal(prepare.restrictions,undefined);assert.deepEqual(prepare.exclusions,input.exclusions);
 assert.equal(f.calls.filter(c=>c.operation==='signIn').length,1);
});

test('inheritance prepare adapter uses v2 only and sends no legacy allowlist',async()=>{
 const calls=[];const adapter=createSupabaseConnectionPreparation({url:'https://fixture.supabase.co',publishableKey:'sb_publishable_fixture',
 fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({fixture:true}),{headers:{'content-type':'application/json'}});}});
 await adapter.prepareConnection({accessToken:'BROWSER_ACCESS',organizationId:ids.org,permissionMode:'inherit_crm',exclusions:{read:['customers.view'],action:[]},scopeMode:'unrestricted',scopeIds:[]},{signal:new AbortController().signal});
 assert(calls[0].url.endsWith('/hermes_prepare_connection_v2'));assert.deepEqual(calls[0].body,{p_org:ids.org,p_excluded_read:['customers.view'],p_excluded_action:[],p_scope_mode:'unrestricted',p_scope_ids:[]});
});
