import { describe, expect, it } from 'vitest';
import {
  PROFIT_FORM_MESSAGES, cancelFormSchema, isPastMarkerMonth, makeResolveFormSchema, markerFormSchema, markerMonthValue,
  payoutAllowAdvance, payoutFormSchema,
} from '../forms';

const payout = (over: Record<string, unknown> = {}) => ({
  shareholderId: 's1', amount: 1_000_000, accountId: 'a1', voucherDate: '2026-11-15', note: '', allowAdvance: false, previewAdvance: 0, ...over,
});
const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => `${i.path.join('.')}:${i.message}`);

describe('payoutFormSchema', () => {
  it('trong số dư: không cần tick, ghi chú tuỳ chọn', () => {
    expect(payoutFormSchema.safeParse(payout()).success).toBe(true);
  });
  it('có phần tạm ứng mà chưa tick ⇒ từ chối ở ô tick', () => {
    expect(issues(payoutFormSchema.safeParse(payout({ previewAdvance: 200_000 })))).toEqual([`allowAdvance:${PROFIT_FORM_MESSAGES.allowAdvance}`]);
  });
  it('tick tạm ứng mà lý do < 8 ký tự ⇒ từ chối', () => {
    expect(issues(payoutFormSchema.safeParse(payout({ previewAdvance: 200_000, allowAdvance: true, note: 'ngắn' })))).toEqual([`note:${PROFIT_FORM_MESSAGES.advanceReasonLength}`]);
  });
  it('lý do chép câu báo lỗi ⇒ từ chối', () => {
    expect(issues(payoutFormSchema.safeParse(payout({ previewAdvance: 1, allowAdvance: true, note: PROFIT_FORM_MESSAGES.advanceReasonLength }))))
      .toEqual([`note:${PROFIT_FORM_MESSAGES.advanceReasonSystem}`]);
  });
  it('tick + lý do đủ ⇒ đạt, gửi p_allow_advance = true', () => {
    const values = payout({ previewAdvance: 200_000, allowAdvance: true, note: 'Ứng trước lợi nhuận tháng 11 theo thoả thuận' });
    expect(payoutFormSchema.safeParse(values).success).toBe(true);
    expect(payoutAllowAdvance(values)).toBe(true);
  });
  it('không có phần tạm ứng thì không gửi cờ tạm ứng dù đã tick', () => {
    expect(payoutAllowAdvance({ allowAdvance: true, previewAdvance: 0 })).toBe(false);
    expect(payoutAllowAdvance({ allowAdvance: false, previewAdvance: 5 })).toBe(false);
  });
  it.each([0, -1, Number.NaN, 0.001, 1e13])('số tiền %s ⇒ từ chối', (amount) => {
    expect(payoutFormSchema.safeParse(payout({ amount })).success).toBe(false);
  });
  it('thiếu cổ đông / sổ / ngày ⇒ từ chối đúng ô', () => {
    expect(issues(payoutFormSchema.safeParse(payout({ shareholderId: '', accountId: '', voucherDate: '' })))).toEqual([
      `shareholderId:${PROFIT_FORM_MESSAGES.shareholder}`, `accountId:${PROFIT_FORM_MESSAGES.account}`, `voucherDate:${PROFIT_FORM_MESSAGES.voucherDate}`,
    ]);
  });
});

describe('cancelFormSchema', () => {
  it.each(['', 'ngắn', '       '])('lý do "%s" ⇒ từ chối', (reason) => {
    expect(issues(cancelFormSchema.safeParse({ reason }))).toEqual([`reason:${PROFIT_FORM_MESSAGES.cancelReasonLength}`]);
  });
  it('lý do chép câu báo lỗi của hệ thống ⇒ từ chối', () => {
    expect(issues(cancelFormSchema.safeParse({ reason: PROFIT_FORM_MESSAGES.cancelReasonLength }))).toEqual([`reason:${PROFIT_FORM_MESSAGES.cancelReasonSystem}`]);
    expect(issues(cancelFormSchema.safeParse({ reason: 'Phải ghi lý do huỷ từ 8 đến 1000 ký tự' }))).toEqual([`reason:${PROFIT_FORM_MESSAGES.cancelReasonSystem}`]);
  });
  it('lý do thật ⇒ đạt; > 1000 ⇒ từ chối', () => {
    expect(cancelFormSchema.safeParse({ reason: 'Lập nhầm sổ quỹ, lập lại phiếu khác' }).success).toBe(true);
    expect(cancelFormSchema.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('markerFormSchema', () => {
  const marker = (over: Record<string, unknown> = {}) => ({
    settledThroughMonth: '2026-09-01', reason: 'Đã trả đủ ngoài hệ thống tới hết tháng 9', acknowledgeAdvanceErase: false, previewAdvanceErased: 0, ...over,
  });
  it('tháng đã qua ⇒ đạt; gỡ mốc (null) ⇒ đạt', () => {
    expect(markerFormSchema.safeParse(marker()).success).toBe(true);
    expect(markerFormSchema.safeParse(marker({ settledThroughMonth: null })).success).toBe(true);
  });
  it('tháng hiện tại / tương lai / không phải ngày 1 ⇒ từ chối', () => {
    expect(isPastMarkerMonth('2026-11-01', '2026-11')).toBe(false);
    expect(isPastMarkerMonth('2027-01-01', '2026-11')).toBe(false);
    expect(isPastMarkerMonth('2026-10-15', '2026-11')).toBe(false);
    expect(isPastMarkerMonth('2026-10-01', '2026-11')).toBe(true);
    expect(markerFormSchema.safeParse(marker({ settledThroughMonth: '2999-01-01' })).success).toBe(false);
  });
  it('mốc xoá dấu tạm ứng mà chưa tick xác nhận ⇒ từ chối', () => {
    expect(issues(markerFormSchema.safeParse(marker({ previewAdvanceErased: 5000 })))).toEqual([`acknowledgeAdvanceErase:${PROFIT_FORM_MESSAGES.markerAcknowledge}`]);
    expect(markerFormSchema.safeParse(marker({ previewAdvanceErased: 5000, acknowledgeAdvanceErase: true })).success).toBe(true);
  });
  it('lý do ngắn / chép câu hệ thống ⇒ từ chối', () => {
    expect(markerFormSchema.safeParse(marker({ reason: 'ngắn' })).success).toBe(false);
    expect(issues(markerFormSchema.safeParse(marker({ reason: PROFIT_FORM_MESSAGES.markerReasonLength })))).toEqual([`reason:${PROFIT_FORM_MESSAGES.markerReasonSystem}`]);
  });
  it('markerMonthValue đổi YYYY-MM ⇒ YYYY-MM-01', () => {
    expect(markerMonthValue('2026-09')).toBe('2026-09-01');
  });
});

describe('makeResolveFormSchema', () => {
  const base = { investment: 7, offset: 0, reason: 'Phần đầu tư tháng 9 đúng bảng lương' };
  it('đạt; tháng lỗ cho Y âm', () => {
    expect(makeResolveFormSchema().safeParse(base).success).toBe(true);
    expect(makeResolveFormSchema().safeParse({ ...base, investment: -5 }).success).toBe(true);
  });
  it('D âm ⇒ từ chối; Y − D vượt tiền phiếu ⇒ từ chối khi biết tiền phiếu', () => {
    expect(makeResolveFormSchema().safeParse({ ...base, offset: -1 }).success).toBe(false);
    expect(issues(makeResolveFormSchema({ voucherAmount: 5 }).safeParse(base))).toEqual([`investment:${PROFIT_FORM_MESSAGES.resolveOverVoucher}`]);
    expect(makeResolveFormSchema({ voucherAmount: 5 }).safeParse({ ...base, offset: 2 }).success).toBe(true);
  });
});
