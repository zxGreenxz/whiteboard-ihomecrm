import assert from 'node:assert/strict';
import test from 'node:test';
import { createRpcClient } from '../src/db.mjs';

test('user OAuth RPC carries user bearer and anon apikey, worker RPC uses service role', async () => {
  const requests = [];
  const rpc = createRpcClient({ supabaseUrl: 'https://example.supabase.co', anonKey: 'anon', serviceKey: 'service' },
    async (url, init) => { requests.push([url, init]); return new Response('{}', { status: 200 }); });
  await rpc('bank_email_oauth_begin_v1', { p_connection_id: 'id' }, 'user-token');
  await rpc('enqueue', { email: 'owner@example.test' });
  assert.equal(requests[0][1].headers.apikey, 'anon');
  assert.equal(requests[0][1].headers.Authorization, 'Bearer user-token');
  assert.equal(requests[1][1].headers.apikey, 'service');
  assert.equal(requests[1][1].headers.Authorization, 'Bearer service');
  assert.deepEqual(JSON.parse(requests[1][1].body), { p_operation: 'enqueue', p_payload: { email: 'owner@example.test' } });
});

test('RPC failures preserve SQLSTATE while discarding database detail', async () => {
  const rpc = createRpcClient({ supabaseUrl: 'https://example.supabase.co', anonKey: 'anon', serviceKey: 'service' },
    async () => new Response(JSON.stringify({ code: '42501', message: 'private table detail' }), { status: 403 }));
  await assert.rejects(rpc('claim', {}), error => {
    assert.equal(error.code, '42501');
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /private table detail/u);
    return true;
  });
});
