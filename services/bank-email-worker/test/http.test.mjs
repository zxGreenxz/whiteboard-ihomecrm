import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createHttpServer, verifyPubsubToken } from '../src/http.mjs';

const config = { appOrigin: 'https://app.example.test', googleClientId: 'synthetic-client',
  googleRedirectUri: 'https://worker.example.test/oauth/callback', googlePubsubTopic: 'projects/synthetic/topics/gmail',
  pubsubAudience: 'https://worker.example.test/pubsub', pubsubServiceAccountEmail: 'push@synthetic.iam.gserviceaccount.com' };

async function withServer(options, run) {
  const server = createHttpServer({ config, key: randomBytes(32), google: {}, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('authenticated push ACKs only after a durable enqueue', async () => {
  const events = [];
  await withServer({ verifyPush: async token => { assert.equal(token, 'signed-jwt'); return { email: config.pubsubServiceAccountEmail, email_verified: true }; },
    rpc: async (op, payload) => { events.push([op, payload]); return { queued: 1 }; } }, async base => {
    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'OWNER@example.test', historyId: '123' })).toString('base64') } };
    const response = await fetch(`${base}/pubsub`, { method: 'POST', headers: { authorization: 'Bearer signed-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 204);
  });
  assert.deepEqual(events, [['enqueue', { email: 'owner@example.test' }]]);
});

test('push rejects forged identity and returns retryable status when enqueue fails', async () => {
  await withServer({ verifyPush: async () => ({ email: 'other@synthetic.iam.gserviceaccount.com', email_verified: true }), rpc: async () => ({}) }, async base => {
    const response = await fetch(`${base}/pubsub`, { method: 'POST', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
  });
  await withServer({ verifyPush: async () => ({ email: config.pubsubServiceAccountEmail, email_verified: true }),
    rpc: async () => { throw new Error('database down'); } }, async base => {
    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'owner@example.test', historyId: '123' })).toString('base64') } };
    const response = await fetch(`${base}/pubsub`, { method: 'POST', headers: { authorization: 'Bearer signed-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
  });
});

test('OAuth start binds user JWT through DB and enforces exact CORS origin', async () => {
  let userJwt;
  await withServer({ rpc: async (op, _payload, jwt) => { userJwt = jwt; return { id: 'one', status: 'AUTHORIZING' }; } }, async base => {
    const input = { connectionId: '11111111-1111-4111-8111-111111111111' };
    const response = await fetch(`${base}/oauth/start`, { method: 'POST', headers: { origin: config.appOrigin, authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal(new URL((await response.json()).url).origin, 'https://accounts.google.com');
    assert.equal(response.headers.get('access-control-allow-origin'), config.appOrigin);
    const denied = await fetch(`${base}/oauth/start`, { method: 'POST', headers: { origin: 'https://evil.example.test', authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(denied.status, 403);
  });
  assert.equal(userJwt, 'user-jwt');
});

test('expired user JWT is reported as authentication failure', async () => {
  await withServer({ rpc: async () => { const error = new Error('RPC_FAILED'); error.status = 401; throw error; } }, async base => {
    const response = await fetch(`${base}/oauth/start`, { method: 'POST', headers: { origin: config.appOrigin,
      authorization: 'Bearer expired-user-jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: '11111111-1111-4111-8111-111111111111' }) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'AUTH_REQUIRED' });
  });
});

test('production Pub/Sub verifier rejects oversized tokens without network access', async () => {
  await assert.rejects(verifyPubsubToken('x'.repeat(8193), config));
});
