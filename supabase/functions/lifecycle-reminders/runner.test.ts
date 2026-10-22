// Test 3 pha của lifecycle-reminders: bảo trì → lifecycle → drain chung. RPC/fetch đều giả.
// Trọng tâm: pha lỗi được ghi lifecycle_reminder_record_failure_v1 có tiền tố và KHÔNG chặn pha sau.
import assert from 'node:assert/strict';
import type { DrainRpc, FetchLike } from '../_shared/push-drain.ts';
import { LIFECYCLE_RUN_BUDGET_MS, parseLifecycleDelivery, parseLifecycleOrgIds, runLifecycleReminders } from './runner.ts';

const URL_BASE = 'https://test-project.supabase.co';
const KEY = 'test-only-service-key';
const ORG = '0e5d1f9a-3c2b-4a1d-9f00-112233445566';
const USER = '7a7a7a7a-0000-4000-8000-000000000001';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const NOTIF = '55555555-5555-4555-8555-555555555555';
const ORG2 = '0e5d1f9a-3c2b-4a1d-9f00-665544332211';

type RpcReply = { data?: unknown; error?: unknown };
type Handler = (args?: Record<string, unknown>) => RpcReply;

function fakeRpc(overrides: Record<string, Handler> = {}) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  let drainClaims = 0;
  const delivery = {
    id: DELIVERY, lease: LEASE, user_id: USER, organization_id: ORG, idempotency_key: `lifecycle:${DELIVERY}:1`,
    notification_ids: [NOTIF], title: 'Nhắc việc', body: '2 phòng sắp trả', url: '/my-day',
  };
  const defaults: Record<string, Handler> = {
    notification_maintenance_v1: () => ({ data: { reconciled: 3 } }),
    lifecycle_reminder_org_ids_v1: () => ({ data: [ORG] }),
    lifecycle_reminder_sweep_v1: () => ({ data: { inserted: 1 } }),
    lifecycle_reminder_claim_v1: () => ({ data: [delivery] }),
    lifecycle_reminder_validate_v1: () => ({ data: delivery }),
    lifecycle_reminder_settle_v1: () => ({ data: null }),
    lifecycle_reminder_record_failure_v1: () => ({ data: null }),
    notify_claim_push_batch_v2: () => ({ data: drainClaims++ === 0 ? [{
      notification_ids: [NOTIF], user_id: USER, organization_id: ORG, idem_key: 'drain-k1', title: '1 thông báo mới',
      body: 'Phiếu chờ duyệt', url: '/approvals', tag: `crm-${USER}`, data: { notificationIds: [NOTIF], organizationId: ORG },
    }] : [] }),
    notify_settle_push_batch_v2: () => ({ data: 1 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  };
  const handlers = { ...defaults, ...overrides };
  const rpc: DrainRpc = (name, args) => {
    calls.push({ name, args });
    const handler = handlers[name];
    const reply = handler ? handler(args) : { error: { message: `RPC ngoài dự kiến: ${name}` } };
    return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
  };
  const failures = () => calls.filter((c) => c.name === 'lifecycle_reminder_record_failure_v1').map((c) => String(c.args?.p_error));
  return { rpc, calls, names: () => calls.map((c) => c.name), failures };
}

function fakeFetch(outcome: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ outcome: 'SENT', sent: 1 })) {
  const bodies: Record<string, unknown>[] = [];
  const fetcher: FetchLike = (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const reply = { idempotencyKey: body.idempotencyKey, failed: 0, retryable: false, ...outcome(body) };
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }));
  };
  return { fetcher, bodies };
}

Deno.test('ba pha chạy đúng thứ tự, đều ok ⇒ ok=true, không ghi lỗi', async () => {
  const { rpc, calls, names, failures } = fakeRpc();
  const { fetcher } = fakeFetch();
  const result = await runLifecycleReminders(rpc, fetcher, URL_BASE, KEY);
  assert.equal(result.ok, true);
  assert.deepEqual(names(), [
    'notification_maintenance_v1',
    'lifecycle_reminder_org_ids_v1', 'lifecycle_reminder_sweep_v1',
    'lifecycle_reminder_claim_v1', 'lifecycle_reminder_validate_v1', 'lifecycle_reminder_settle_v1',
    'notify_claim_push_batch_v2', 'notify_settle_push_batch_v2', 'notify_claim_push_batch_v2', 'notify_drain_record_run_v1',
  ]);
  assert.deepEqual(calls.find((c) => c.name === 'lifecycle_reminder_sweep_v1')?.args, { p_organization_id: ORG });
  assert.deepEqual(result.lifecycle.sweep, [{ organizationId: ORG, result: { inserted: 1 } }]);
  assert.deepEqual(failures(), []);
  assert.deepEqual(result.maintenance, { ok: true, result: { reconciled: 3 } });
  assert.equal(result.lifecycle.delivered, 1);
  assert.equal(result.drain.ok, true);
});

Deno.test('lifecycle truyền data {notificationIds, organizationId} sang send-push', async () => {
  const { rpc } = fakeRpc();
  const { fetcher, bodies } = fakeFetch();
  await runLifecycleReminders(rpc, fetcher, URL_BASE, KEY);
  const lifecycle = bodies.find((b) => String(b.idempotencyKey).startsWith('lifecycle:'));
  assert.deepEqual(lifecycle, {
    userId: USER, idempotencyKey: `lifecycle:${DELIVERY}:1`, notificationIds: [NOTIF], title: 'Nhắc việc',
    body: '2 phòng sắp trả', url: '/my-day', tag: `lifecycle:${DELIVERY}`, data: { notificationIds: [NOTIF], organizationId: ORG },
  });
});

Deno.test('bảo trì lỗi ⇒ ghi [maintenance], lifecycle và drain vẫn chạy, ok=false', async () => {
  const { rpc, names, failures } = fakeRpc({ notification_maintenance_v1: () => ({ error: { code: '42883', message: 'function does not exist' } }) });
  const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY);
  assert.equal(result.ok, false);
  assert.equal(result.maintenance.ok, false);
  assert.equal(failures().length, 1);
  assert.match(failures()[0], /^\[maintenance\] \{"code":"42883"/);
  assert.ok(names().includes('lifecycle_reminder_settle_v1'));
  assert.ok(names().includes('notify_drain_record_run_v1'));
  assert.equal(result.lifecycle.ok, true);
  assert.equal(result.drain.ok, true);
});

Deno.test('EDGE-6: sweep lỗi ⇒ ghi [lifecycle] sweep <org>, claim/validate/settle VẪN gửi delivery có sẵn, drain vẫn chạy', async () => {
  const { rpc, names, failures } = fakeRpc({ lifecycle_reminder_sweep_v1: () => ({ error: { message: 'canceling statement due to statement timeout', code: '57014' } }) });
  const { fetcher, bodies } = fakeFetch();
  const result = await runLifecycleReminders(rpc, fetcher, URL_BASE, KEY);
  assert.equal(result.lifecycle.ok, false);
  assert.equal(failures().length, 1);
  assert.match(failures()[0], new RegExp(`^\\[lifecycle\\] sweep ${ORG}: .*lifecycle_reminder_sweep_v1: canceling statement`));
  assert.ok(names().includes('lifecycle_reminder_settle_v1'));
  assert.ok(bodies.some((b) => String(b.idempotencyKey).startsWith('lifecycle:')));
  assert.equal(result.lifecycle.delivered, 1);
  assert.ok(names().includes('notify_claim_push_batch_v2'));
  assert.equal(result.drain.ok, true);
  assert.equal(result.ok, false);
});

Deno.test('EDGE-6: sweep TỪNG công ty, tuần tự; công ty đầu lỗi không chặn công ty sau', async () => {
  const { rpc, calls, failures } = fakeRpc({
    lifecycle_reminder_org_ids_v1: () => ({ data: [ORG, ORG2] }),
    lifecycle_reminder_sweep_v1: (args) => args?.p_organization_id === ORG
      ? { error: { code: '40P01', message: 'deadlock detected' } }
      : { data: { inserted: 2 } },
  });
  const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY);
  const sweeps = calls.filter((c) => c.name === 'lifecycle_reminder_sweep_v1').map((c) => c.args);
  assert.deepEqual(sweeps, [{ p_organization_id: ORG }, { p_organization_id: ORG2 }]);
  assert.deepEqual(result.lifecycle.sweep, [{ organizationId: ORG2, result: { inserted: 2 } }]);
  assert.equal(failures().length, 1);
  assert.match(failures()[0], new RegExp(`^\\[lifecycle\\] sweep ${ORG}: `));
  assert.ok(!failures()[0].includes(ORG2));
  assert.equal(result.lifecycle.delivered, 1);
});

Deno.test('EDGE-6: lấy danh sách công ty lỗi/sai hình dạng ⇒ ghi [lifecycle] sweep org_ids, không sweep, claim vẫn chạy', async () => {
  for (const reply of [{ error: { code: 'PGRST202', message: 'Could not find the function' } }, { data: { not: 'array' } }, { data: ['khong-phai-uuid'] }]) {
    const { rpc, names, failures } = fakeRpc({ lifecycle_reminder_org_ids_v1: () => reply });
    const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY);
    assert.ok(!names().includes('lifecycle_reminder_sweep_v1'), JSON.stringify(reply));
    assert.ok(names().includes('lifecycle_reminder_settle_v1'), JSON.stringify(reply));
    assert.match(failures()[0], /^\[lifecycle\] sweep org_ids: /, JSON.stringify(reply));
    assert.equal(result.lifecycle.ok, false);
  }
  assert.deepEqual(parseLifecycleOrgIds([ORG, ORG2]), [ORG, ORG2]);
  assert.deepEqual(parseLifecycleOrgIds([]), []);
});

Deno.test('EDGE-7: ngân sách 3 pha tính từ đầu lượt — lifecycle tiêu gần hết thì drain không claim; mặc định 110 s', async () => {
  assert.equal(LIFECYCLE_RUN_BUDGET_MS, 110_000);
  let clock = 0;
  const { rpc, names } = fakeRpc({
    lifecycle_reminder_settle_v1: () => { clock += 105_000; return { data: null }; },
  });
  const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY, { now: () => clock });
  assert.ok(!names().includes('notify_claim_push_batch_v2'));
  assert.equal(names().at(-1), 'notify_drain_record_run_v1');
  assert.equal(result.drain.ok, true);
  assert.equal('stoppedBy' in result.drain && result.drain.stoppedBy, 'deadline');
  assert.equal(result.ok, true);
});

Deno.test('lifecycle CONFIG_ERROR: production ⇒ lỗi pha [lifecycle]; project TEST ⇒ miễn (thiếu VAPID cố ý)', async () => {
  const configError = () => ({ outcome: 'CONFIG_ERROR', sent: 0, retryable: false, error: 'Thiếu VAPID' });
  const prod = fakeRpc({ notify_claim_push_batch_v2: () => ({ data: [] }) });
  const onProd = await runLifecycleReminders(prod.rpc, fakeFetch(configError).fetcher, 'https://tryymsxyyckgbrmmvozx.supabase.co', KEY);
  assert.deepEqual(prod.failures(), [`[lifecycle] ${DELIVERY}: CONFIG_ERROR`]);
  assert.equal(onProd.ok, false);
  const test = fakeRpc({ notify_claim_push_batch_v2: () => ({ data: [] }) });
  const onTest = await runLifecycleReminders(test.rpc, fakeFetch(configError).fetcher, 'https://abcdefghijklmnopqrst.supabase.co', KEY);
  assert.deepEqual(test.failures(), []);
  assert.equal(onTest.ok, true);
});

Deno.test('giao lifecycle thất bại (PROVIDER_ERROR) ⇒ settle vẫn ghi, pha lifecycle đánh lỗi có id', async () => {
  const { rpc, calls, failures } = fakeRpc();
  const { fetcher } = fakeFetch((body) => String(body.idempotencyKey).startsWith('lifecycle:')
    ? { outcome: 'PROVIDER_ERROR', retryable: true, sent: 0, error: '503' }
    : { outcome: 'SENT', sent: 1 });
  const result = await runLifecycleReminders(rpc, fetcher, URL_BASE, KEY);
  const settle = calls.find((c) => c.name === 'lifecycle_reminder_settle_v1');
  assert.deepEqual(settle?.args, { p_id: DELIVERY, p_lease: LEASE, p_outcome: 'PROVIDER_ERROR', p_sent: 0, p_error: '503' });
  assert.deepEqual(failures(), [`[lifecycle] ${DELIVERY}: PROVIDER_ERROR`]);
  assert.equal(result.drain.ok, true);
  assert.equal(result.ok, false);
});

Deno.test('drain lỗi ⇒ ghi [drain]; maintenance/lifecycle vẫn ok', async () => {
  const { rpc, failures } = fakeRpc({ notify_claim_push_batch_v2: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) });
  const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY);
  assert.equal(result.maintenance.ok, true);
  assert.equal(result.lifecycle.ok, true);
  assert.equal(result.drain.ok, false);
  assert.match(failures()[0], /^\[drain\] \{"code":"PGRST202"/);
  assert.equal(result.ok, false);
});

Deno.test('ghi lỗi pha cũng hỏng ⇒ không ném, pha sau vẫn chạy, failureLogError được báo', async () => {
  const { rpc, names } = fakeRpc({
    notification_maintenance_v1: () => ({ error: { message: 'boom' } }),
    lifecycle_reminder_record_failure_v1: () => ({ error: { message: 'health table locked' } }),
  });
  const result = await runLifecycleReminders(rpc, fakeFetch().fetcher, URL_BASE, KEY);
  assert.equal(result.maintenance.ok, false);
  assert.match(result.maintenance.ok === false ? result.maintenance.failureLogError ?? '' : '', /health table locked/);
  assert.ok(names().includes('notify_drain_record_run_v1'));
});

Deno.test('parseLifecycleDelivery chấp nhận organization_id null/vắng, chặn sai kiểu', () => {
  const base = { id: DELIVERY, lease: LEASE, user_id: USER, idempotency_key: 'k', notification_ids: [], title: 't', body: 'b', url: '/' };
  assert.equal(parseLifecycleDelivery(base).organization_id, null);
  assert.equal(parseLifecycleDelivery({ ...base, organization_id: ORG }).organization_id, ORG);
  assert.throws(() => parseLifecycleDelivery({ ...base, organization_id: 5 }), /organization_id/);
});
