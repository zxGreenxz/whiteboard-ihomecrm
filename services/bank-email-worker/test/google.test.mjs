import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleClient } from '../src/google.mjs';

test('Gmail client uses fixed Google endpoints and requests raw messages without rendering content', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([String(url), init]);
    return new Response(JSON.stringify({ raw: 'dGVzdA', internalDate: '1791090000000' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const google = createGoogleClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://worker.example.test/oauth/callback' }, fetchImpl);
  await google.getMessage('access', 'abc123');
  assert.equal(requests[0][0], 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=raw');
  assert.equal(requests[0][1].headers.Authorization, 'Bearer access');
});

test('refresh failure carries only machine code for reconnect handling', async () => {
  const google = createGoogleClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://worker.example.test/oauth/callback' },
    async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private provider detail' }), { status: 400 }));
  await assert.rejects(google.refreshToken('synthetic-refresh'), error => {
    assert.equal(error.code, 'invalid_grant');
    assert.doesNotMatch(error.message, /private provider detail/u);
    return true;
  });
});

test('watch covers the mailbox even when filters archive bank notices', async () => {
  let body;
  const google = createGoogleClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://worker.example.test/oauth/callback' },
    async (_url, init) => { body = JSON.parse(init.body); return new Response('{"historyId":"1","expiration":"9999999999999"}', { status: 200 }); });
  await google.watch('access', 'projects/synthetic/topics/gmail');
  assert.deepEqual(body, { topicName: 'projects/synthetic/topics/gmail' });
});

test('metadata request reads From and size before downloading raw MIME', async () => {
  const requests = [];
  const google = createGoogleClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://worker.example.test/oauth/callback' },
    async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ id: 'abc123', internalDate: '1791090000000',
      sizeEstimate: 1000, payload: { headers: [{ name: 'From', value: 'ACB <mailalert@acb.com.vn>' }] } }), { status: 200 }); });
  const metadata = await google.getMessageMetadata('access', 'abc123');
  assert.equal(metadata.sizeEstimate, 1000);
  assert.equal(requests[0], 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=metadata&metadataHeaders=From');
});
