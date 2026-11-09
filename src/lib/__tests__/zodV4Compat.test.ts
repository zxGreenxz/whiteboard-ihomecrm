// Ghim hành vi các schema nghiệp vụ đã được rà khi nâng zod 3 → 4: dữ liệu thật phải
// parse y như cũ. Mỗi ca tương ứng một khác biệt v3/v4 đã xác minh bằng so sánh hai bản.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { incomeExpenseBatchFormSchema, incomeExpenseFormSchema, incomeExpenseTypeFormSchema } from '../incomeExpenseValidation';
import { buildIncomeExpensePostingSchema } from '../incomeExpensePostingValidation';
import { reservationRefundPaymentSchema, reservationSettlementFormSchema } from '../reservationSettlementForm';
import { supportCustomerScheduleSchema, supportPlanInputSchema } from '../rentSupport';
import { payoutContextSchema } from '../rentSupportFunding';
import { supportReadSchema } from '../rentSupportApi';
import { buildingLegalOwnerSchema, emptyBuildingLegalOwner } from '../buildingLegalOwner';

const NON_RFC_UUID = 'dddd0000-0000-0000-0000-000000000001';

const voucher = {
  type: 'INCOME' as const, name: 'Phiếu', building_id: 'b1', account_id: 'a1', voucher_date: '2026-01-01',
  items: [{ income_expense_type_id: 't1', quantity: 1, unit_price: 100, start_date: '2026-01-01', end_date: '2026-01-01' }],
};
const settlement = {
  depositAmount: 1000, refundAmount: 0, refundMode: 'NONE', settlementDate: '2026-01-01', reasonCode: 'NO_SHOW',
  reasonText: '', refundAccountId: null, refundAttachments: [],
};
const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : result.error?.issues[0]?.message;

describe('uuid dạng tự đặt (fixture dddd0000-…, id seed) vẫn được nhận', () => {
  it('sổ quỹ / biên nhận cọc giữ cách kiểm 8-4-4-4-12 cũ', () => {
    expect(reservationRefundPaymentSchema.safeParse({ accountId: NON_RFC_UUID, paidOn: '2026-01-01', refundAttachments: [] }).success).toBe(true);
    expect(reservationSettlementFormSchema.safeParse({ ...settlement, refundAmount: 100, refundMode: 'NOW', refundAccountId: NON_RFC_UUID }).success).toBe(true);
    expect(firstMessage(reservationRefundPaymentSchema.safeParse({ accountId: 'không-phải-uuid', paidOn: '2026-01-01', refundAttachments: [] }))).toBe('Chọn sổ quỹ đã chi');
  });

  it('phiếu chi hợp đồng/hoa hồng nhận id seed', () => {
    const intent = { intent_id: NON_RFC_UUID, kind: 'BONUS', party_id: NON_RFC_UUID, gross_amount: '1000', route: 'CASHBOOK', manager_id: null, account_id: NON_RFC_UUID, voucher_date: '2026-01-01' };
    const v2 = { version: 2, intents: [{ ...intent, source_id: NON_RFC_UUID, payer_name: null, recipient_name: null, recipient_bank: null, recipient_account: null, item_description: null, attachments: [], commission_reason: null }] };
    const parsed = payoutContextSchema.safeParse(v2);
    expect(firstMessage(parsed)).toBeNull();
  });
});

describe('phiếu Thu/Chi: thứ tự .default().optional() cũ', () => {
  it('thiếu key lặp lại ⇒ không tự điền default (zod 3 trả undefined)', () => {
    const parsed = incomeExpenseFormSchema.parse(voucher);
    expect(parsed.repeat_cycle).toBeUndefined();
    expect(parsed.repeat_infinity).toBeUndefined();
    expect(parsed.repeat_count).toBeUndefined();
    expect(parsed.repeat_auto_approve).toBeUndefined();
    expect('repeat_cycle' in parsed).toBe(false);
    // Hai field default KHÔNG optional thì vẫn tự điền như cũ.
    expect(parsed.attachments).toEqual([]);
    expect(parsed.business_result_accounting).toBeNull();
    expect(incomeExpenseBatchFormSchema.parse({ ...voucher, shared_name: 'Chung', items: [{ ...voucher.items[0], building_id: 'b1', quantity: undefined }] }).items[0].quantity).toBe(1);
  });

  it('giữ nguyên thông báo tiếng Việt của tham số lỗi cũ', () => {
    expect(firstMessage(incomeExpenseFormSchema.safeParse({ ...voucher, type: undefined }))).toBe('Vui lòng chọn loại phiếu');
    expect(firstMessage(incomeExpenseFormSchema.safeParse({ ...voucher, repeat_cycle: 'MONTH', repeat_count: 'abc' }))).toBe('Nhập số lần lặp là số nguyên từ 1 đến 240.');
    expect(firstMessage(incomeExpenseFormSchema.safeParse({ ...voucher, repeat_cycle: 'MONTH', repeat_count: 0 }))).toBe('Nhập số lần lặp là số nguyên từ 1 đến 240 hoặc bật "Lặp vô hạn".');
    expect(firstMessage(incomeExpenseTypeFormSchema.safeParse({ name: 'x', type: undefined, category: 'c' }))).toBe('Vui lòng chọn loại');
    expect(firstMessage(incomeExpenseTypeFormSchema.safeParse({ name: 'x', type: 'income', category: 5 }))).toBe('Vui lòng chọn nhóm Thu/Chi');
    expect(firstMessage(incomeExpenseTypeFormSchema.safeParse({ name: 'x', type: 'income', category: null }))).toBe('Vui lòng chọn nhóm Thu/Chi');
    const posting = buildIncomeExpensePostingSchema({ requireEvidence: false, allowAmount: true, remainingAmount: 100 });
    expect(firstMessage(posting.safeParse({ postedOn: undefined, cashbookId: NON_RFC_UUID, evidenceIds: [], amount: 1 }))).toBe('Vui lòng chọn ngày');
    expect(firstMessage(posting.safeParse({ postedOn: '2026-01-01', cashbookId: undefined, evidenceIds: [], amount: 1 }))).toBe('Vui lòng chọn sổ quỹ');
    expect(firstMessage(posting.safeParse({ postedOn: '2026-01-01', cashbookId: NON_RFC_UUID, evidenceIds: [], amount: undefined }))).toBe('Vui lòng nhập số tiền đợt chi');
    expect(firstMessage(posting.safeParse({ postedOn: '2026-01-01', cashbookId: NON_RFC_UUID, evidenceIds: [], amount: 'x' }))).toBe('Số tiền không hợp lệ');
  });
});

describe('Tiền hoàn giữ cọc: thứ tự thông báo số nguyên / giới hạn', () => {
  const message = (refundAmount: unknown) => firstMessage(reservationSettlementFormSchema.safeParse({ ...settlement, refundAmount }));
  it('không phải số ⇒ báo nhập số; số lẻ ⇒ báo số nguyên; số âm ⇒ báo âm', () => {
    expect(message('x')).toBe('Nhập số tiền hoàn hợp lệ');
    expect(message(1.5)).toBe('Tiền hoàn phải là số nguyên');
    expect(message(-5)).toBe('Tiền hoàn không được âm');
  });
  it('số quá lớn ⇒ báo vượt giới hạn, không báo “phải là số nguyên”', () => {
    expect(message(2 ** 60)).toBe('Số tiền hoàn vượt giới hạn cho phép');
    expect(message(-(2 ** 60))).toBe('Số tiền hoàn vượt giới hạn cho phép');
    expect(message(Number.MAX_SAFE_INTEGER)).toBe('Tiền hoàn vượt tiền cọc');
  });
});

describe('.pick/.extend trên schema đã refine', () => {
  it('lịch khách hàng vẫn lấy đúng trường, strict và rule vượt năm 9999', () => {
    const schedule = { version: 2, start_billing_month: '2026-01', segments: [{ month_count: 1, monthly_amount: '1000' }] };
    expect(supportCustomerScheduleSchema.safeParse(schedule).success).toBe(true);
    expect(supportCustomerScheduleSchema.safeParse({ ...schedule, payer: {} }).success).toBe(false);
    expect(firstMessage(supportCustomerScheduleSchema.safeParse({ ...schedule, start_billing_month: '9999-12', segments: [{ month_count: 2, monthly_amount: '1000' }] }))).toBe('Lịch hỗ trợ vượt năm 9999.');
    const plan = { ...schedule, payer: 'BUILDING', sale_party_id: NON_RFC_UUID, deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED' };
    expect(firstMessage(supportPlanInputSchema.safeParse(plan))).toBeNull();
    expect(firstMessage(supportPlanInputSchema.safeParse({ ...plan, start_billing_month: '9999-12', segments: [{ month_count: 2, monthly_amount: '1000' }] }))).toBe('Lịch hỗ trợ vượt năm 9999.');
    expect(supportPlanInputSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
  });
});

describe('key có thể vắng ở dữ liệu RPC', () => {
  it('z.unknown() vắng key vẫn parse được như zod 3', () => {
    const row = { contract_id: NON_RFC_UUID, kind: 'LEGACY', revision: null, customer_hash: null, schedule: null, months: [] };
    expect(firstMessage(supportReadSchema.safeParse({ total: 1, rows: [row] }))).toBeNull();
    expect(supportReadSchema.safeParse({ total: 1, rows: [{ ...row, legacy: { a: 1 } }] }).success).toBe(true);
  });
});

describe('schema form dùng chung', () => {
  it('năm sinh chủ nhà: chữ báo khi sai kiểu, bỏ trống rơi về Required', () => {
    expect(firstMessage(buildingLegalOwnerSchema.safeParse({ ...emptyBuildingLegalOwner, birth_year: 'abc' }))).toBe('Nhập năm sinh chủ sở hữu bằng số.');
    expect(firstMessage(buildingLegalOwnerSchema.safeParse({ ...emptyBuildingLegalOwner, birth_year: undefined }))).toBe('Required');
  });
});
