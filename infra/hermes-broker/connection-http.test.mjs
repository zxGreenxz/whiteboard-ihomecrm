import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createConnectionHttpHandler } from './connection-http.mjs';
import { ConnectionControlError, createConnectionControlPlane } from './connection-control-plane.mjs';
import { ConnectionManagementError, createConnectionManagement } from './connection-management.mjs';

const HOST = 'broker.example:8443', ORIGIN = 'https://crm.example', PREFIX = '/api/hermes/connections/';
const ids = { org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  connection: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assistant: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', membership: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  other: '11111111-1111-4111-8111-111111111111' };
const NOW = 1_800_000_000_000;
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const row = () => ({ id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user,
  state: 'active', epoch: 2, restrictions: limits(), scopeIds: [] });
const context = () => ({ ...row(), membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false,
  policyVersion: 1, companyCeilings: limits(), effective: limits() });
const body = operation => ({ organizationId: ids.org,
  ...(operation === 'connect' ? { email: 'synthetic@example.invalid', password: 'synthetic-password', restrictions: limits(), scopeIds: [] } : {}),
  ...(!['connect', 'list', 'options'].includes(operation) ? { connectionId: ids.connection } : {}),
  ...(['restrict', 'revoke'].includes(operation) ? { expectedEpoch: 2 } : {}),
  ...(operation === 'restrict' ? { restrictions: { read: [], action: [] }, scopeIds: [] } : {}) });
const result = operation => operation === 'connect' ? { status: 'active', connection: row(), token: `hc_${'a'.repeat(43)}`, tokenExpiresAt: NOW + 60_000 }
  : operation === 'options' ? { options: { userId: ids.user, organizationId: ids.org, membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1, enabled: true, read: ['assistant.context.read'], action: [], scopes: [] } } : operation === 'list' ? { connections: [row()] } : operation === 'context' ? { context: context() }
    : operation === 'restrict' ? { ok: true, connection: { ...row(), epoch: 3, restrictions: { read: [], action: [] } } }
      : { ok: true, status: 'revoked', connectionId: ids.connection };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
function dependencies() {
  const calls = [], methods = Object.fromEntries(['connect', 'list', 'context', 'options', 'restrict', 'revoke'].map(operation => [operation,
    async (input, options) => { calls.push({ operation, input: structuredClone(input), signal: options.signal }); return result(operation); }]));
  return { calls, controlPlane: { connect: methods.connect }, management: Object.fromEntries(Object.entries(methods).filter(([key]) => key !== 'connect')) };
}
async function fixture(t, options = {}) {
  const deps = dependencies();
  const handler = createConnectionHttpHandler({ ...deps, allowedHosts: [HOST], allowedOrigins: [ORIGIN], ...options });
  const server = createServer(async (request, response) => {
    if (!await handler(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const address = `http://127.0.0.1:${server.address().port}`;
  function send(operation, { value = body(operation), raw, headers = {}, path = PREFIX + operation, method = 'POST', chunks } = {}) {
    return new Promise((resolve, reject) => {
      const standard = { host: HOST, origin: ORIGIN, authorization: 'Bearer browser.jwt.token', 'content-type': 'application/json', ...headers };
      for (const key of Object.keys(standard)) if (standard[key] === undefined) delete standard[key];
      const request = httpRequest(address + path, { method, headers: standard }, response => {
        const parts = []; response.on('data', part => parts.push(part));
        response.on('end', () => { const text = Buffer.concat(parts).toString(); resolve({ status: response.statusCode,
          headers: response.headers, text, body: text ? JSON.parse(text) : undefined }); });
        response.on('error', reject);
      });
      request.on('error', reject);
      if (chunks) { for (const part of chunks) request.write(part); request.end(); }
      else request.end(raw ?? JSON.stringify(value));
    });
  }
  return { ...deps, send, address, server };
}

test('all six real HTTP routes forward the browser header and exact primitive fields with safe output headers', async t => {
  const f = await fixture(t);
  for (const operation of ['connect', 'list', 'context', 'options', 'restrict', 'revoke']) {
    const response = await f.send(operation);
    assert.equal(response.status, 200); assert.deepEqual(response.body, result(operation));
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const call = f.calls.at(-1);
    assert.equal(call.operation, operation); assert.deepEqual(call.input, { browserAccessToken: 'browser.jwt.token', ...body(operation) });
    assert(call.signal instanceof AbortSignal); assert(call.signal.aborted);
  }
  assert.equal(f.calls.length, 6);
});

test('status route exists only with a health port, needs only the org and projects activity without secrets', async t => {
  const absent = await fixture(t);
  assert.equal((await absent.send('status', { value: { organizationId: ids.org } })).status, 404); assert.equal(absent.calls.length, 0);
  const activity = () => ({ connector: { version: '0.2.0', startedAt: NOW, observedAt: NOW + 5 },
    connections: [{ id: ids.connection, lastSuccessAt: NOW + 1, lastToolCallAt: null, lastErrorCode: 'rate_limited', lastErrorAt: NOW + 2 }] });
  let output = activity(); const calls = [];
  const f = await fixture(t, { management: { ...dependencies().management, async status(input, options) {
    calls.push(structuredClone(input)); assert(options.signal instanceof AbortSignal); return output; } } });
  const ok = await f.send('status', { value: { organizationId: ids.org } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body, activity());
  assert.deepEqual(calls, [{ browserAccessToken: 'browser.jwt.token', organizationId: ids.org }]);
  assert.equal((await f.send('status', { value: { organizationId: ids.org, connectionId: ids.connection } })).status, 400);
  for (const change of [value => { value.connections[0].token = 'hc_secret'; }, value => { value.connector.version = 'latest'; },
    value => { value.connections[0].lastErrorAt = null; }, value => { value.connections[0].lastErrorCode = 'Bearer x'; },
    value => { value.connections.push(structuredClone(value.connections[0])); }, value => { value.connector.secret = 1; },
    value => { value.connections[0].lastSuccessAt = -1; }]) {
    output = activity(); change(output);
    const refused = await f.send('status', { value: { organizationId: ids.org } });
    assert.equal(refused.status, 503); assert.deepEqual(refused.body, { error: 'backend_unavailable' });
  }
});

test('overview validates both metadata and health, including the exact same owned connection set', async t => {
  const absent = await fixture(t);
  assert.equal((await absent.send('overview', { value: { organizationId: ids.org } })).status, 404);
  const overview = () => ({ connections: [row()], status: {
    connector: { version: '0.2.0', startedAt: NOW, observedAt: NOW },
    connections: [{ id: ids.connection, lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null }],
  } });
  let value = overview(); const calls = [];
  const f = await fixture(t, { management: { ...dependencies().management, async overview(input) { calls.push(input); return value; } } });
  const ok = await f.send('overview', { value: { organizationId: ids.org } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body, overview());
  assert.equal(calls[0].organizationId, ids.org);
  for (const mutate of [v => { v.connections[0].organizationId = ids.other; }, v => { v.status.connections[0].id = ids.other; },
    v => { v.connections[0].token = 'private'; }, v => { v.status.connections.push({ ...v.status.connections[0] }); },
    v => { v.status.connections = []; }, v => { v.status.connector.secret = 'private'; }]) {
    value = overview(); mutate(value);
    const denied = await f.send('overview', { value: { organizationId: ids.org } });
    assert.equal(denied.status, 503); assert.deepEqual(denied.body, { error: 'backend_unavailable' });
  }
  assert.equal((await f.send('overview', { value: { organizationId: ids.org, connectionId: ids.connection } })).status, 400);
});

test('settings HTTP forwards explicit inherited limits and validates the projected ACK without a new token', async t => {
  const input = { organizationId: ids.org, connectionId: ids.connection, expectedEpoch: 2,
    permissionMode: 'inherit_crm', exclusions: { read: ['assistant.context.read'], action: [] }, scopeMode: 'unrestricted', scopeIds: [] };
  const response = () => ({ ok: true, connection: { ...row(), epoch: 3, restrictions: { read: [], action: [] },
    permissionMode: input.permissionMode, exclusions: structuredClone(input.exclusions), scopeMode: input.scopeMode, scopeIds: [ids.other] } });
  let value = response(); const calls = [];
  const f = await fixture(t, { management: { ...dependencies().management, async settings(request) { calls.push(structuredClone(request)); return value; } } });
  const ok = await f.send('settings', { value: input });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body, response());
  assert.equal(calls[0].browserAccessToken, 'browser.jwt.token');
  assert.equal((await f.send('settings', { value: input, headers: { origin: undefined } })).status, 403);
  for (const delta of [{ permissionMode: 'legacy_allowlist' }, { exclusions: { read: [], action: [], token: 'bad' } }, { scopeIds: [ids.other] }, { restrictions: limits() }]) {
    assert.equal((await f.send('settings', { value: { ...input, ...delta } })).status, 400);
  }
  for (const mutate of [v => { v.connection.epoch++; }, v => { v.connection.exclusions.read = []; },
    v => { v.connection.token = 'private'; }, v => { v.connection.restrictions.read = ['assistant.context.read']; }]) {
    value = response(); mutate(value);
    const unknown = await f.send('settings', { value: input });
    assert.equal(unknown.status, 503); assert.equal(unknown.body.error, 'operation_outcome_unknown');
  }
});

test('connect HTTP accepts explicit inheritance with projected permissions and retains legacy connect compatibility', async t => {
  const input = { organizationId: ids.org, email: 'synthetic@example.invalid', password: 'synthetic-password',
    permissionMode: 'inherit_crm', exclusions: { read: [], action: [] }, scopeMode: 'unrestricted', scopeIds: [] };
  const f = await fixture(t, { controlPlane: { async connect(request) {
    assert.equal(request.permissionMode, 'inherit_crm'); assert(!Object.hasOwn(request, 'restrictions'));
    return { ...result('connect'), connection: { ...row(), permissionMode: 'inherit_crm', exclusions: { read: [], action: [] },
      scopeMode: 'unrestricted', scopeIds: [ids.other] } };
  } } });
  assert.equal((await f.send('connect', { value: input })).status, 200);
  for (const delta of [{ permissionMode: 'legacy_allowlist' }, { exclusions: { read: [], action: [], extra: true } },
    { scopeIds: [ids.other] }, { restrictions: limits() }]) {
    assert.equal((await f.send('connect', { value: { ...input, ...delta } })).status, 400);
  }
});

test('HTTP context and choices preserve neutral policy version zero', async t => {
  const deps = dependencies();
  deps.management.options = async () => ({ options: { ...result('options').options, policyVersion: 0 } });
  deps.management.context = async () => ({ context: { ...context(), policyVersion: 0 } });
  const f = await fixture(t, deps);
  for (const operation of ['context', 'options']) {
    const response = await f.send(operation); assert.equal(response.status, 200); assert.equal(response.body[operation].policyVersion, 0);
  }
});

test('exact Host and Origin gates apply to reads too, while writes require Origin and ignore forwarded headers', async t => {
  const f = await fixture(t);
  for (const operation of ['connect', 'list', 'context', 'options', 'restrict', 'revoke']) {
    for (const headers of [{ host: 'broker.example' }, { host: 'broker.example:443' }, { host: 'evil.example', 'x-forwarded-host': HOST },
      { origin: 'https://evil.example' }, { origin: 'null' }, { origin: `${ORIGIN}/` }]) {
      assert.equal((await f.send(operation, { headers })).status, 403);
    }
  }
  for (const operation of ['connect', 'restrict', 'revoke']) assert.equal((await f.send(operation, { headers: { origin: undefined } })).status, 403);
  assert.equal(f.calls.length, 0);
  for (const operation of ['list', 'context']) assert.equal((await f.send(operation, { headers: { origin: undefined } })).status, 200);
});

test('configuration is bounded, exact and snapshotted; route matching has no query, normalization or method aliases', async t => {
  const deps = dependencies();
  for (const options of [{ allowedHosts: [] }, { allowedHosts: ['broker.example/path'] }, { allowedHosts: ['user@broker.example'] },
    { allowedHosts: ['BROKER.example'] }, { allowedOrigins: ['null'] }, { allowedOrigins: [`${ORIGIN}/`] },
    { allowedOrigins: [ORIGIN, ORIGIN] }, { timeoutMs: 30001 }, { maxConcurrentRequests: 65 }]) {
    assert.throws(() => createConnectionHttpHandler({ ...deps, allowedHosts: [HOST], ...options }), /invalid_connection_http_config/);
  }
  const hosts = [HOST], origins = [ORIGIN], f = await fixture(t, { allowedHosts: hosts, allowedOrigins: origins });
  hosts.push('evil.example'); origins.push('https://evil.example');
  assert.equal((await f.send('list', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await f.send('list', { headers: { origin: 'https://evil.example' } })).status, 403);
  for (const path of ['/mcp', `${PREFIX}list?organizationId=x`, `${PREFIX}list/`, `${PREFIX}LIST`, `${PREFIX}%6cist`, `${PREFIX}rpc`]) {
    assert.equal((await f.send('list', { path })).status, 404);
  }
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const response = await f.send('list', { method }); assert.equal(response.status, 405); assert.equal(response.headers.allow, 'POST');
  }
  assert.equal(f.calls.length, 0);
});

test('duplicate raw headers fail before Node normalized values can select an identity or origin', async t => {
  const f = await fixture(t);
  for (const duplicate of [['Authorization', 'Bearer other.jwt.token'], ['Host', 'evil.example'], ['Origin', 'https://evil.example'], ['Content-Type', 'text/plain']]) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(f.address + PREFIX + 'list', { method: 'POST', headers: [
        'Host', HOST, 'Origin', ORIGIN, 'Authorization', 'Bearer browser.jwt.token', 'Content-Type', 'application/json', ...duplicate,
      ] }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({
        status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: response.headers })); });
      request.on('error', reject); request.end(JSON.stringify(body('list')));
    });
    assert.equal(response.status, 400); assert.equal(response.body.error, 'duplicate_header'); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls.length, 0);
});

test('body limits enforce bytes for declared and chunked bodies, reject invalid UTF-8/JSON and encoded payloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('list', { headers: { 'content-length': '65537' }, raw: 'x' })).status, 413);
  assert.equal((await f.send('list', { chunks: [' '.repeat(32768), ' '.repeat(32769)] })).status, 413);
  assert.equal((await f.send('list', { chunks: [' '.repeat(65536)] })).status, 400);
  assert.equal((await f.send('list', { raw: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]) })).body.error, 'invalid_json');
  for (const raw of ['{', 'null', '[]', 'true']) assert.equal((await f.send('list', { raw })).status, 400);
  for (const value of ['gzip', 'br', 'identity']) assert.equal((await f.send('list', { headers: { 'content-encoding': value } })).status, 415);
  for (const value of ['text/plain', 'application/json; charset=latin1', 'application/json; x=y']) {
    assert.equal((await f.send('list', { headers: { 'content-type': value } })).status, 415);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send('list', { headers: { 'content-type': 'application/json; charset=UTF-8' } })).status, 200);
});

test('only a syntactic browser bearer and route-specific body can reach a primitive; no token/actor/RPC injection', async t => {
  const f = await fixture(t);
  for (const authorization of [undefined, 'Basic browser.jwt.token', `Bearer hc_${'a'.repeat(43)}`, 'Bearer a.b', 'Bearer a.b.c,d.e.f', 'Bearer  a.b.c']) {
    assert.equal((await f.send('list', { headers: { authorization } })).status, 401);
  }
  for (const operation of ['connect', 'list', 'context', 'options', 'restrict', 'revoke']) {
    for (const extra of [{ browserAccessToken: 'other.jwt.token' }, { accessToken: 'secret' }, { userId: ids.other },
      { organizationId: 'invalid' }, { rpc: 'execute_sql' }, { url: 'https://evil.example' }, { session: { refreshToken: 'secret' } }]) {
      assert.equal((await f.send(operation, { value: { ...body(operation), ...extra } })).status, 400);
    }
    const missing = body(operation); delete missing.organizationId;
    assert.equal((await f.send(operation, { value: missing })).status, 400);
  }
  for (const value of [{ ...body('connect'), password: 'x'.repeat(4097) }, { ...body('connect'), restrictions: { read: ['future.unsupported_read'], action: [] } },
    { ...body('restrict'), scopeIds: [ids.other, ids.other] }, { ...body('revoke'), expectedEpoch: 0 }]) {
    const operation = 'password' in value ? 'connect' : 'scopeIds' in value ? 'restrict' : 'revoke';
    assert.equal((await f.send(operation, { value })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('known primitive outcomes keep safe codes and validated receipts without raw messages, causes or secret receipt fields', async t => {
  const expected = { reauthentication_required: 401, additional_authentication_required: 403, forbidden: 403,
    context_changed: 409, invalid_request: 400, prepare_rejected: 409, prepare_outcome_unknown: 503,
    sign_in_outcome_unknown: 503, activation_rejected: 409, activation_outcome_unknown: 503, cancelled: 408, backend_unavailable: 503 };
  for (const [code, status] of Object.entries(expected)) {
    const error = new ConnectionControlError(code, { connectionId: ids.connection, operationId: ids.other });
    error.message = 'PRIVATE password accessToken refreshToken'; error.cause = new Error('PRIVATE');
    const f = await fixture(t, { controlPlane: { async connect() { throw error; } } });
    const response = await f.send('connect'); assert.equal(response.status, status); assert.equal(response.body.error, code);
    assert.deepEqual(response.body.receipt, { connectionId: ids.connection, operationId: ids.other }); assert(!response.text.includes('PRIVATE'));
  }
  const f = await fixture(t, { management: { ...dependencies().management, async revoke() {
    throw new ConnectionManagementError('operation_outcome_unknown', { connectionId: ids.connection, expectedEpoch: 2,
      operation: 'revoke', refreshToken: 'PRIVATE' });
  } } });
  const response = await f.send('revoke'); assert.deepEqual(response.body, { error: 'operation_outcome_unknown' }); assert(!response.text.includes('PRIVATE'));
});

test('generic failures and malformed write ACKs stay unknown; output allowlists reject nested secrets and wrong ownership', async t => {
  for (const operation of ['connect', 'list', 'context', 'options', 'restrict', 'revoke']) {
    for (const mutation of [() => { throw new Error('PRIVATE provider JWT password'); }, () => ({ ...result(operation), accessToken: 'PRIVATE' }),
      () => operation === 'list' ? { connections: [{ ...row(), refreshToken: 'PRIVATE' }] }
        : operation === 'context' ? { context: { ...context(), organizationId: ids.other } }
          : operation === 'revoke' ? { ...result(operation), connectionId: ids.other }
            : { ...result(operation), connection: { ...result(operation).connection, organizationId: ids.other } }]) {
      const deps = dependencies(); if (operation === 'connect') deps.controlPlane.connect = mutation; else deps.management[operation] = mutation;
      const f = await fixture(t, deps), response = await f.send(operation);
      assert.equal(response.status, 503); assert.deepEqual(response.body, { error: ['connect', 'restrict', 'revoke'].includes(operation)
        ? 'operation_outcome_unknown' : 'backend_unavailable' }); assert(!response.text.includes('PRIVATE'));
    }
  }
});

test('dependency input mutation cannot move the response identity fence and immutable input cleanup is safe', async t => {
  const f = await fixture(t, { controlPlane: { async connect(input) {
    input.organizationId = ids.other; input.scopeIds.push(ids.other); Object.freeze(input);
    return { ...result('connect'), connection: { ...row(), organizationId: ids.other, scopeIds: [ids.other] } };
  } } });
  const response = await f.send('connect');
  assert.equal(response.status, 503); assert.deepEqual(response.body, { error: 'operation_outcome_unknown' });
  assert.equal((await f.send('list')).status, 200);
});

test('timeout aborts pending write, preserves uncertainty, retains capacity until late settlement and never retries', async t => {
  const pending = deferred(), entered = deferred(); let calls = 0, signal;
  const f = await fixture(t, { timeoutMs: 35, maxConcurrentRequests: 1, management: { ...dependencies().management,
    async revoke(_input, options) { calls += 1; signal = options.signal; entered.resolve(); return pending.promise; } } });
  const responsePromise = f.send('revoke'); await entered.promise;
  const response = await responsePromise;
  assert.equal(response.status, 503); assert.deepEqual(response.body, { error: 'operation_outcome_unknown' }); assert(signal.aborted);
  assert.equal((await f.send('list')).status, 429); assert.equal(calls, 1);
  pending.resolve(result('revoke')); await tick();
  assert.equal((await f.send('list')).status, 200); assert.equal(calls, 1);
});

test('read timeout and body timeout make no claim of write uncertainty or successful cancellation of a mutation', async t => {
  const pending = deferred(); let signal;
  const f = await fixture(t, { timeoutMs: 30, management: { ...dependencies().management,
    async list(_input, options) { signal = options.signal; return pending.promise; } } });
  const response = await f.send('list'); assert.equal(response.status, 504); assert.equal(response.body.error, 'timeout'); assert(signal.aborted);
  pending.resolve(result('list')); await tick();
  const g = await fixture(t, { timeoutMs: 30 });
  const partial = await new Promise((resolve, reject) => {
    const request = httpRequest(g.address + PREFIX + 'connect', { method: 'POST', headers: {
      host: HOST, origin: ORIGIN, authorization: 'Bearer browser.jwt.token', 'content-type': 'application/json', 'content-length': '1000',
    } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({
      status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
    request.on('error', reject); request.write('{');
  });
  assert.equal(partial.status, 504); assert.equal(partial.body.error, 'timeout'); assert.equal(g.calls.length, 0);
});

test('client disconnect aborts the dependency signal and holds its slot until settled', async t => {
  const pending = deferred(), entered = deferred(), aborted = deferred(); let calls = 0;
  const f = await fixture(t, { maxConcurrentRequests: 1, controlPlane: { async connect(_input, { signal }) {
    calls += 1; signal.addEventListener('abort', () => aborted.resolve(), { once: true }); entered.resolve(); return pending.promise;
  } } });
  const request = httpRequest(f.address + PREFIX + 'connect', { method: 'POST', headers: {
    host: HOST, origin: ORIGIN, authorization: 'Bearer browser.jwt.token', 'content-type': 'application/json',
  } });
  request.on('error', () => {}); request.end(JSON.stringify(body('connect'))); await entered.promise;
  request.destroy(); await aborted.promise;
  assert.equal((await f.send('list')).status, 429); assert.equal(calls, 1);
  pending.resolve(result('connect')); await tick(); assert.equal((await f.send('list')).status, 200);
});

test('real existing control and management primitives compose over HTTP with verified browser identity and separate assistant session', async t => {
  const authCalls = [], writes = [], scopes = { read: ['assistant.context.read'], action: [] };
  const auth = {
    async verifySession({ accessToken }) { authCalls.push(accessToken); if (!['browser.jwt.token', 'assistant.jwt.token'].includes(accessToken)) throw new Error('PRIVATE');
      return { userId: ids.user, sessionId: accessToken === 'browser.jwt.token' ? ids.session : ids.other, expiresAt: NOW + 3_600_000 }; },
    async readAuthorization() { return { userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org], epoch: 'auth-v1',
      membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
        membershipId: ids.membership, authorizationVersion: 1 }, permissions: scopes, companyCeilings: scopes }; },
  };
  const connectionStore = {
    async activate(input) { writes.push(input); return { ok: true, status: 'activated', credentialRef: input.credentialRef, connection: row() }; },
    async restrictConnection(input) { writes.push(input); return result('restrict'); },
    async revokeConnection(input) { writes.push(input); return { ok: true, status: 'revoked' }; },
  };
  const controlPlane = createConnectionControlPlane({ auth, clock: () => NOW, connectionStore,
    signInProvider: { async signIn(input) { assert.equal(input.password, 'synthetic-password'); return { accessToken: 'assistant.jwt.token', refreshToken: 'PRIVATE-refresh' }; } },
    preparation: { async prepareConnection() { return { ...row(), state: 'pending', epoch: 1,
      intentSecret: 'a'.repeat(64), intentExpiresAt: NOW + 300_000 }; } },
    crypto: { seal(pair, binding) { assert.equal(pair.refreshToken, 'PRIVATE-refresh'); assert.equal(binding.sessionId, ids.other); return { sealed: true }; } },
  });
  const management = createConnectionManagement({ auth, connectionStore, clock: () => NOW,
    reads: { async listConnections() { return [row()]; }, async connectionContext() { return context(); } } });
  const f = await fixture(t, { controlPlane, management });
  const connected = await f.send('connect'); assert.equal(connected.status, 200); assert.match(connected.body.token, /^hc_[A-Za-z0-9_-]{43}$/);
  assert(!connected.text.includes('PRIVATE')); assert(!connected.text.includes('assistant.jwt.token')); assert.equal(writes.length, 1);
  for (const operation of ['list', 'context', 'restrict', 'revoke']) assert.equal((await f.send(operation)).status, 200);
  assert.equal(writes.length, 3); assert(authCalls.includes('assistant.jwt.token')); assert(authCalls.includes('browser.jwt.token'));
  const bad = await f.send('list', { headers: { authorization: 'Bearer forged.jwt.token' } });
  assert.equal(bad.status, 503); assert(!bad.text.includes('PRIVATE')); assert.equal(writes.length, 3);
});

test('options HTTP projects only the selected-company choices and rejects forged identity inputs or response secrets',async t=>{
 const f=await fixture(t);
 assert.equal((await f.send('options')).status,200);
 for(const extra of [{userId:ids.other},{rpc:'admin_catalog'},{connectionId:ids.connection}])
   assert.equal((await f.send('options',{value:{...body('options'),...extra}})).status,400);
 f.management.options=async()=>({options:{...result('options').options,organizationId:ids.other}});
 assert.equal((await f.send('options')).status,503);
 f.management.options=async()=>({options:{...result('options').options,token:'secret'}});
 const response=await f.send('options');assert.equal(response.status,503);assert(!response.text.includes('secret'));
});
test('HTTP connect forwards implemented read capabilities and rejects unsupported actions',async t=>{
 const f=await fixture(t),input={...body('connect'),restrictions:{read:['assistant.context.read','rooms.view'],action:[]},scopeIds:[ids.other]};
 f.controlPlane.connect=async value=>{f.calls.push(value);return {...result('connect'),connection:{...row(),restrictions:value.restrictions,scopeIds:value.scopeIds}};};
 assert.equal((await f.send('connect',{value:input})).status,200);
 assert.deepEqual(f.calls.at(-1).restrictions,input.restrictions);
 assert.equal((await f.send('connect',{value:{...input,restrictions:{...input.restrictions,action:['rooms.delete']}}})).status,400);
});

test('HTTP forwards exactly the fixed requested action and rejects unknown/duplicate additions',async t=>{
 const f=await fixture(t),input={...body('connect'),restrictions:{read:['assistant.context.read'],action:['chat_zalo.send']}};
 f.controlPlane.connect=async value=>{f.calls.push(value);return {...result('connect'),connection:{...row(),restrictions:value.restrictions,scopeIds:value.scopeIds}}};
 assert.equal((await f.send('connect',{value:input})).status,200);assert.deepEqual(f.calls.at(-1).restrictions.action,['chat_zalo.send']);
 for(const action of [['rooms.delete'],['chat_zalo.send','chat_zalo.send'],['chat_zalo.send','future.write']])assert.equal((await f.send('connect',{value:{...input,restrictions:{...input.restrictions,action}}})).status,400);
 f.controlPlane.connect=async()=>result('connect');assert.equal((await f.send('connect',{value:input})).status,503);
});

test('HTTP accepts group read without an implicit room/send requirement',async t=>{
 const f=await fixture(t),input={...body('connect'),restrictions:{read:['chat_zalo.view'],action:[]},scopeIds:[]};
 f.controlPlane.connect=async value=>{f.calls.push(value);return {...result('connect'),connection:{...row(),restrictions:value.restrictions,scopeIds:value.scopeIds}}};
 assert.equal((await f.send('connect',{value:input})).status,200);assert.deepEqual(f.calls.at(-1).restrictions,input.restrictions);
});
