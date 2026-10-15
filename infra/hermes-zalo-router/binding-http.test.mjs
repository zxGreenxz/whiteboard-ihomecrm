import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createZaloBindingHttpHandler } from './binding-http.mjs';
import { ZaloBindingError } from './binding-service.mjs';

const ORG = '11111111-1111-4111-8111-111111111111';
async function fixture(t, service, options = {}) {
  const handler = createZaloBindingHttpHandler({ service, allowedHosts: ['broker.test:8443'], allowedOrigins: ['https://crm.test'], ...options });
  const server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end('{}'); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const send = (operation, body = '{}', headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const defaults = { host: 'broker.test:8443', origin: 'https://crm.test', authorization: 'Bearer browser.fixture.jwt', 'content-type': 'application/json', ...headers };
    for (const key of Object.keys(defaults)) if (defaults[key] === undefined) delete defaults[key];
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/api/hermes/zalo/' + operation, method, headers: defaults }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  return send;
}
test('transport enforces host/origin/body/JWT before service dispatch', async t => {
  let calls = 0; const send = await fixture(t, { invoke: async () => { calls++; return {}; } });
  for (const [operation, body, headers, method, expected] of [
    ['begin','{}',{host:'evil.test'},'POST',403], ['begin','{}',{origin:undefined},'POST',403],
    ['setBot','{}',{origin:undefined},'POST',403], ['setBot','{}',{authorization:'Bearer hc_'+'x'.repeat(43)},'POST',401],
    ['list','{}',{origin:'https://evil.test'},'POST',403], ['list','{}',{},'GET',405],
    ['list','{}',{'content-type':'text/plain'},'POST',415], ['list','{}',{'content-encoding':'gzip'},'POST',415],
    ['list','{}',{authorization:'Bearer hc_'+'x'.repeat(43)},'POST',401],
    ['list','{',{},'POST',400], ['list','x'.repeat(4097),{},'POST',413], ['list','[]',{},'POST',400],
    ['list?leak=1','{}',{},'POST',404],
  ]) assert.equal((await send(operation, body, headers, method)).status, expected);
  assert.equal(calls, 0);
});

test('admin route preserves caller scope and known SQL denial without exposing a service-role route', async t => {
  const calls = [];
  const send = await fixture(t, { invoke: async (op, input, options) => {
    calls.push({ op, input, options });
    if (op === 'setBot') throw new ZaloBindingError('forbidden');
    return { status: 'listed', bots: [], nextCursor: null };
  } });
  assert.equal((await send('manageBots', JSON.stringify({ organizationId: ORG, afterAccountId: null }))).status, 200);
  const denied = await send('setBot', JSON.stringify({ organizationId: ORG, accountId: ORG, expectedVersion: 0, enabled: true }));
  assert.equal(denied.status, 403); assert.deepEqual(denied.body, { error: 'forbidden' });
  assert.equal(calls[1].options.organizationId, ORG); assert.equal(calls[1].options.accessToken, 'browser.fixture.jwt');
  assert.deepEqual(calls[1].input, { accountId: ORG, expectedVersion: 0, enabled: true });
  assert.equal((await send('register', '{}')).status, 404);
});
test('typed errors remain distinct while raw backend diagnostics never reach the browser', async t => {
  let error = new ZaloBindingError('context_changed'); const send = await fixture(t, { invoke: async () => { throw error; } });
  const body = JSON.stringify({ organizationId: ORG, afterBindingId: null });
  assert.deepEqual((await send('list', body)).body, { error: 'context_changed' });
  error = new Error('PRIVATE-JWT');
  assert.deepEqual((await send('begin', body)).body, { error: 'binding_outcome_unknown' });
  assert.deepEqual((await send('list', body)).body, { error: 'backend_unavailable' });
});
test('write timeout retains admission until ignored-abort dependency settles', async t => {
  let settle, signal, calls = 0;
  const send = await fixture(t, { invoke: (_op, _input, options) => { calls++; signal = options.signal; return new Promise(resolve => { settle = resolve; }); } }, { timeoutMs: 25, maxConcurrent: 1 });
  const body = JSON.stringify({ organizationId: ORG });
  const response = await send('begin', body);
  assert.equal(response.status, 503); assert.deepEqual(response.body, { error: 'binding_outcome_unknown' }); assert(signal.aborted);
  assert.equal((await send('list', body)).status, 429); assert.equal(calls, 1);
  settle({}); await new Promise(resolve => setImmediate(resolve));
});
