import { describe, expect, it } from 'vitest';
import { parseSettlementRoomLifecycle, selectSettlementChronology } from '../contractSettlementTimeline';

const roomId = 'aaaaaaaa-0000-4000-8000-000000000001';
const ids = ['aaaaaaaa-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000013'];
function fixture() {
  return { room: { id: roomId, name: '301', buildingId: roomId, buildingName: '80DS3' },
    range: { from: null, to: null }, generatedAt: '2026-09-20T10:00:00Z', vacancies: [], events: [],
    contracts: ids.map((id, i) => ({ id, number: `HD${i}`, status: i === 2 ? 'ACTIVE' : 'TERMINATED',
      signedDate: `2026-0${i + 1}-01`, startDate: `2026-0${i + 1}-10`, endDate: '2026-12-31', actualEndDate: i === 2 ? null : `2026-0${i + 2}-10`,
      rentPrice: 4_000_000, totalDeposit: 4_000_000, tenantName: `Khách ${i}` })),
    segments: ids.map((contractId, i) => ({ contractId, contractNumber: `HD${i}`, segIndex: 0,
      fromDate: `2026-0${i + 1}-10`, toDate: i === 2 ? null : `2026-0${i + 2}-10`, sourcePath: 'contracts', trusted: true, diagnostic: null })),
  };
}
describe('settlement room chronology', () => {
  it('keeps the middle target after termination and selects the actual previous and current room residents', () => {
    const data = fixture(); data.contracts.reverse(); data.segments.reverse();
    const result = selectSettlementChronology(parseSettlementRoomLifecycle(data, roomId), ids[1], '2026-09-20');
    expect(result.targetContractId).toBe(ids[1]);
    expect(result.warning).toBeNull();
    expect(result.lanes.map(lane => [lane.contract.id, lane.role])).toEqual([[ids[0], 'previous'], [ids[1], 'target'], [ids[2], 'current']]);
    expect(result.lanes[1].contract.signedDate).toBe('2026-02-01');
  });
  it('leaves the signing date unknown when the old RPC omits it instead of copying the lease start', () => {
    const data = fixture(); const old = data.contracts.map(({ signedDate: _signedDate, ...contract }) => contract);
    const parsed = parseSettlementRoomLifecycle({ ...data, contracts: old }, roomId);
    expect(parsed.contracts[1].signedDate).toBeNull();
    expect(parsed.contracts[1].startDate).toBe('2026-02-10');
  });
  it.each(['overlap', 'reversed', 'untrusted', 'returning'] as const)('does not invent a previous resident for %s chronology', kind => {
    const data = fixture();
    if (kind === 'overlap') data.segments[0].toDate = '2026-02-20';
    if (kind === 'reversed') data.segments[0].toDate = '2025-12-01';
    if (kind === 'untrusted') data.segments[0].trusted = false;
    if (kind === 'returning') data.segments.push({ ...data.segments[0], segIndex: 1, fromDate: '2026-10-01', toDate: null });
    const result = selectSettlementChronology(parseSettlementRoomLifecycle(data, roomId), ids[1], '2026-09-20');
    expect(result.warning).not.toBeNull();
    expect(result.lanes.map(lane => [lane.contract.id, lane.role])).toEqual([[ids[1], 'target']]);
  });
  it('does not attach a pre-contract bonus or an unavailable target to the current contract', () => {
    const parsed = parseSettlementRoomLifecycle(fixture(), roomId);
    expect(selectSettlementChronology(parsed, null, '2026-09-20')).toMatchObject({ targetContractId: null, lanes: [], warning: 'RESERVATION_SOURCE' });
    expect(selectSettlementChronology(parsed, roomId, '2026-09-20')).toMatchObject({ targetContractId: roomId, lanes: [], warning: 'TARGET_UNAVAILABLE' });
  });
  it('rejects malformed, duplicated and cross-room payloads rather than silently producing empty or zero facts', () => {
    for (const data of [{ ...fixture(), room: { ...fixture().room, id: ids[0] } },
      { ...fixture(), contracts: [...fixture().contracts, fixture().contracts[0]] },
      { ...fixture(), segments: [{ ...fixture().segments[0], fromDate: '2026-02-31' }] },
      { ...fixture(), contracts: [{ ...fixture().contracts[0], rentPrice: 'unknown' }] }]) {
      expect(() => parseSettlementRoomLifecycle(data, roomId)).toThrow();
    }
  });
  it('keeps unverified event amounts as reference events, never calculating cash totals from them', () => {
    const data = { ...fixture(), events: [
      { type: 'DEPOSIT_RECEIVED', date: '2026-02-10', contractId: ids[1], amount: 8_000_000, trusted: true, meta: { code: 'PT1' } },
      { type: 'INVOICE_COLLECTION_POSTED', date: '2026-02-10', contractId: ids[1], amount: 3_000_000, trusted: true, meta: null },
      { type: 'COMMISSION_PAID', date: '2026-02-10', contractId: ids[1], amount: 2_000_000, trusted: false, meta: null },
    ] };
    const result = selectSettlementChronology(parseSettlementRoomLifecycle(data, roomId), ids[1], '2026-09-20');
    expect(result.lanes[1].contract.totalDeposit).toBe(4_000_000);
    expect(result).not.toHaveProperty('cashCollected');
    expect(result).not.toHaveProperty('paidCommission');
  });
});
