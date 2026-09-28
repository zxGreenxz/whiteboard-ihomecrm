import { expect, it, vi } from 'vitest';
import { runLifecycleReminders, type LifecycleRpc } from '../reminders';
import { resolveNotificationUrl } from '../../notificationRoutes';

const item = { id: 'delivery', lease: 'lease', user_id: 'actual-user-uuid', notification_ids: [], idempotency_key: 'lifecycle:delivery:1', title: 'Việc trả phòng', body: '2 việc', url: '/contracts' };
function fixture(validated: unknown = item) {
  const rpc = vi.fn<LifecycleRpc>(async name => ({ data: name.includes('claim') ? [item] : name.includes('validate') ? validated : { inserted: 1 }, error: null }));
  const fetcher = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ outcome: 'SENT', sent: 1, idempotencyKey: item.idempotency_key }));
  return { rpc, fetcher };
}
it('calls sweep and claim without UI, revalidates before sending, settles only a matched provider receipt', async () => {
  const { rpc, fetcher } = fixture();
  expect((await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).delivered).toBe(1);
  expect(rpc.mock.calls.map(args => args[0])).toEqual(['lifecycle_reminder_sweep_v1','lifecycle_reminder_claim_v1','lifecycle_reminder_validate_v1','lifecycle_reminder_settle_v1']);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string).userId).toBe(item.user_id);
});
it('source/recipient authorization changes between claim and send prevent HTTP', async () => {
  const { rpc, fetcher } = fixture(null);
  expect((await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).outcomes).toEqual({SKIPPED:1});
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  {outcome:'DUPLICATE', sent:0},
  {outcome:'CONFIG_ERROR', sent:0},
  {outcome:'NO_DEVICE', sent:0},
])('does not count $outcome as provider success', async body => {
  const { rpc, fetcher } = fixture();
  fetcher.mockImplementation(async () => Response.json(body));
  const result = await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service');
  expect(result.delivered).toBe(0);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_settle_v1', expect.objectContaining({p_outcome:body.outcome,p_sent:0}));
});
it('HTTP200 with mismatched receipt persists retriable failure and reports unhealthy run', async () => {
  const { rpc, fetcher } = fixture();
  fetcher.mockImplementation(async () => Response.json({outcome:'SENT',sent:1,idempotencyKey:'different-attempt'}));
  expect((await runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).ok).toBe(false);
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_settle_v1', expect.objectContaining({p_outcome:'PROVIDER_ERROR',p_sent:0}));
  expect(rpc).toHaveBeenCalledWith('lifecycle_reminder_record_failure_v1', expect.any(Object));
});
it('failed sweep cannot be marked done or claim pushes', async () => {
  const { rpc, fetcher } = fixture();
  rpc.mockImplementation(async name => ({data:null,error:name.includes('sweep')?{message:'database unavailable'}:null}));
  await expect(runLifecycleReminders(rpc, fetcher, 'https://test.invalid', 'fake-service')).rejects.toThrow('database unavailable');
  expect(rpc.mock.calls.map(args=>args[0])).toEqual(['lifecycle_reminder_sweep_v1','lifecycle_reminder_record_failure_v1']);
  expect(fetcher).not.toHaveBeenCalled();
});
it('lifecycle routes retain module view gates', () => {
  expect(resolveNotificationUrl('/rooms', null)).toBe('/my-day');
  expect(resolveNotificationUrl('/contracts', null)).toBe('/my-day');
});
