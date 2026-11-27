import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
const state = vi.hoisted(() => ({
  sessions: new Map(), writes: [], calls: [], status: 'connected', persistError: null,
  claimAllowed: true, fenceAllowed: true, autoAllowed: true, automationResults: [],
  echoFirst: false, queueExists: true, priorJobs: [],
  forwardSource: null, beforeAdmissionReturns: null, threadType: 'user',
}));
vi.mock('../lib/ctx.js', () => ({
  sessions: state.sessions, log: () => {}, orgOf: () => 'org', SUPABASE_URL: 'https://storage.example.test',
  sb: {
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      if (name === 'zalo_worker_claim_job_v1') return { data: { ok: state.claimAllowed }, error: null };
      if (['zalo_worker_begin_provider_v1', 'zalo_worker_begin_hermes_group_provider_v1'].includes(name)) {
        await state.beforeAdmissionReturns?.();
        return { data: state.fenceAllowed, error: null };
      }
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
        if (filters.some(([key]) => key === 'payload->>automation_request_key')) return { data: state.priorJobs, error: null };
        if (deleting && table === 'zalo_messages' && filters.some(([key, value]) => key === 'id' && value === 'message')) state.queueExists = false;
        return { data: state.queueExists ? [{ id: 'job' }] : [], count: 1, error: table === 'zalo_messages' && patch?.status === 'sent' ? state.persistError : null };
      };
      const q = {
        update: value => { patch = value; state.writes.push({ table, patch, filters }); return q; },
        delete: () => { deleting = true; return q; }, select: () => q,
        eq: (column, value) => { filters.push([column, value]); return q; },
        is: (column, value) => { filters.push([column, value]); return q; },
        lt: (column, value) => { filters.push([column, value]); return q; },
        like: (column, value) => { filters.push([column, value]); return q; },
        neq: (column, value) => { filters.push([column, value]); return q; },
        in: (column, value) => { filters.push([column, value]); return q; },
        maybeSingle: async () => {
          if (state.forwardSource) {
            if (table === 'zalo_messages') return { data: state.forwardSource, error: null };
            if (table === 'zalo_accounts') return { data: { id: 'source-account', organization_id: 'org' }, error: null };
            if (table === 'zalo_conversations') return { data: { id: 'source-conv', account_id: 'source-account', organization_id: 'org' }, error: null };
          }
          return { data: state.echoFirst && table === 'zalo_messages' ? { id: 'echo' } : null, error: null };
        },
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
      };
      return q;
    },
  },
}));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: 'instance' }));
vi.mock('../lib/inbound.js', () => ({ syncAccountGroups: vi.fn(async api => (await api.getAllGroups()).length), upsertMessagesForThread: vi.fn(), emojiToZca: value => value }));
vi.mock('../lib/scope-guard.js', () => ({
  validateZaloCommandScope: async () => ({ ok: true, account: { status: state.status, user_id: 'owner' }, conv: { thread_id: 'thread', thread_type: state.threadType } }),
  formatScopeRejection: value => value.reason, logScopeRejection: vi.fn(), clampHistoryCount: value => value,
}));
vi.mock('../lib/automation-delivery.js', () => ({ validateAutomationDelivery: async () => state.automationResults.shift()
  ?? (state.autoAllowed ? { ok: true } : { ok: false, reason: 'CANCELLED_AUTOMATION' }) }));
import { syncAccountGroups } from '../lib/inbound.js';
import { processJob, recoverInterruptedJobs } from '../lib/queue.js';

const makeJob = payload => ({ id: 'job', account_id: 'account', organization_id: 'org', conversation_id: 'conv', message_id: 'message', payload: { body: 'hello', ...payload } });
const connect = () => {
  const api = { sendMessage: vi.fn().mockResolvedValue({ msgId: 'provider-id' }) };
  state.sessions.set('account', { api });
  return api;
};
beforeEach(() => {
  state.priorJobs = [];
  state.automationResults = [];
  state.sessions.clear(); state.writes.length = 0; state.calls.length = 0;
  state.status = 'connected'; state.persistError = null;
  state.claimAllowed = true; state.fenceAllowed = true; state.autoAllowed = true;
  state.echoFirst = false; state.queueExists = true;
  state.forwardSource = null; state.beforeAdmissionReturns = null; state.threadType = 'user';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('queue admission and delivery outcomes', () => {
  it('refreshes groups through the selected session without sending any message', async () => {
    const api = connect();
    api.getAllGroups = vi.fn(async () => ['g1', 'g2']);
    await processJob({ id: 'job', account_id: 'account', organization_id: 'org', user_id: 'staff', payload: { action: 'sync_groups' } });
    expect(syncAccountGroups).toHaveBeenCalledWith(expect.anything(), 'account', 'owner', 'org');
    expect(api.getAllGroups).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes).toContainEqual(expect.objectContaining({ table: 'zalo_send_queue', patch: expect.objectContaining({ status: 'sent', result: { group_count: 2 } }) }));
  });
  it('routes a forward-media job through the same provider fence and retains unknown send receipts', async () => {
    const api = connect(); state.persistError = { message: 'finalize unavailable' };
    state.forwardSource = { id: 'source', account_id: 'source-account', organization_id: 'org', conversation_id: 'source-conv', msg_type: 'file',
      media_url: 'https://file.dlfl.vn/example', media_label: 'document.pdf', status: 'delivered' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('pdf bytes')));
    api.sendMessage.mockResolvedValue({ attachment: [{ msgId: 'forward-receipt' }] });
    await processJob(makeJob({ kind: 'forward_media', source_message_ids: ['source'], message_ids: ['message'] }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0][0]).toMatchObject({ msg: '', attachments: [{ filename: 'document.pdf' }] });
    expect(state.calls.filter(row => row.name === 'zalo_worker_begin_provider_v1')).toHaveLength(1);
    const failed = state.writes.find(row => row.table === 'zalo_send_queue' && row.patch.status === 'failed');
    expect(failed.patch).toMatchObject({ last_error: expect.stringMatching(/^UNKNOWN_EFFECT/), result: { provider_message_ids: ['forward-receipt'] } });
  });
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
  it('keeps all original photos together and a playable video adjacent, with receipts bound to their sources', async () => {
    const api = connect();
    api.uploadAttachment = vi.fn().mockResolvedValueOnce([{ normalUrl: 'cover' }]).mockResolvedValueOnce([{ fileUrl: 'clip' }]);
    api.sendMessage.mockResolvedValue({ attachment: [{ msgId: 'pic-1' }, { msgId: 'pic-2' }] });
    api.sendVideo = vi.fn().mockResolvedValue({ msgId: 'video-id' });
    await processJob(makeJob({ type: 'image', tu_dong: true, automation_request_key: 'oneshot:shot:conv:room:203:album',
      message_ids: ['message','pic-a','pic-b'], attachments: [
        { path: 'a.mp4', mime: 'video/mp4', duration_ms: 12300, width: 480, height: 854 }, { path: 'b.jpg' }, { path: 'c.jpg' },
      ] }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0][0].attachments.map(a => a.filename)).toEqual(['b.jpg','c.jpg']);
    expect(api.sendVideo).toHaveBeenCalledWith({ videoUrl:'clip', thumbnailUrl:'cover', duration:12300, width:480, height:854 }, 'thread', 0);
    expect(api.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(api.sendVideo.mock.invocationCallOrder[0]);
    expect(state.calls.find(c=>c.name==='zalo_worker_finalize_send_v1').args.p_receipts.map(r=>[r.message_id,r.zalo_msg_id]))
      .toEqual([['pic-a','pic-1'],['pic-b','pic-2'],['message','video-id']]);
  });
  it.each(['failed','sent'])('mentions the group only when delivery of its summary and all prior jobs succeeded: %s', async status => {
    state.threadType = 'group';
    state.priorJobs = [{status:'sent',automation_request_key:'scheduled:day:conv:table_image'},{status,automation_request_key:'scheduled:day:conv:room:203:album'}];
    const api=connect(), text='Link danh sách\n@all';
    await processJob(makeJob({tu_dong:true, automation_request_key:'scheduled:day:conv:link', body:text}));
    const content=api.sendMessage.mock.calls[0][0];
    if (status==='sent') expect(content.mentions).toEqual([{pos:text.length-4,uid:'-1',len:4}]);
    else expect(content).toEqual({msg:'Link danh sách'});
  });
  it('tag all ngay tại đầu tin Lock độc lập trong nhóm', async () => {
    state.threadType = 'group';
    const api = connect();
    const body = '@all Lock 201 – Tòa Sen';
    await processJob(makeJob({ tu_dong: true, automation_request_key: 'room-lock:room:123:conv', body }));
    expect(api.sendMessage).toHaveBeenCalledWith({ msg: body, mentions: [{ pos: 0, uid: '-1', len: 4 }] }, 'thread', 1);
  });
  it.each([false, true])('thử lại tin Lock sau lỗi đọc trước khi gọi Zalo (đã claim=%s)', async claimed => {
    const api = connect();
    if (claimed) state.automationResults.push({ ok: true });
    state.automationResults.push({ ok: false, reason: 'AUTOMATION_UNVERIFIED: offline' });
    const job = makeJob({ tu_dong: true, automation_request_key: 'room-lock:r:100:conv', body: '@all Lock 201 – Tòa Sen' });
    await processJob(job);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toMatchObject({ not_before: expect.any(String) });
    expect(state.writes[0].patch.status).not.toBe('failed');
    if (claimed) {
      expect(state.writes[0].patch.status).toBe('queued');
      expect(state.writes[0].filters).toEqual(expect.arrayContaining([['processing_instance_id', 'instance'], ['provider_started_at', null]]));
    }
    await processJob(job);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it.each([
    ['album', ['failed'], 'failed'],
    ['album', ['processing'], 'wait'],
    ['album', [], 'send'], // legacy album was enqueued before the room text
    ['divider', ['sent'], 'failed'],
    ['divider', ['sent', 'failed'], 'failed'],
    ['divider', ['sent', 'queued'], 'wait'],
    ['divider', ['sent', 'sent'], 'send'],
  ])('checks room delivery before %s with earlier jobs %j', async (part, statuses, outcome) => {
    const api = connect();
    const room = 'scheduled:day:conv:room:203';
    state.priorJobs = statuses.map(status => ({ status }));
    const job = makeJob({ tu_dong: true, automation_request_key: room + ':' + part,
      ...(part === 'album' && { type: 'image', attachments: [{ path: 'account/photo.jpg' }] }) });
    await processJob({ ...job, created_at: '2026-10-11T01:00:05Z' });
    expect(api.sendMessage).toHaveBeenCalledTimes(outcome === 'send' ? 1 : 0);
    if (outcome === 'failed') expect(state.writes[0].patch).toMatchObject({ status: 'failed' });
    if (outcome === 'wait') {
      expect(state.writes).toEqual([]);
      expect(state.calls.some(c => c.name === 'zalo_worker_claim_job_v1')).toBe(false);
    }
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
  it.each(['stop', 'replace'])('does not use the old RAM session after %s during provider admission', async change => {
    const api = connect();
    const replacement = { sendMessage: vi.fn() };
    state.beforeAdmissionReturns = async () => {
      if (change === 'stop') state.sessions.delete('account');
      else state.sessions.set('account', { api: replacement });
    };
    await processJob(makeJob());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(replacement.sendMessage).not.toHaveBeenCalled();
    expect(state.calls.filter(call => call.name === 'zalo_worker_begin_provider_v1')).toHaveLength(1);
    expect(state.writes[0].patch).toMatchObject({
      status: 'failed', last_error: expect.stringMatching(/^UNKNOWN_EFFECT:.*SESSION_CHANGED/),
      result: { outcome: 'unknown', requires_reconciliation: true },
    });
  });
  it('binds Hermes admission to the actual message, thread and registered session generation', async () => {
    const api = connect(); state.threadType = 'group';
    state.sessions.get('account').hermesIngress = { privateReplySource: () => ({
      accountId: 'account', organizationId: 'org', instanceId: 'instance', ownUid: '123', generation: 'generation',
    }) };
    await processJob({ ...makeJob(), hermes_group_dispatch_id: 'proposal' });
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: 'hello' }, 'thread', 1);
    expect(state.calls.filter(call => call.name.includes('begin_'))).toEqual([{
      name: 'zalo_worker_begin_hermes_group_provider_v1', args: {
        p_job_id: 'job', p_instance_id: 'instance', p_delivery: {
          method: 'sendMessage', body: 'hello', threadId: 'thread', threadType: 'group', ownUid: '123', generation: 'generation',
        },
      },
    }]);
  });
  it.each(['missing_ingress', 'user_thread', 'quote'])('rejects an unsupported Hermes request before provider: %s', async reason => {
    const api = connect(); state.threadType = reason === 'user_thread' ? 'user' : 'group';
    if (reason !== 'missing_ingress') state.sessions.get('account').hermesIngress = { privateReplySource: () => ({
      accountId: 'account', organizationId: 'org', instanceId: 'instance', ownUid: '123', generation: 'generation',
    }) };
    await processJob({ ...makeJob(reason === 'quote' ? { target_msg_id: 'quoted', target_raw: { content: 'old' } } : {}), hermes_group_dispatch_id: 'proposal' });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.calls.some(call => call.name.includes('begin_'))).toBe(false);
    expect(state.writes[0].patch.last_error).toMatch(/^HERMES_DELIVERY_CHANGED/);
  });
  it('does not send when Hermes ingress closes while its provider admission is pending', async () => {
    const api = connect(); state.threadType = 'group'; let active = true;
    state.sessions.get('account').hermesIngress = { privateReplySource: () => active ? {
      accountId: 'account', organizationId: 'org', instanceId: 'instance', ownUid: '123', generation: 'generation',
    } : null };
    state.beforeAdmissionReturns = async () => { active = false; };
    await processJob({ ...makeJob(), hermes_group_dispatch_id: 'proposal' });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(state.writes[0].patch).toMatchObject({
      last_error: expect.stringMatching(/^UNKNOWN_EFFECT:.*SESSION_CHANGED/),
      result: { outcome: 'unknown', requires_reconciliation: true },
    });
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
