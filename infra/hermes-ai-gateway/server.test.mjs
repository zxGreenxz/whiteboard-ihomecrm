import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gateway } from './server.mjs';

test('authenticated routing preserves SSE and isolates the owner connector', async t => {
  const key = 'gateway-'.repeat(6), ownerKey = 'owner-'.repeat(8), seen = [];
  const stub = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization, extra: req.headers['x-crm-ai-key'] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ok\n\n');
  });
  const server = gateway({ key, ownerKey, ownerSocket: 'fixture' }, (url, options) => {
    assert.equal(url.host, options.socketPath ? 'localhost' : 'openrouter.ai');
    return http.request('http://127.0.0.1:' + stub.address().port + url.pathname, { ...options, socketPath: undefined });
  });
  t.after(() => { server.closeAllConnections(); server.close(); stub.close(); });
  for (const app of [stub, server]) { app.listen(0, '127.0.0.1'); await once(app, 'listening'); }
  const base = 'http://127.0.0.1:' + server.address().port + '/ai-gateway/';
  const call = (path, bearer, body) => fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-CRM-AI-Key': key, Authorization: 'Bearer ' + bearer, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await fetch(base + 'openrouter/models')).status, 401);
  assert.equal((await call('nous-owner/models', 'provider')).status, 403);
  assert.equal((await call('openrouter/models', ownerKey)).status, 403);
  assert.equal((await call('nous-owner/chat/completions', ownerKey, { model: 'another', messages: [] })).status, 400);
  assert.deepEqual(seen, []);
  assert.equal((await call('openrouter/audio/transcriptions', 'provider', { audio: 'fixture' })).status, 404);
  const chat = await call('openrouter/chat/completions', 'provider', { messages: [] });
  assert.equal(await chat.text(), 'data: ok\n\n');
  assert.equal(chat.headers.get('content-type'), 'text/event-stream');
  assert.equal((await call('nous-owner/chat/completions', ownerKey, { model: 'openai/gpt-6-luna', messages: [], stream: false, max_tokens: 100 })).status, 200);
  assert.deepEqual(seen, [{ path:'/api/v1/chat/completions', auth:'Bearer provider', extra:undefined },
    { path:'/v1/chat/completions', auth:'Bearer crm', extra:undefined }]);
});
