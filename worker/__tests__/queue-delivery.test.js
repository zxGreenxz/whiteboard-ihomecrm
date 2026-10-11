import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
const state = vi.hoisted(() => ({
  sessions: new Map(), writes: [], calls: [], status: 'connected', persistError: null,
  claimAllowed: true, fenceAllowed: true, autoAllowed: true,
  echoFirst: false, queueExists: true,
}));
vi.mock('../lib/ctx.js', () => ({
  sessions: state.sessions, log: () => {}, orgOf: () => 'org',
  sb: {
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      if (name === 'zalo_worker_claim_job_v1') return { data: { ok: state.claimAllowed }, error: null };
      if (name === 'zalo_worker_begin_provider_v1') return { data: state.fenceAllowed, error: null };
      if (name === 'zalo_worker_recover_jobs_v1') return { data: { requeued: 1, unknown: 1 }, error: null };
      if (name === 'zalo_worker_finalize_send_v1') return { data: state.persistError ? null : { ok: true, status: 'sent' }, error: state.persistError };
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: { from: () => ({ download: async () => ({ data: new Blob(['image']), error: null }) }) },
    from: table => {
      let patch;
      let deleting = false;
      const filters = [];
      const result = () => {
        // Model the real FK ON DELETE CASCADE: deleting the pending canonical
        // also destroys the queue receipt and its unique request key.
        if (deleting && table === 'zalo_messages' && filters.some(([key, value]) => key === 'id' && value === 'message')) state.queueExists = false;
        return { data: state.queueExists ? [{ id: 'job' }] : [], count: 1, error: table === 'zalo_messages' && patch?.status === 'sent' ? state.persistError : null };
      };
      const q = {
        update: value => { patch = value; state.writes.push({ table, patch, filters }); return q; },
        delete: () => { deleting = true; return q; }, select: () => q,
        eq: (column, value) => { filters.push([column, value]); return q; },
        in: (column, value) => { filters.push([column, value]); return q; },
        maybeSingle: async () => ({ data: state.echoFirst && table === 'zalo_messages' ? { id: 'echo' } : null, error: null }),
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
      };
      return q;
    },
  },
}));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: 'instance' }));
vi.mock('../lib/inbound.js', () => ({ upsertMessagesForThread: vi.fn(), emojiToZca: value => value }));
vi.mock('../lib/scope-guard.js', () => ({
  validateZaloCommandScope: async () => ({ ok: true, account: { status: state.status }, conv: { thread_id: 'thread', thread_type: 'user' } }),
  formatScopeRejection: value => value.reason, logScopeRejection: vi.fn(), clampHistoryCount: value => value,
}));
vi.mock('../lib/automation-delivery.js', () => ({ validateAutomationDelivery: async () => state.autoAllowed
  ? { ok: true } : { ok: false, reason: 'CANCELLED_AUTOMATION' } }));
import { processJob, recoverInterruptedJobs } from '../lib/queue.js';

const makeJob = payload => ({ id: 'job', account_id: 'account', organization_id: 'org', conversation_id: 'conv', message_id: 'message', payload: { body: 'hello', ...payload } });
const connect = () => {
  const api = { sendMessage: vi.fn().mockResolvedValue({ msgId: 'provider-id' }) };
  state.sessions.set('account', { api });
  return api;
};
beforeEach(() => {
  state.sessions.clear(); state.writes.length = 0; state.calls.length = 0;
  state.status = 'connected'; state.persistError = null;
  state.claimAllowed = true; state.fenceAllowed = true; state.autoAllowed = true;
  state.echoFirst = false; state.queueExists = true;
});
afterEach(() => vi.useRealTimers());

describe('queue admission and delivery outcomes', () => {
  it('preserves the delayed text queue receipt when self-listen inserted an echo first', async () => {
    const api = connect(); state.echoFirst = true;
    await processJob({ ...makeJob(), created_at: '2026-10-11T01:00:00Z', not_before: '2026-10-11T01:20:00Z' });
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(state.queueExists).toBe(true);
    expect(state.calls.filter(call => call.name === 'zalo_worker_finalize_send_v1')).toEqual([{
      name: 'zalo_worker_finalize_send_v1', args: { p_job_id: 'job', p_instance_id: 'instance', p_receipts: [{ message_id: 'message', zalo_msg_id: 'provider-id', cli_msg_id: null }] },
    }]);
    expect(state.writes).toEqual([]);
  });
  it('finalizes all album receipts together without deleting the pending messages', async () => {
    const api = connect(); state.echoFirst = true;
    api.sendMessage.mockResolvedValue({ attachment: [{ msgId: 'image-1', cliMsgId: 'cli-1' }, { msgId: 'image-2', cliMsgId: 'cli-2' }] });
    await processJob(makeJob({ type: 'image', message_ids: ['message', 'message-2'], attachments: [{ path: 'account/1.jpg' }, { path: 'account/2.jpg' }] }));
    expect(state.queueExists).toBe(true);
    expect(state.calls.filter(call => call.name === 'zalo_worker_finalize_send_v1')).toEqual([{
      name: 'zalo_worker_finalize_send_v1', args: { p_job_id: 'job', p_instance_id: 'instance', p_receipts: [
        { message_id: 'message', zalo_msg_id: 'image-1', cli_msg_id: 'cli-1' },
        { message_id: 'message-2', zalo_msg_id: 'image-2', cli_msg_id: 'cli-2' },
      ] },
    }]);
    expect(state.writes).toEqual([]);
  });
  it('defers boot-time queued messages while login is still pending', async () => {
    await processJob(makeJob());
    expect(state.calls).toEqual([]);
    expect(state.writes).toEqual([expect.objectContaining({ table: 'zalo_send_queue', patch: expect.objectContaining({ last_error: expect.stringMatching(/^WAITING_SESSION/), not_before: expect.any(String) }) })]);
    expect(state.writes.some(row => row.patch.status === 'failed')).toBe(false);
  });
  it('does not send using a RAM session after account disconnect', async () => {
    const api = connect(); state.status = 'disconnected';
    await processJob(makeJob());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes[0].patch.last_error).toMatch(/^ACCOUNT_DISCONNECTED/);
  });
  it('does not contact provider when claim was taken by another worker', async () => {
    const api = connect(); state.claimAllowed = false;
    await processJob(makeJob());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it('fences an admitted job if lease or account changes before provider', async () => {
    const api = connect(); state.fenceAllowed = false;
    await processJob(makeJob());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes[0].patch).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/^PROVIDER_NOT_ADMITTED/) });
  });
  it('records unknown effect and provider receipt without retry after persistence failure', async () => {
    const api = connect(); state.persistError = { message: 'DB update failed' };
    await processJob(makeJob());
    expect(api.sendMessage).toHaveBeenCalledOnce();
    const failed = state.writes.find(row => row.table === 'zalo_send_queue' && row.patch.status === 'failed');
    expect(failed.patch).toMatchObject({ last_error: expect.stringMatching(/^UNKNOWN_EFFECT/), result: { outcome: 'unknown', requires_reconciliation: true, provider_message_ids: ['provider-id'] } });
  });
  it('retains known album IDs for reconciliation when another receipt is missing', async () => {
    const api = connect();
    api.sendMessage.mockResolvedValue({ attachment: [{}, { msgId: 'image-2' }] });
    await processJob(makeJob({ type: 'image', message_ids: ['message', 'message-2'], attachments: [{ path: 'account/1.jpg' }, { path: 'account/2.jpg' }] }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(state.calls.some(call => call.name === 'zalo_worker_finalize_send_v1')).toBe(false);
    const failed = state.writes.find(row => row.table === 'zalo_send_queue' && row.patch.status === 'failed');
    expect(failed.patch).toMatchObject({
      last_error: expect.stringMatching(/^UNKNOWN_EFFECT:.*PROVIDER_RECEIPT_MISSING/),
      result: { outcome: 'unknown', requires_reconciliation: true, provider_message_ids: ['image-2'] },
    });
  });
  it('does not resend without quote on an ambiguous timeout', async () => {
    const api = connect(); api.sendMessage.mockRejectedValue(new Error('timeout'));
    await processJob(makeJob({ target_msg_id: 'quoted', target_raw: { content: 'old' } }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(state.writes[0].patch.last_error).toMatch(/^UNKNOWN_EFFECT/);
  });
  it('settles a provider call that never responds as unknown without resending', async () => {
    vi.useFakeTimers();
    const api = connect(); api.sendMessage.mockImplementation(() => new Promise(() => {}));
    const work = processJob(makeJob());
    await vi.advanceTimersByTimeAsync(60_001);
    await work;
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(state.writes[0].patch.last_error).toMatch(/^UNKNOWN_EFFECT:.*PROVIDER_TIMEOUT/);
  });
  it('rejects cancelled automation before claim', async () => {
    const api = connect(); state.autoAllowed = false;
    await processJob(makeJob({ tu_dong: true }));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
    expect(state.writes[0].patch.last_error).toBe('CANCELLED_AUTOMATION');
  });
  it('uses the atomic recovery RPC without attempting provider delivery', async () => {
    const api = connect();
    expect(await recoverInterruptedJobs()).toEqual({ requeued: 1, unknown: 1 });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.calls[0]).toEqual({ name: 'zalo_worker_recover_jobs_v1', args: { p_instance_id: 'instance' } });
  });
});
