import { expect, it, vi } from 'vitest';
import { runLifecycleReminders, type LifecycleRpc } from '../reminders';
import { resolveNotificationUrl } from '../../notificationRoutes';

// Runner 3 pha (21–22/10/2026): bảo trì → lifecycle (sweep TỪNG công ty rồi claim/validate/settle) → drain chung.
// Bản Deno đầy đủ ở supabase/functions/lifecycle-reminders/runner.test.ts; file này giữ hợp đồng nhìn từ app.
const ORG = '00000000-0000-4000-8000-0000000000a1';
const item = { id: 'delivery', lease: 'lease', user_id: 'actual-user-uuid', notification_ids: [], idempotency_key: 'lifecycle:delivery:1', title: 'Việc trả phòng', body: '2 việc', url: '/contracts' };
function fixture(validated: unknown = item) {
  const rpc = vi.fn<LifecycleRpc>(async name => ({
    data: name === 'lifecycle_reminder_org_ids_v1' ? [ORG]
      : name === 'lifecycle_reminder_claim_v1' ? [item]
      : name === 'lifecycle_reminder_validate_v1' ? validated
      : name === 'notify_claim_push_batch_v2' ? []
      : name === 'lifecycle_reminder_sweep_v1' ? { inserted: 1 }
      : null,
    error: null,
  }));
  const fetcher = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ outcome: 'SENT', sent: 1, idempotencyKey: item.idempotency_key }));
  return { rpc, fetcher };
}
const lifecycleCalls = (rpc: ReturnType<typeof fixture>['rpc']) =>
  rpc.mock.calls.map(args => args[0]).filter(name => name.startsWith('lifecycle_reminder_') || name === 'notification_maintenance_v1');

it('bảo trì trước, sweep TỪNG công ty, revalidate trước khi gửi, settle theo biên nhận khớp', async () => {
  const { rpc, fetcher } = fixture();
  const result = await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service');
  expect(result.lifecycle.delivered).toBe(1);
  expect(result.ok).toBe(true);
  expect(lifecycleCalls(rpc)).toEqual(['notification_maintenance_v1', 'lifecycle_reminder_org_ids_v1', 'lifecycle_reminder_sweep_v1',
    'lifecycle_reminder_claim_v1', 'lifecycle_reminder_validate_v1', 'lifecycle_reminder_settle_v1']);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_sweep_v1', { p_organization_id: ORG });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string).userId).toBe(item.user_id);
});
it('nguồn/người nhận đổi giữa claim và gửi ⇒ không gọi HTTP', async () => {
  const { rpc, fetcher } = fixture(null);
  expect((await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).lifecycle.outcomes).toEqual({ SKIPPED: 1 });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { outcome: 'DUPLICATE', sent: 0 },
  { outcome: 'CONFIG_ERROR', sent: 0 },
  { outcome: 'NO_DEVICE', sent: 0 },
])('không tính $outcome là đã giao', async body => {
  const { rpc, fetcher } = fixture();
  fetcher.mockImplementation(async () => Response.json(body));
  const result = await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service');
  expect(result.lifecycle.delivered).toBe(0);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_settle_v1', expect.objectContaining({ p_outcome: body.outcome, p_sent: 0 }));
});
it('HTTP 200 nhưng biên nhận lệch lượt ⇒ settle lỗi thử lại được và lượt chạy không khoẻ', async () => {
  const { rpc, fetcher } = fixture();
  fetcher.mockImplementation(async () => Response.json({ outcome: 'SENT', sent: 1, idempotencyKey: 'different-attempt' }));
  expect((await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).ok).toBe(false);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_settle_v1', expect.objectContaining({ p_outcome: 'PROVIDER_ERROR', p_sent: 0 }));
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_record_failure_v1', expect.any(Object));
});
it('sweep một công ty lỗi: ghi [lifecycle], KHÔNG chặn claim/gửi delivery đã có, lượt chạy không khoẻ', async () => {
  const { rpc, fetcher } = fixture();
  const goc = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name, args) => name === 'lifecycle_reminder_sweep_v1'
    ? { data: null, error: { message: 'database unavailable' } }
    : goc(name, args));
  const result = await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service');
  expect(result.ok).toBe(false);
  expect(result.lifecycle.failures.join(' ')).toContain(`sweep ${ORG}`);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_record_failure_v1',
    { p_error: expect.stringMatching(/^\[lifecycle\] .*database unavailable/) });
});
it('đích của nhắc lifecycle vẫn qua cổng quyền module', () => {
  expect(resolveNotificationUrl('/rooms', null)).toBe('/my-day');
  expect(resolveNotificationUrl('/contracts', null)).toBe('/my-day');
});
