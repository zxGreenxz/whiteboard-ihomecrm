import { expect, it } from 'vitest';
import { settlementTimelineLane } from '../settlementTimelinePresentation';
import type { SettlementChronologyLane } from '@/lib/contractSettlementTimeline';
import type { SettlementFinancialContext } from '@/lib/contractSettlementFinancialContext';
const lane: SettlementChronologyLane = { role: 'target', segments: [], contract: { id: 'target', number: 'HD-2', tenantName: 'Khách cũ', status: 'TERMINATED', signedDate: '2026-02-01', startDate: '2026-02-10', endDate: '2027-02-10', actualEndDate: '2026-09-13', rentPrice: 4000000, totalDeposit: 4000000 } };
const known = (amount: number) => ({ state: 'verified' as const, amount, basis: 'fixture' });
const facts = { targetContractId: 'target', depositRequired: known(4000000), depositReceived: known(3900000), otherReceived: known(12000000), currentDebt: known(100000), terminationDebt: known(0), refundOwed: known(3000000), refunded: known(1000000), refundRemaining: known(2000000), termination: { date: '2026-09-13', status: 'APPROVED' }, today: '2026-09-21' } as unknown as SettlementFinancialContext;
it('shows signing, cash, present debt and exact termination facts without moving the selected contract', () => {
  const result = settlementTimelineLane(lane, facts);
  expect(result).toMatchObject({ id: 'target', role: 'target', code: 'HD-2', customer: 'Khách cũ' });
  expect(result.steps[0].value).toBe('01/02/2026');
  expect(result.steps[1].value).toContain('3.900.000');
  expect(result.steps[2].value).toContain('12.000.000');
  expect(result.steps[2].detail).toContain('100.000');
  expect(result.steps[3].value).toBe('13/09/2026');
  expect(result.steps[3].detail).toContain('3.000.000');
  expect(result.steps[3].detail).toContain('2.000.000');
});
it('does not fill missing or another contract cash facts from the deposit requirement or actual end date', () => {
  for (const context of [undefined, { ...facts, targetContractId: 'newest' }]) {
    const result = settlementTimelineLane(lane, context);
    expect(result.steps[1].value).toBe('Chưa xác minh');
    expect(result.steps[2].value).toBe('Chưa xác minh');
    expect(result.steps[3].value).toBe('Chưa xác minh');
    expect(result.steps[3].detail).not.toContain('3.000.000');
  }
});
it('labels a reference contract as current only from chronology and preserves unavailable debt', () => {
  const result = settlementTimelineLane({ ...lane, role: 'current' }, { ...facts, termination: null, currentDebt: { state: 'unavailable', reason: 'CARRY_UNVERIFIED' } });
  expect(result.role).toBe('current');
  expect(result.steps[2].detail).toContain('Chưa xác minh');
  expect(result.steps[3].value).toBe('Chưa xác minh');
});
