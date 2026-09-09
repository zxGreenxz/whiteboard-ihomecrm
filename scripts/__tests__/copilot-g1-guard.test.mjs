import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createG1Guard, initializeG1Browser } from '../lib/copilot-g1-guard.mjs';
const actorId = '10000000-0000-4000-8000-000000000001', org = 'dddd0000-0000-4000-8000-000000000001';
const origin = 'https://project.supabase.co', baseUrl = 'https://reviewed-preview.vercel.app';
const req = (path, body = {}, method = 'POST') => ({ url: origin + path, method, body, headers: { 'x-organization-id': org } });

test('mounted route reads use only inspected signatures; overloads and write-like neighbors stay denied', () => {
  const guard = createG1Guard({ actorId, organizationId: org, supabaseOrigin: origin, baseUrl });
  const reads = {
    get_my_context: {}, get_my_assignments: {}, is_admin: {}, my_org_ids: {},
    get_customer_stats: { p_status: 'ACTIVE', p_search: 'g1', p_building_id: actorId, p_room_id: actorId },
    get_reservation_deposit_summary: { p_building_ids: [actorId] },
    get_held_deposit_summary: { p_building_ids: [actorId], p_threshold: 10000 },
    get_refund_forfeit_summary: { p_building_ids: [actorId] },
    get_meter_reading_stats: { p_building_id: null, p_month: '2026-09' },
    get_meters_without_readings_v2: { p_building_id: actorId, p_room_id: actorId, p_meter_type: 'WATER', p_month: '2026-09' },
    ie_form_buildings: {}, get_acceptance_geofence_config: {},
    list_my_cashbook_access_v2: {}, list_cashbook_visibility_v2: {}, get_finance_v2_client_flags_v1: {},
    zalo_get_crm_summary: { p_conversation_id: actorId },
    get_income_expense_layer_stats: { p_posting: 'UNPOSTED' },
  };
  for (const [name, args] of Object.entries(reads)) {
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, args)), true, name);
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, { ...args, p_write: true })), false, name);
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`, args, 'GET')), false, name);
  }
  for (const name of ['mark_overdue_invoices_v1', 'bulk_create_meter_readings', 'approve_meter_reading_v1',
    'create_reservation_deposit_v1', 'set_cashbook_access_v2', 'zalo_sticker_search', 'zalo_mark_read', 'zalo_send_seen', 'zalo_send_typing'])
    assert.equal(guard.allow(req(`/rest/v1/rpc/${name}`)), false, name);
});

test('browser bootstrap reuses existing local throttles without executing server or business actions', () => {
  const local = new Map(), session = new Map(), now = 1788969600000;
  vm.runInNewContext(`(${initializeG1Browser.toString()})(input)`, {
    input: { actorId, organizationId: org }, Date: { now: () => now },
    localStorage: { setItem: (key, value) => local.set(key, value) },
    sessionStorage: { setItem: (key, value) => session.set(key, value) },
  });
  assert.deepEqual([...local], [['ihomecrm.selectedOrganizationId', org], [`schedNotif:lastRun:${actorId}`, String(now)]]);
  assert.deepEqual([...session], [['invoices:overdue-checked-at', String(now)]]);
  assert.equal(now - Number(session.get('invoices:overdue-checked-at')) < 10 * 60_000, true);
});
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
