import { describe, expect, it } from 'vitest';
import { parseSettlementEventPage, readSettlementEvents, settlementEventQueryKey, type SettlementEventScope } from '../contractSettlementEventReader';

const org = 'dddd0000-0000-4000-8000-000000000001';
const building = 'dddd0000-0000-4000-8000-000000000002';
const id = (n: number) => `dddd0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: SettlementEventScope = { organizationId: org, actorId: id(3), scopeRevision: 'v1', buildingIds: [building] };
const event = (n = 10) => ({ id: `contract:${id(n)}`, sourceKind: 'contract', sourceId: id(n), type: 'sign', organizationId: org,
  buildingId: building, roomId: id(4), roomName: '101', contractId: id(n), relatedContractId: null, sourceVoucherId: null,
  customerName: 'Khách', staffName: null, sourceCode: 'HD-TEST', businessDate: '2026-09-01', origin: 'contract',
  description: 'Ký hợp đồng', notes: null, links: { complete: true, vouchers: [] }, warning: null });
const page = (rows = [event()], nextCursor: string | null = null, revision = 'r1') => ({ rows, nextCursor, revision, asOf: '2026-09-20T20:00:00Z', organizationId: org, actorId: scope.actorId });

describe('authenticated business event reader', () => {
  it('validates identity, genuine calendar dates, source kind/type and scope', () => {
    expect(parseSettlementEventPage(page(), scope).rows[0].sourceId).toBe(id(10));
    for (const row of [{ ...event(), id: 'contract:wrong' }, { ...event(), businessDate: '2026-02-30' },
      { ...event(), organizationId: id(99) }, { ...event(), buildingId: id(99) },
      { ...event(), type: 'renew' }, { ...event(), contractId: null },
      { ...event(), links: { complete: true, vouchers: [{ id: id(20), code: 'PC', amount: -1 }] } }]) {
      expect(() => parseSettlementEventPage(page([row]), scope)).toThrow();
    }
    expect(() => parseSettlementEventPage({ ...page(), organizationId: id(99) }, scope)).toThrow();
    expect(() => parseSettlementEventPage({ ...page(), actorId: id(99) }, scope)).toThrow();
  });
  it('keeps source identity across two renewals, unknown date and converted reservation', () => {
    const renew = { ...event(), id: `extension:${id(11)}`, sourceKind: 'extension', sourceId: id(11), type: 'renew', businessDate: null };
    const reserve = { ...event(), id: `reservation:${id(13)}`, sourceKind: 'reservation', sourceId: id(13), type: 'reserve', sourceVoucherId: id(13), origin: 'reservation' };
    const parsed = parseSettlementEventPage(page([renew, { ...renew, id: `extension:${id(12)}`, sourceId: id(12) }, reserve]), scope);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[2].contractId).toBe(id(10));
    expect(parsed.rows[0].businessDate).toBeNull();
  });
  it('does not turn unavailable financial coverage into no expense', () => {
    const result = parseSettlementEventPage(page([{ ...event(), links: { complete: false, vouchers: [] } }]), scope);
    expect(result.rows[0].links.complete).toBe(false);
  });
  it('loads every page beyond 1000, preserving stable event IDs', async () => {
    const rows = Array.from({ length: 1005 }, (_, i) => event(i + 10));
    let calls = 0;
    const result = await readSettlementEvents(scope, async (_scope, cursor, revision) => {
      expect(revision).toBe(calls ? 'r1' : null);
      const slice = rows.slice(calls * 250, ++calls * 250);
      expect(cursor).toBe(calls === 1 ? null : rows[(calls - 1) * 250 - 1].id);
      return page(slice, calls * 250 < rows.length ? slice.at(-1)!.id : null);
    });
    expect(calls).toBe(5); expect(result.complete).toBe(true); expect(result.rows).toHaveLength(1005);
  });
  it('marks partial rather than complete when revision changes, duplicate IDs or later RPC fails', async () => {
    for (const fail of ['revision', 'duplicate', 'error']) {
      let calls = 0;
      const result = await readSettlementEvents(scope, async () => {
        if (calls++ === 0) return page([event()], event().id);
        if (fail === 'error') throw Error('EVENT_READ_FAILED');
        return page([event(fail === 'duplicate' ? 10 : 11)], null, fail === 'revision' ? 'r2' : 'r1');
      });
      expect(result.complete).toBe(false); expect(result.error).not.toBeNull(); expect(result.rows).toHaveLength(1);
    }
  });
  it('rejects a corrupt cursor and propagates cancellation', async () => {
    const result = await readSettlementEvents(scope, async () => page([event()], 'unrelated'));
    expect(result.complete).toBe(false);
    const abort = new AbortController(); abort.abort();
    await expect(readSettlementEvents(scope, async () => page(), abort.signal)).rejects.toThrow();
  });
  it('isolates auth/org/scope changes while keeping display month outside the complete-set cache', () => {
    expect(settlementEventQueryKey(scope)).not.toEqual(settlementEventQueryKey({ ...scope, actorId: id(5) }));
    expect(settlementEventQueryKey(scope)).not.toEqual(settlementEventQueryKey({ ...scope, scopeRevision: 'v2' }));
    expect(settlementEventQueryKey({ ...scope, buildingIds: [building, building] })).toEqual(settlementEventQueryKey(scope));
  });
});
