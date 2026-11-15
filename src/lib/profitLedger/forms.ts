// Luật biểu mẫu (Zod) của các hộp sổ tổng. Máy chủ vẫn là chốt cuối; ở đây chặn sớm để người
// dùng không phải đợi một vòng gửi mới biết sai.
//
// Câu báo cố ý khớp mẫu "câu hệ thống" của `reasonProblem` (profitClose.ts): người dùng dán lại chính
// câu báo vào ô lý do thì bị từ chối như mọi ô lý do khác của trang lợi nhuận.

import { z } from 'zod';
import { reasonProblem } from '@/lib/profitClose';
import { currentMonthVN } from '@/lib/collect';

export const PROFIT_REASON_MIN = 8;
export const PROFIT_REASON_MAX = 1000;
export const PROFIT_PAYOUT_NOTE_MAX = 500;
/** Trần số tiền của E4/E5 (numeric(15,2)). */
export const PROFIT_AMOUNT_LIMIT = 10_000_000_000_000;

export const PROFIT_FORM_MESSAGES = {
  shareholder: 'Chọn cổ đông nhận khoản chi.',
  amount: 'Nhập số tiền lớn hơn 0.',
  amountDecimals: 'Số tiền tối đa 2 chữ số lẻ.',
  amountTooLarge: 'Số tiền quá lớn.',
  account: 'Chọn sổ quỹ chi.',
  voucherDate: 'Chọn ngày chi.',
  noteTooLong: 'Ghi chú tối đa 500 ký tự.',
  allowAdvance: 'Số tiền vượt số còn phải trả — tick xác nhận tạm ứng.',
  advanceReasonLength: 'Lý do tạm ứng phải có 8-500 ký tự',
  advanceReasonSystem: 'Lý do tạm ứng đang chép câu báo lỗi của hệ thống — ghi lý do thật',
  cancelReasonLength: 'Lý do huỷ phải từ 8 đến 1000 ký tự',
  cancelReasonSystem: 'Lý do huỷ đang chép câu báo lỗi của hệ thống — ghi lý do thật',
  markerMonth: 'Chọn tháng đã qua (trước tháng hiện tại).',
  markerReasonLength: 'Lý do đặt mốc phải từ 8 đến 1000 ký tự',
  markerReasonSystem: 'Lý do đặt mốc đang chép câu báo lỗi của hệ thống — ghi lý do thật',
  markerAcknowledge: 'Mốc này xoá dấu phần tạm ứng — tick xác nhận riêng.',
  resolveInvestment: 'Nhập phần đầu tư hợp lệ (tối đa 2 chữ số lẻ).',
  resolveInvestmentRequired: 'Tự nhập phần đầu tư của phiếu này (không có thì nhập 0).',
  resolveInvestmentRange: 'Phần đầu tư nằm ngoài phần còn lại của tháng.',
  resolveOffset: 'Phần bù tạm ứng phải ≥ 0 (tối đa 2 chữ số lẻ).',
  resolveOffsetRequired: 'Tự nhập phần lương bù tạm ứng của phiếu này (không có thì nhập 0).',
  resolveOffsetOverMonth: 'Phần bù tạm ứng vượt phần còn trừ được của tháng.',
  resolveOverVoucher: 'Phần đầu tư trừ phần bù tạm ứng không được vượt tiền phiếu lương.',
  resolveReasonLength: 'Lý do xác nhận phải từ 8 đến 1000 ký tự',
  resolveReasonSystem: 'Lý do xác nhận đang chép câu báo lỗi của hệ thống — ghi lý do thật',
} as const;

const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

/** Số tiền nhập tay: hữu hạn, > 0, ≤ 2 số lẻ, dưới trần. */
const positiveMoney = z.number().superRefine((n, ctx) => {
  if (!Number.isFinite(n) || n <= 0) ctx.addIssue({ code: 'custom', message: PROFIT_FORM_MESSAGES.amount });
  else if (!twoDecimals(n)) ctx.addIssue({ code: 'custom', message: PROFIT_FORM_MESSAGES.amountDecimals });
  else if (n >= PROFIT_AMOUNT_LIMIT) ctx.addIssue({ code: 'custom', message: PROFIT_FORM_MESSAGES.amountTooLarge });
});

/* ───────────────────────────── Hộp Chi lợi nhuận (E5) ───────────────────────────── */

export const payoutFormSchema = z.object({
  shareholderId: z.string().min(1, PROFIT_FORM_MESSAGES.shareholder),
  amount: positiveMoney,
  accountId: z.string().min(1, PROFIT_FORM_MESSAGES.account),
  voucherDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, PROFIT_FORM_MESSAGES.voucherDate),
  note: z.string().max(PROFIT_PAYOUT_NOTE_MAX, PROFIT_FORM_MESSAGES.noteTooLong),
  /** Người dùng tick "tôi xác nhận tạm ứng". MẶC ĐỊNH false — không bao giờ tự bật. */
  allowAdvance: z.boolean(),
  /** Phần tạm ứng theo lần xem trước (E4) gần nhất — máy chủ tính, không phải ô nhập. */
  previewAdvance: z.number(),
}).superRefine((values, ctx) => {
  if (!(values.previewAdvance > 0)) return;
  if (!values.allowAdvance) {
    ctx.addIssue({ code: 'custom', path: ['allowAdvance'], message: PROFIT_FORM_MESSAGES.allowAdvance });
    return;
  }
  const problem = reasonProblem(values.note, PROFIT_REASON_MIN, PROFIT_PAYOUT_NOTE_MAX);
  if (problem) {
    ctx.addIssue({
      code: 'custom', path: ['note'],
      message: problem === 'SYSTEM_MESSAGE' ? PROFIT_FORM_MESSAGES.advanceReasonSystem : PROFIT_FORM_MESSAGES.advanceReasonLength,
    });
  }
});

export type PayoutFormValues = z.infer<typeof payoutFormSchema>;

/** `p_allow_advance` chỉ bật khi CÓ phần tạm ứng và người dùng đã tick — lần xem trước cũ hơn thì máy chủ hỏi lại. */
export function payoutAllowAdvance(values: Pick<PayoutFormValues, 'allowAdvance' | 'previewAdvance'>): boolean {
  return values.allowAdvance && values.previewAdvance > 0;
}

/* ───────────────────────────── Hộp huỷ phiếu (E6) ───────────────────────────── */

function reasonIssue(
  ctx: z.RefinementCtx,
  reason: string,
  messages: { length: string; system: string },
  max = PROFIT_REASON_MAX,
) {
  const problem = reasonProblem(reason, PROFIT_REASON_MIN, max);
  if (problem) ctx.addIssue({ code: 'custom', path: ['reason'], message: problem === 'SYSTEM_MESSAGE' ? messages.system : messages.length });
}

export const cancelFormSchema = z.object({ reason: z.string() }).superRefine((values, ctx) => {
  reasonIssue(ctx, values.reason, { length: PROFIT_FORM_MESSAGES.cancelReasonLength, system: PROFIT_FORM_MESSAGES.cancelReasonSystem });
});

export type CancelFormValues = z.infer<typeof cancelFormSchema>;

/* ───────────────────────────── Hộp mốc (E8/E9) ───────────────────────────── */

/** 'YYYY-MM' của ô chọn tháng → 'YYYY-MM-01' gửi máy chủ. */
export function markerMonthValue(yearMonth: string): string {
  return /^\d{4}-\d{2}$/.test(yearMonth) ? `${yearMonth}-01` : yearMonth;
}

/** Tháng mốc hợp lệ: ngày 1 của một tháng ĐÃ QUA theo giờ Việt Nam (tháng đang chạy bị từ chối). */
export function isPastMarkerMonth(value: string, currentYearMonth: string = currentMonthVN()): boolean {
  const m = /^(\d{4})-(\d{2})-01$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return false;
  return `${m[1]}-${m[2]}` < currentYearMonth;
}

export const markerFormSchema = z.object({
  /** null = gỡ mốc. */
  settledThroughMonth: z.string().nullable(),
  reason: z.string(),
  acknowledgeAdvanceErase: z.boolean(),
  /** advance_erased của lần xem trước (E8) gần nhất. */
  previewAdvanceErased: z.number(),
}).superRefine((values, ctx) => {
  if (values.settledThroughMonth !== null && !isPastMarkerMonth(values.settledThroughMonth)) {
    ctx.addIssue({ code: 'custom', path: ['settledThroughMonth'], message: PROFIT_FORM_MESSAGES.markerMonth });
  }
  reasonIssue(ctx, values.reason, { length: PROFIT_FORM_MESSAGES.markerReasonLength, system: PROFIT_FORM_MESSAGES.markerReasonSystem });
  if (values.previewAdvanceErased > 0 && !values.acknowledgeAdvanceErase) {
    ctx.addIssue({ code: 'custom', path: ['acknowledgeAdvanceErase'], message: PROFIT_FORM_MESSAGES.markerAcknowledge });
  }
});

export type MarkerFormValues = z.infer<typeof markerFormSchema>;

/* ───────────────────────────── Hộp xác nhận phần lương (E16) ───────────────────────────── */

/**
 * Trần cùng luật E16 (máy chủ vẫn là chốt cuối, lỗi PROFIT_LEDGER_SALARY_RESOLVE_RANGE trả lại trần):
 *   `voucherAmount`        tiền phiếu lương — Y − D không vượt;
 *   `maxOffset`            greatest(D_m − ΣD, 0) của tháng (E12 `remaining_offset`) — 0 ≤ D ≤ trần;
 *   `investmentRemaining`  R = Y_cap − ΣY (E12 `investment_cap − paid_investment`) — Y giữa 0 và R,
 *                          cùng dấu (tháng lỗ thì âm).
 * Ô trống (NaN — hộp KHÔNG để sẵn số) ⇒ bắt nhập: để sẵn 0 cho phần bù tạm ứng là trừ đủ Y thay vì
 * Y − D và dòng thành LINKED không sửa lại được.
 */
export function makeResolveFormSchema(context: {
  voucherAmount?: number | null;
  maxOffset?: number | null;
  investmentRemaining?: number | null;
} = {}) {
  return z.object({
    investment: z.number().or(z.nan()),
    offset: z.number().or(z.nan()),
    reason: z.string(),
  }).superRefine((values, ctx) => {
    if (Number.isNaN(values.investment)) {
      ctx.addIssue({ code: 'custom', path: ['investment'], message: PROFIT_FORM_MESSAGES.resolveInvestmentRequired });
    } else if (!Number.isFinite(values.investment) || !twoDecimals(values.investment)) {
      ctx.addIssue({ code: 'custom', path: ['investment'], message: PROFIT_FORM_MESSAGES.resolveInvestment });
    } else if (context.investmentRemaining != null) {
      const r = context.investmentRemaining;
      const low = Math.min(0, r) - 0.005;
      const high = Math.max(0, r) + 0.005;
      if (values.investment < low || values.investment > high) {
        ctx.addIssue({ code: 'custom', path: ['investment'], message: PROFIT_FORM_MESSAGES.resolveInvestmentRange });
      }
    }
    if (Number.isNaN(values.offset)) {
      ctx.addIssue({ code: 'custom', path: ['offset'], message: PROFIT_FORM_MESSAGES.resolveOffsetRequired });
    } else if (!Number.isFinite(values.offset) || values.offset < 0 || !twoDecimals(values.offset)) {
      ctx.addIssue({ code: 'custom', path: ['offset'], message: PROFIT_FORM_MESSAGES.resolveOffset });
    } else if (context.maxOffset != null && values.offset > Math.max(context.maxOffset, 0) + 0.005) {
      ctx.addIssue({ code: 'custom', path: ['offset'], message: PROFIT_FORM_MESSAGES.resolveOffsetOverMonth });
    }
    const voucherAmount = context.voucherAmount;
    if (voucherAmount != null && Number.isFinite(values.investment) && Number.isFinite(values.offset)
        && values.investment - values.offset > voucherAmount + 0.005) {
      ctx.addIssue({ code: 'custom', path: ['investment'], message: PROFIT_FORM_MESSAGES.resolveOverVoucher });
    }
    reasonIssue(ctx, values.reason, { length: PROFIT_FORM_MESSAGES.resolveReasonLength, system: PROFIT_FORM_MESSAGES.resolveReasonSystem });
  });
}

export type ResolveFormValues = z.infer<ReturnType<typeof makeResolveFormSchema>>;
