import { describe, it, expect, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { parseResidenceSummaries, parseResidenceHistory, residenceSummaryLabel } from '../customerResidenceHistory';
const customer = '00000000-0000-4000-8000-000000000001';
const base = {
  customer_id: customer,
  state: 'DEPARTED' as const,
  current_accommodations: [],
  departure_date: '2026-10-06',
  incomplete: false
};
describe('residence boundary', () => {
  it('shows actual date, current rooms on return, unknown date and no residence honestly', () => {
    expect(residenceSummaryLabel(parseResidenceSummaries([base], [customer])[0])).toBe('Đã rời · 06/10/2026');
    expect(residenceSummaryLabel({
      ...base,
      state: 'CURRENT',
      current_accommodations: [{
        contract_id: customer,
        building_id: customer,
        room_id: customer,
        building_name: 'A',
        room_name: '101'
      }],
      departure_date: null
    })).toBe('A · Phòng 101');
    expect(residenceSummaryLabel({ ...base, departure_date: null })).toBe('Đã rời · Chưa rõ ngày');
    expect(residenceSummaryLabel({ ...base, state: 'NONE' })).toBe('Chưa có lưu trú');
    expect(residenceSummaryLabel({ ...base, state: 'UNKNOWN' })).toBe('Chưa đủ quyền xác định lưu trú');
  });
  it.each([null, {}, [], [{ ...base, customer_id: 'wrong' }], [{ ...base, departure_date: '2026-99-88' }], [base, base]])('rejects malformed/incomplete subject responses', value => {
    expect(() => parseResidenceSummaries(value, [customer])).toThrow();
  });
  it('requires deterministic valid pages and preserves unknown dates', () => {
    const event = {
      id: 2,
      organization_id: customer,
      customer_id: customer,
      contract_id: customer,
      building_id: customer,
      room_id: customer,
      building_name: 'A',
      room_name: '101',
      contract_number: 'HD1',
      kind: 'OBSERVED',
      effective_date: null,
      recorded_at: '2026-10-07T00:00:00Z',
      reason: null,
      actor_id: null,
      actor_name: null,
      incomplete: true
    };
    expect(parseResidenceHistory({ events: [event], next_before_id: null }, customer, customer).events[0].effective_date).toBeNull();
    expect(() => parseResidenceHistory({ events: [event], next_before_id: 8 }, customer, customer)).toThrow();
    expect(() => parseResidenceHistory({ events: [{ ...event, customer_id: 'wrong' }], next_before_id: null }, customer, customer)).toThrow();
  });
});
