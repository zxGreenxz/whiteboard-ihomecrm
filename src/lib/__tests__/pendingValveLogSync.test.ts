import { describe, expect, it, vi } from 'vitest';
import { createFinancialPendingStore, PENDING_SETTLE_MS } from '../financialPending';
import { createPendingValve, type PendingValveLogEntry } from '../pendingValve';
import { createPendingValveLogSync, PENDING_VALVE_LOG_BATCH, type PendingValveLogPayload } from '../pendingValveLogSync';

// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0 = Date.parse('2026-11-24T02:00:00.000Z');
const ORG = '00000000-0000-4000-8000-000000000001';
const scope = (businessKey: string, organizationId = ORG) => ({ namespace: 'voucher-form-create', userId: 'u1', organizationId, businessKey });

function harness(options: { activeOrganization?: string | null } = {}) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
  let clock = T0;
  const now = () => new Date(clock);
  const store = createFinancialPendingStore({ storage, now });
  const valve = createPendingValve({ storage, now, contextOrganization: () => options.activeOrganization ?? null });
  let made = 0;
  /** Tự gỡ n dấu đã quá 2 phút, trả các dòng nhật ký theo thứ tự. */
  const release = (n: number, organizationId = ORG): PendingValveLogEntry[] => {
    const keys = Array.from({ length: n }, () => `K${(made += 1)}`);
    for (const key of keys) store.markPending(scope(key, organizationId), { attemptId: `a-${key}`, operation: 'lập phiếu thu' });
    clock += PENDING_SETTLE_MS;
    return keys.map((key) => {
      valve.report({ pending: store.read(scope(key, organizationId))!, store });
      return valve.release(valve.current()!);
    });
  };
  const server = new Map<string, PendingValveLogPayload>();
  const calls: Array<{ entries: PendingValveLogPayload[]; device: string | null }> = [];
  /** Máy chủ giả đúng hợp đồng của pending_valve_release_log_append_v1: chống trùng theo id. */
  const append = vi.fn<(entries: PendingValveLogPayload[], device: string | null) => Promise<unknown>>(async (entries, device) => {
    calls.push({ entries, device });
    return {
      results: entries.map((entry) => {
        if (server.has(entry.id)) return { id: entry.id, status: 'duplicate' };
        server.set(entry.id, entry);
        return { id: entry.id, status: 'inserted' };
      }),
    };
  });
  const sessionUserId = vi.fn(async () => 'u1' as string | null);
  const sync = createPendingValveLogSync({ log: valve, append, sessionUserId, device: () => 'Mozilla/5.0 (iPhone) Safari' });
  return { map, store, valve, release, server, calls, append, sessionUserId, sync, advance: (ms: number) => { clock += ms; } };
}

describe('đẩy hàng đợi nhật ký tự gỡ lên máy chủ', () => {
  it('máy chủ xác nhận đã ghi thì dòng rời hàng đợi; gửi đúng hình dạng dòng và thiết bị', async () => {
    const h = harness({ activeOrganization: ORG });
    const [entry] = h.release(1);
    expect(h.valve.readLog('u1')).toHaveLength(1);
    expect(await h.sync.flush('u1')).toMatchObject({ sent: 1, acknowledged: 1, kept: 0, error: null });
    expect(h.valve.readLog('u1')).toEqual([]);
    expect(h.calls).toEqual([{
      device: 'Mozilla/5.0 (iPhone) Safari',
      entries: [{
        id: entry.id, userId: 'u1', organizationId: ORG, contextOrganizationId: ORG, namespace: 'voucher-form-create',
        businessKey: entry.businessKey, operation: 'lập phiếu thu', attemptId: entry.attemptId, recordIds: [], recordCount: 0,
        stuckAt: entry.stuckAt, releasedAt: entry.releasedAt,
      }],
    }]);
  });

  it('đẩy hỏng (mất mạng) thì dòng ở lại, không ném lỗi; lần sau đẩy được thì mới rời hàng đợi', async () => {
    const h = harness();
    h.release(2);
    h.append.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await h.sync.flush('u1');
    expect(first).toMatchObject({ sent: 2, acknowledged: 0, kept: 2 });
    expect(first.error).toBeInstanceOf(TypeError);
    expect(h.valve.readLog('u1')).toHaveLength(2);
    expect(await h.sync.flush('u1')).toMatchObject({ acknowledged: 2, kept: 0, error: null });
    expect(h.valve.readLog('u1')).toEqual([]);
  });

  it('máy chủ ghi rồi nhưng mất phản hồi: lần gửi lại cùng mã dòng không tạo dòng thứ hai', async () => {
    const h = harness();
    h.release(1);
    h.append.mockImplementationOnce(async (entries) => {
      for (const entry of entries) h.server.set(entry.id, entry);
      throw new TypeError('Failed to fetch');
    });
    await h.sync.flush('u1');
    expect(h.valve.readLog('u1')).toHaveLength(1);
    expect(await h.sync.flush('u1')).toMatchObject({ acknowledged: 1 });
    expect(h.server.size).toBe(1);
    expect(h.valve.readLog('u1')).toEqual([]);
  });

  it('đẩy hỏng không chặn việc tự gỡ dấu kế tiếp', async () => {
    const h = harness();
    h.release(1);
    h.append.mockRejectedValue(new Error('500'));
    await h.sync.flush('u1');
    expect(h.release(1)).toHaveLength(1);
    expect(h.valve.readLog('u1')).toHaveLength(2);
  });

  it('một dòng bị từ chối rõ (không thể ghi lại) rời hàng đợi và không chặn các dòng sau', async () => {
    const h = harness();
    const [bad, good, noOrg, otherSession] = h.release(4);
    h.append.mockImplementationOnce(async () => ({
      results: [
        { id: bad.id, status: 'rejected', reason: 'invalid' },
        { id: good.id, status: 'inserted' },
        { id: noOrg.id, status: 'rejected', reason: 'no_org' },
        { id: otherSession.id, status: 'rejected', reason: 'not_self' },
      ],
    }));
    expect(await h.sync.flush('u1')).toMatchObject({ sent: 4, acknowledged: 2, kept: 2 });
    // no_org / not_self có thể ghi được sau (chọn công ty, phiên đúng người): giữ lại.
    expect(h.valve.readLog('u1').map((entry) => entry.id)).toEqual([noOrg.id, otherSession.id]);
    for (const reason of ['not_member', 'conflict']) {
      const [row] = h.release(1);
      h.append.mockImplementationOnce(async (entries) => ({
        results: entries.map((entry) => (entry.id === row.id ? { id: row.id, status: 'rejected', reason } : { id: entry.id, status: 'rejected', reason: 'no_org' })),
      }));
      await h.sync.flush('u1');
      expect(h.valve.readLog('u1').map((entry) => entry.id), reason).not.toContain(row.id);
    }
  });

  it('phản hồi lạ dạng hoặc thiếu dòng thì giữ dòng đó; id ngoài lô bị bỏ qua', async () => {
    const h = harness();
    const [a, b] = h.release(2);
    h.append.mockResolvedValueOnce({ ok: true });
    expect(await h.sync.flush('u1')).toMatchObject({ acknowledged: 0, kept: 2 });
    h.append.mockResolvedValueOnce({ results: [{ id: a.id, status: 'inserted' }, { id: 'la', status: 'inserted' }, { id: b.id, status: 'la' }] });
    expect(await h.sync.flush('u1')).toMatchObject({ acknowledged: 0, kept: 2 });
    h.append.mockResolvedValueOnce({ results: [{ id: a.id, status: 'inserted' }, { id: 'la', status: 'inserted' }] });
    expect(await h.sync.flush('u1')).toMatchObject({ acknowledged: 1, kept: 1 });
    expect(h.valve.readLog('u1').map((entry) => entry.id)).toEqual([b.id]);
  });

  it('không có phiên hoặc phiên là người khác thì không gửi gì', async () => {
    const h = harness();
    h.release(1);
    h.sessionUserId.mockResolvedValueOnce(null);
    expect(await h.sync.flush('u1')).toMatchObject({ skipped: 'no-session', sent: 0 });
    h.sessionUserId.mockResolvedValueOnce('u2');
    expect(await h.sync.flush('u1')).toMatchObject({ skipped: 'other-user', sent: 0 });
    expect(h.append).not.toHaveBeenCalled();
    expect(h.valve.readLog('u1')).toHaveLength(1);
  });

  it('hàng đợi rỗng không gọi máy chủ; hàng đợi hỏng định dạng không ném lỗi và không bị ghi đè', async () => {
    const h = harness();
    expect(await h.sync.flush('u1')).toMatchObject({ sent: 0, acknowledged: 0 });
    h.map.set('ihome:pending-valve-log:v1:u1', '[{"id":1}]');
    expect(await h.sync.flush('u1')).toMatchObject({ skipped: 'unreadable', sent: 0 });
    expect(h.append).not.toHaveBeenCalled();
    expect(h.map.get('ihome:pending-valve-log:v1:u1')).toBe('[{"id":1}]');
  });

  it(`chia lô ${PENDING_VALVE_LOG_BATCH} dòng; lô sau hỏng thì lô trước vẫn rời hàng đợi, phần còn lại ở lại`, async () => {
    const h = harness();
    const rows = h.release(PENDING_VALVE_LOG_BATCH + 3);
    const real = h.append.getMockImplementation()!;
    h.append.mockImplementationOnce(real).mockRejectedValueOnce(new Error('mất mạng'));
    expect(await h.sync.flush('u1')).toMatchObject({ sent: PENDING_VALVE_LOG_BATCH + 3, acknowledged: PENDING_VALVE_LOG_BATCH, kept: 3 });
    expect(h.calls[0].entries).toHaveLength(PENDING_VALVE_LOG_BATCH);
    expect(h.valve.readLog('u1').map((entry) => entry.id)).toEqual(rows.slice(PENDING_VALVE_LOG_BATCH).map((entry) => entry.id));
  });

  it('dòng tự gỡ thêm vào trong lúc đang đẩy không bị mất', async () => {
    const h = harness();
    h.release(1);
    let added: PendingValveLogEntry[] = [];
    const real = h.append.getMockImplementation()!;
    h.append.mockImplementationOnce(async (entries, device) => {
      added = h.release(1);
      return real(entries, device);
    });
    await h.sync.flush('u1');
    // Xác nhận chỉ bỏ đúng các dòng đã gửi; dòng mới nằm lại chờ lần đẩy sau.
    expect(h.valve.readLog('u1').map((entry) => entry.id)).toEqual(added.map((entry) => entry.id));
  });

  it('gọi đẩy chồng nhau chỉ chạy một lượt một lúc, rồi chạy thêm đúng một lượt cho phần mới', async () => {
    const h = harness();
    h.release(1);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const real = h.append.getMockImplementation()!;
    h.append.mockImplementationOnce(async (entries, device) => { await gate; return real(entries, device); });
    const first = h.sync.flush('u1');
    const second = h.sync.flush('u1');
    const third = h.sync.flush('u1');
    h.release(1);
    open();
    await Promise.all([first, second, third]);
    expect(h.append).toHaveBeenCalledTimes(2);
    expect(h.calls.map((call) => call.entries.length)).toEqual([1, 1]);
    expect(h.valve.readLog('u1')).toEqual([]);
  });

  it('cắt độ dài theo giới hạn của máy chủ, giữ tổng số mã bản ghi', async () => {
    const h = harness();
    const entry: PendingValveLogEntry = {
      id: '11111111-1111-4111-8111-111111111111', userId: 'u1', organizationId: 'actor-scope', namespace: 'n'.repeat(150),
      businessKey: 'k'.repeat(1500), operation: 'o'.repeat(250), attemptId: 'a'.repeat(250),
      recordIds: Array.from({ length: 130 }, (_, i) => `${'m'.repeat(250)}${i}`), stuckAt: '2026-11-24T02:00:00.000Z',
      releasedAt: '2026-11-24T02:05:00.000Z',
    };
    h.map.set('ihome:pending-valve-log:v1:u1', JSON.stringify([entry]));
    await h.sync.flush('u1');
    const sent = h.calls[0].entries[0];
    expect(sent.namespace).toHaveLength(100);
    expect(sent.businessKey).toHaveLength(1000);
    expect(sent.operation).toHaveLength(200);
    expect(sent.attemptId).toHaveLength(200);
    expect(sent.recordIds).toHaveLength(100);
    expect(sent.recordIds.every((value) => value.length === 200)).toBe(true);
    expect(sent.recordCount).toBe(130);
    expect(sent.contextOrganizationId).toBeNull();
    expect(sent.organizationId).toBe('actor-scope');
  });
});
