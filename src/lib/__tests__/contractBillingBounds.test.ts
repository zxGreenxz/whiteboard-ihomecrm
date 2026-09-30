import { describe, expect, it } from 'vitest';
import { contractFormSchema } from '../contractValidation';
import { contractCreateFeedback } from '../contractFeedback';

const base = {
  room_id: '11111111-1111-4111-8111-111111111111',
  signed_date: '2026-09-01', start_date: '2026-09-01', end_date: '2027-08-31',
  rent_price: 4_000_000, total_deposit: 4_000_000, payment_cycle: 'MONTHLY',
  start_billing_date: '2026-09-01', end_billing_date: '2026-09-30',
};

describe('contract first billing period bounds', () => {
  it('points to start billing date when it precedes the contract', () => {
    const result = contractFormSchema.safeParse({ ...base, start_billing_date: '2026-08-31' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
      path: ['start_billing_date'], message: 'Ngày bắt đầu tính tiền không được trước 01/09/2026 (ngày bắt đầu hợp đồng).',
    }));
  });

  it('points to end billing date when it exceeds the contract', () => {
    const result = contractFormSchema.safeParse({ ...base, end_billing_date: '2027-09-01' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
      path: ['end_billing_date'], message: 'Ngày kết thúc tính tiền không được sau 31/08/2027 (ngày kết thúc hợp đồng).',
    }));
  });

  it('accepts equal contract and billing bounds', () => {
    expect(contractFormSchema.safeParse({ ...base, end_billing_date: base.end_date }).success).toBe(true);
  });

  it('uses the same verified bounds for the exact server reason', () => {
    const feedback = contractCreateFeedback({ code: 'P0001', message: 'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng' }, base);
    expect(feedback.fieldErrors).toEqual({
      start_billing_date: 'Ngày bắt đầu tính tiền không được trước 01/09/2026 (ngày bắt đầu hợp đồng).',
      end_billing_date: 'Ngày kết thúc tính tiền không được sau 31/08/2027 (ngày kết thúc hợp đồng).',
    });
  });
});
