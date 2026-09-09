import test from 'node:test';
import assert from 'node:assert/strict';
import { createG1Guard } from '../lib/copilot-g1-guard.mjs';
const actorId = '10000000-0000-4000-8000-000000000001', org = 'dddd0000-0000-4000-8000-000000000001';
const origin = 'https://project.supabase.co', baseUrl = 'https://reviewed-preview.vercel.app';
const req = (path, body = {}, method = 'POST') => ({ url: origin + path, method, body, headers: { 'x-organization-id': org } });
test('allows only reviewed POST read signatures and scoped DEMO identity, never an unknown or financial writer', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  assert.equal(guard.allow(req('/rest/v1/rpc/get_dashboard_summary', { p_building_id: null })), true);
  assert.equal(guard.allow(req('/rest/v1/rpc/copilot_memory_list_v1', { p_organization_id: org })), true);
  for (const request of [req('/rest/v1/rpc/get_dashboard_summary', { dangerous_new_arg: true }),
    req('/rest/v1/rpc/copilot_memory_list_v1', { p_organization_id: actorId }), req('/rest/v1/rpc/get_unknown_safe_read'),
    req('/rest/v1/rpc/copilot_execute_room_pass_active_v1'), req('/rest/v1/notifications', { user_id: actorId }),
    req('/rest/v1/rpc/approve_invoice_v1', {}, 'GET'), req('/rest/v1/profiles', {}, 'PATCH'),
    req('/functions/v1/unknown-function'), { ...req('/rest/v1/notifications'), url: 'https://other.example/rest/v1/notifications' }])
    assert.equal(guard.allow(request), false, request.url);
});
test('only a successfully observed fresh owned chat thread permits chat message persistence', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const threadId = '20000000-0000-4000-8000-000000000001';
  const creation = req('/rest/v1/ai_chat_threads', { user_id: actorId, organization_id: org, title: 'G1' });
  const message = req('/rest/v1/ai_chat_messages', [{ user_id: actorId, organization_id: org, thread_id: threadId, role: 'user', content: 'G1' }]);
  assert.equal(guard.allow(message), false);
  assert.equal(guard.allow(creation), true);
  guard.observeThread(creation, { id: threadId }, 201);
  assert.equal(guard.allow(message), true);
  assert.equal(guard.allow({ ...message, body: [{ ...message.body[0], organization_id: actorId }] }), false);
  assert.equal(guard.allow({ ...creation, body: { ...creation.body, user_id: org } }), false);
});
