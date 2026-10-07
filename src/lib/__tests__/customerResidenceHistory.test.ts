import { describe, it, expect, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { parseResidenceSummaries, parseResidenceHistory, residenceSummaryLabel } from '../customerResidenceHistory';
const customer = '00000000-0000-4000-8000-000000000001';
const base = {
  customer_id: customer,
  state: 'DEPARTED' as const,
  current_accommodations: [],
  departure_date: '2026-10-06',
  departure_kind: 'EARLY_RETURN',
  incomplete: false,
  last_contract_end: null
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
    expect(residenceSummaryLabel({ ...base, departure_date: null })).toBe('Không còn HĐ đang ở');
    expect(residenceSummaryLabel({ ...base, state: 'NONE' })).toBe('Chưa liên kết hợp đồng');
    expect(residenceSummaryLabel({ ...base, state: 'UNKNOWN' })).toBe('Chưa đủ quyền xác định lưu trú');
  });
  it.each([
    ['MEMBER_REMOVED', 'Gỡ khỏi HĐ · 06/10/2026'],
    ['TENANT_TRANSFER_OUT', 'Nhượng HĐ · 06/10/2026'],
    ['TERMINATED', 'Kết thúc HĐ · 06/10/2026'],
    ['FORFEIT', 'Bỏ cọc HĐ · 06/10/2026'],
    ['CONTRACT_DELETED', 'Hợp đồng đã xóa'],
    [null, 'Không còn HĐ đang ở']
  ])('does not describe administrative %s as physical departure', (departure_kind, expected) => {
    expect(residenceSummaryLabel({ ...base, departure_kind })).toBe(expected);
  });
  it('labels a known contract end separately from a confirmed personal departure', () => {
    const [row] = parseResidenceSummaries([{ ...base, departure_date: null, last_contract_end: { contract_id: customer, date: '2026-06-27' } }], [customer]);
    expect(residenceSummaryLabel(row)).toBe('Kết thúc HĐ · 27/06/2026');
    expect(parseResidenceSummaries([{ ...base, last_contract_end: undefined }], [customer])[0].last_contract_end).toBeNull();
    expect(() => parseResidenceSummaries([{ ...base, last_contract_end: { contract_id: customer, date: '2026-06-27' } }], [customer])).toThrow();
  });
  it('preserves separately labelled contract dates and validates calendar dates in contract rooms', () => {
    const context = {
      contract_id: customer, contract_number: 'HD-2026-00387', status: 'ACTIVE',
      building_id: customer, room_id: customer, building_name: '1392QT', room_name: '203',
      signed_date: '2026-10-03', start_date: '2026-10-03', end_date: '2027-08-30', actual_end_date: null,
      room_segments: [{ room_id: customer, room_name: '203', building_name: '1392QT', from_date: '2026-10-03', to_date: null, source_path: 'CONTRACT', trusted: true, diagnostic: null }],
    };
    const page = { events: [], next_before_id: null, contract_contexts: [context] };
    expect(parseResidenceHistory(page, customer, customer).contract_contexts).toEqual([context]);
    expect(parseResidenceHistory({ events: [], next_before_id: null }, customer, customer).contract_contexts).toEqual([]);
    expect(() => parseResidenceHistory({ ...page, contract_contexts: [{ ...context, end_date: '2026-02-30' }] }, customer, customer)).toThrow();
    expect(() => parseResidenceHistory({ ...page, contract_contexts: [{ ...context, room_segments: [{ ...context.room_segments[0], from_date: 'infinity' }] }] }, customer, customer)).toThrow();
    expect(() => parseResidenceHistory({ ...page, contract_contexts: [context, context] }, customer, customer)).toThrow();
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
