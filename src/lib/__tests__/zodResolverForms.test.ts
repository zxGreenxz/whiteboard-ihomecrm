// zodResolver v5 + zod 4 phải trả đúng cấu trúc RHF cho các form tiền/khách hàng:
// đường dẫn lỗi lồng, chữ báo tiếng Việt, và giá trị output đã áp default.
import { zodResolver } from '@hookform/resolvers/zod';
import { describe, expect, it } from 'vitest';
import { incomeExpenseBatchFormSchema, incomeExpenseFormSchema } from '../incomeExpenseValidation';
import { customerSchema } from '../customerValidation';
import { reservationSettlementFormSchema } from '../reservationSettlementForm';

type ResolverResult = { values: Record<string, unknown>; errors: Record<string, { message?: string; type?: string } & Record<string, unknown>> };
const run = (schema: unknown, values: unknown) =>
  (zodResolver as unknown as (s: unknown) => (v: unknown, c: undefined, o: { fields: object; shouldUseNativeValidation: boolean }) => Promise<ResolverResult>)(schema)(
    values, undefined, { fields: {}, shouldUseNativeValidation: false },
  );

const item = { income_expense_type_id: 't1', quantity: 1, unit_price: 100, start_date: '2026-01-01', end_date: '2026-01-01' };
const voucher = { type: 'INCOME', name: 'Phiếu', building_id: 'b1', account_id: 'a1', voucher_date: '2026-01-01', items: [item] };

describe('zodResolver v5 trên schema nghiệp vụ', () => {
  it('hợp lệ ⇒ trả output đã áp default, không có lỗi', async () => {
    const { values, errors } = await run(incomeExpenseFormSchema, voucher);
    expect(errors).toEqual({});
    expect(values).toMatchObject({ attachments: [], business_result_accounting: null, name: 'Phiếu' });
    expect(values).not.toHaveProperty('repeat_cycle');
  });

  it('lỗi lồng trong mảng ra đúng đường dẫn và đúng chữ tiếng Việt', async () => {
    const { errors } = await run(incomeExpenseBatchFormSchema, {
      type: 'INCOME', shared_name: '', account_id: 'a1', voucher_date: '2026-01-01',
      items: [{ ...item, building_id: 'b1', unit_price: -1 }],
    });
    expect(errors.shared_name?.message).toBe('Vui lòng nhập tên phiếu chung');
    const row = (errors.items as unknown as Array<{ unit_price?: { message?: string } }>)[0];
    expect(row?.unit_price?.message).toBe('Số tiền phải >= 0');
  });

  it('refine ở cấp mảng con gắn đúng ô ngày kết thúc', async () => {
    const { errors } = await run(incomeExpenseFormSchema, { ...voucher, items: [{ ...item, end_date: '2025-12-31' }] });
    const row = (errors.items as unknown as Array<{ end_date?: { message?: string } }>)[0];
    expect(row?.end_date?.message).toBe('Ngày bắt đầu không được sau ngày kết thúc');
  });

  it('union phân biệt: báo đúng ô của nhánh khớp và giữ chữ tiếng Việt', async () => {
    const { errors } = await run(customerSchema, { customer_type: 'INDIVIDUAL', full_name: '', phone: '12' });
    expect(errors.full_name?.message).toBe('Họ tên không được để trống');
    expect(errors.phone?.message).toBe('Số điện thoại phải có 10-11 chữ số');
  });

  it('superRefine của tiền hoàn cọc gắn đúng ô và giữ thứ tự thông báo', async () => {
    const base = { depositAmount: 1000, refundAmount: 1500, refundMode: 'NOW', settlementDate: '2026-01-01', reasonCode: 'OTHER', reasonText: ' ', refundAccountId: null, refundAttachments: [] };
    const { errors } = await run(reservationSettlementFormSchema, base);
    expect(errors.refundAmount?.message).toBe('Tiền hoàn vượt tiền cọc');
    expect(errors.refundAccountId?.message).toBe('Chọn sổ quỹ đã chi');
    expect(errors.reasonText?.message).toBe('Nhập lý do');
    const invalid = await run(reservationSettlementFormSchema, { ...base, refundAmount: Number.NaN });
    expect(invalid.errors.refundAmount?.message).toBe('Nhập số tiền hoàn hợp lệ');
  });
});
