import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { beginOAuth, completeOAuth, hashState } from '../src/oauth.mjs';

const config = {
  googleClientId: 'synthetic-client.apps.googleusercontent.com',
  googleRedirectUri: 'https://worker.example.test/oauth/callback',
  googlePubsubTopic: 'projects/synthetic/topics/gmail',
};
const key = randomBytes(32);

test('OAuth start creates DB-bound one-use state and offline readonly PKCE URL', async () => {
  const calls = [];
  const result = await beginOAuth({ connectionId: '11111111-1111-4111-8111-111111111111', userJwt: 'user-jwt',
    config, key, rpc: async (...args) => { calls.push(args); return { id: 'one', status: 'AUTHORIZING' }; } });
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(calls[0][0], 'bank_email_oauth_begin_v1');
  assert.equal(calls[0][2], 'user-jwt');
  assert.equal(calls[0][1].p_state_hash, hashState(url.searchParams.get('state')));
  assert.ok(calls[0][1].p_verifier_encrypted.startsWith('v1.'));
});

test('callback consumes state once, exchanges verifier, watches mailbox, then stores encrypted refresh token', async () => {
  let startPayload;
  const start = await beginOAuth({ connectionId: '11111111-1111-4111-8111-111111111111', userJwt: 'user-jwt', config, key,
    rpc: async (_, payload) => { startPayload = payload; return { id: 'one', status: 'AUTHORIZING' }; } });
  const state = new URL(start.url).searchParams.get('state');
  const operations = [];
  const result = await completeOAuth({ state, code: 'synthetic-code', config, key,
    rpc: async (operation, payload) => {
      operations.push([operation, payload]);
      if (operation === 'oauth_consume') return { connectionId: '11111111-1111-4111-8111-111111111111', encryptedVerifier: startPayload.p_verifier_encrypted };
      return { id: 'one', status: 'CONNECTED' };
    },
    google: {
      exchangeCode: async (_, verifier) => { assert.ok(verifier.length >= 64); return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }; },
      profile: async () => ({ emailAddress: 'OWNER@example.test' }),
      watch: async () => ({ historyId: '123456', expiration: String(Date.now() + 3_600_000) }),
    },
  });
  assert.equal(result.status, 'CONNECTED');
  assert.deepEqual(operations.map(([name]) => name), ['oauth_consume', 'oauth_complete']);
  assert.equal(operations[1][1].email, 'owner@example.test');
  assert.doesNotMatch(operations[1][1].encryptedRefreshToken, /synthetic-refresh/u);
});

test('callback with missing refresh token never completes connection', async () => {
  let startPayload;
  const start = await beginOAuth({ connectionId: '11111111-1111-4111-8111-111111111111', userJwt: 'user-jwt', config, key,
    rpc: async (_, payload) => { startPayload = payload; return {}; } });
  const operations = [];
  await assert.rejects(completeOAuth({ state: new URL(start.url).searchParams.get('state'), code: 'code', config, key,
    rpc: async (operation) => { operations.push(operation); return { connectionId: '11111111-1111-4111-8111-111111111111', encryptedVerifier: startPayload.p_verifier_encrypted }; },
    google: { exchangeCode: async () => ({ access_token: 'access' }) },
  }), /REFRESH_TOKEN_REQUIRED/u);
  assert.deepEqual(operations, ['oauth_consume']);
});
