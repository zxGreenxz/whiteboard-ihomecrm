import { expect, it } from 'vitest';
import { commissionItemDescription, commissionNeedsReason, commissionReasonSchema, defaultCommissionAmount } from '../commissionCreationPolicy';

it('uses one month of rent and the matched tier, with no multiplication by contract months', () => {
  const amount = defaultCommissionAmount(4_800_000, 65);
  expect(amount).toBe(3_120_000);
  expect(commissionNeedsReason(1_920_000, amount)).toBe(true);
  expect(commissionNeedsReason(3_120_000, amount)).toBe(false);
  expect(defaultCommissionAmount(4_800_000, null)).toBeNull();
  expect(commissionNeedsReason(1_920_000, null)).toBe(true);
  expect(commissionNeedsReason(0, null)).toBe(false);
});

it('describes the actual amount separately from the configured tier', () => {
  const description = commissionItemDescription({ amount: 1_920_000, rentPrice: 4_800_000, months: 10, ratePercent: 65 });
  expect(description).toContain('1.920.000');
  expect(description).toContain('40%');
  expect(description).toContain('cấu hình 65%');
  expect(description).toContain('HĐ 10 tháng');
  expect(description).not.toContain('×');
});

it('preserves a trimmed reason and rejects an empty or oversized supplied reason', () => {
  expect(commissionReasonSchema.parse('  Theo thỏa thuận đã ký  ')).toBe('Theo thỏa thuận đã ký');
  expect(commissionReasonSchema.parse(null)).toBeNull();
  expect(() => commissionReasonSchema.parse('ngắn')).toThrow();
  expect(() => commissionReasonSchema.parse('a'.repeat(2001))).toThrow();
});
