import { expect, it } from 'vitest';
import { salePolicyIsActive, salePolicyTimeToIso } from '../saleRoomPolicyTypes';

it('P06 Vietnam input is timezone-independent and rejects impossible dates', () => {
  expect(salePolicyTimeToIso('2026-11-01T07:00')).toBe('2026-11-01T00:00:00.000Z');
  expect(() => salePolicyTimeToIso('2026-02-30T07:00')).toThrow();
  expect(() => salePolicyTimeToIso('2026-11-01')).toThrow();
});
it('P07 exact boundaries include the start and exclude the end, even offline', () => {
  const policy = {
    id: '10000000-0000-4000-8000-000000000090', version: 1, status: 'ACTIVE' as const,
    title: 'Ưu đãi tháng 11', content: 'Giảm giá',
    starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z',
  };
  const start = Date.parse(policy.starts_at), end = Date.parse(policy.ends_at);
  expect(salePolicyIsActive(policy, start - 1)).toBe(false);
  expect(salePolicyIsActive(policy, start)).toBe(true);
  expect(salePolicyIsActive(policy, end - 1)).toBe(true);
  expect(salePolicyIsActive(policy, end)).toBe(false);
  expect(salePolicyIsActive({ ...policy, status: 'CANCELLED' }, start)).toBe(false);
});
