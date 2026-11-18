// Chữ và số cho HAI CON SỐ của mỗi cổ đông — "Lợi nhuận chưa chi" và "Tạm ứng đang có" — dùng chung cho
// màn của chủ (R1), màn cổ đông tự xem (R2), hộp chốt (R5) và hộp tạm ứng (R4). Hàm thuần — component chỉ vẽ.
//
// Nghĩa (chủ dự án chốt 18/11/2026):
//   Lợi nhuận chưa chi  phần lợi nhuận đã chốt của cổ đông mà chủ CHƯA chốt chi. Có thể ÂM.
//   Tạm ứng đang có     phiếu tạm ứng ĐÃ duyệt, chưa được khấu trừ. Cộng dồn; chỉ giảm khi chủ chốt chi lợi nhuận
//                       (khấu trừ), khi phiếu bị huỷ, hoặc khi lương giữ lại để trừ.
//   Tạm ứng chờ duyệt   chưa tính vào "đang có", chưa được khấu trừ khi chốt.

import type { AdvanceBlockedReason, AdvanceOptions, ProfitSettlementRow, ShareholderPosition } from './positionReaders';
import { sameMoney } from './readPrimitives';
import { formatVND } from '@/lib/utils';

export const POSITION_LABELS = {
  unpaid: 'Lợi nhuận chưa chi',
  advance: 'Tạm ứng đang có',
} as const;

/** Một dòng giải thích khi "Lợi nhuận chưa chi" âm. */
export const UNPAID_NEGATIVE_NOTE =
  'Lợi nhuận chưa chi âm: đã chi nhiều hơn phần được chia hiện có (ví dụ một tháng đã chốt chi được mở chốt lại) — lần chốt chi sau tự trừ lại.';

/** Hai con số nghĩa là gì — một dòng, đặt dưới bảng / thẻ. */
export const POSITION_EXPLAIN =
  'Lợi nhuận chưa chi: phần được chia đã chốt mà chủ chưa chốt chi. Tạm ứng đang có: phiếu tạm ứng đã duyệt, được khấu trừ khi chủ chốt chi lợi nhuận.';

export const isUnpaidNegative = (position: Pick<ShareholderPosition, 'unpaid_profit'>): boolean =>
  position.unpaid_profit < 0 && !sameMoney(position.unpaid_profit, 0);

/** Dòng phụ dưới "Tạm ứng đang có": chỉ khi còn phiếu tạm ứng chờ duyệt. */
export function advancePendingText(position: Pick<ShareholderPosition, 'advance_pending'>, format: (n: number) => string = formatVND): string | null {
  return sameMoney(position.advance_pending, 0) ? null : `chờ duyệt ${format(position.advance_pending)}`;
}

/** Dòng phụ dưới "Lợi nhuận chưa chi": tiền của lần chốt mà phiếu chi còn chờ duyệt. */
export function settlementCashPendingText(position: Pick<ShareholderPosition, 'settlement_cash_pending'>, format: (n: number) => string = formatVND): string | null {
  return sameMoney(position.settlement_cash_pending, 0) ? null : `đang chờ chi ${format(position.settlement_cash_pending)}`;
}

export interface PositionSummary {
  /** Σ lợi nhuận chưa chi (có dấu). */
  unpaid: number;
  /** Σ tạm ứng đang có. */
  advance: number;
  /** Σ tạm ứng chờ duyệt. */
  advancePending: number;
  /** Σ tiền của các lần chốt còn chờ duyệt phiếu chi. */
  cashPending: number;
  /** Số cổ đông còn lợi nhuận chưa chi (> 0). */
  unpaidCount: number;
  /** Số cổ đông đang có tạm ứng (> 0). */
  advanceCount: number;
  /** Có cổ đông nào lợi nhuận chưa chi âm. */
  hasNegativeUnpaid: boolean;
}

export function summarizePositions(rows: readonly ShareholderPosition[]): PositionSummary {
  const sum: PositionSummary = {
    unpaid: 0, advance: 0, advancePending: 0, cashPending: 0, unpaidCount: 0, advanceCount: 0, hasNegativeUnpaid: false,
  };
  for (const row of rows) {
    sum.unpaid += row.unpaid_profit;
    sum.advance += row.advance_outstanding;
    sum.advancePending += row.advance_pending;
    sum.cashPending += row.settlement_cash_pending;
    if (row.unpaid_profit > 0 && !sameMoney(row.unpaid_profit, 0)) sum.unpaidCount += 1;
    if (!sameMoney(row.advance_outstanding, 0)) sum.advanceCount += 1;
    if (isUnpaidNegative(row)) sum.hasNegativeUnpaid = true;
  }
  return sum;
}

/** 'YYYY-MM-01' → 'MM/YYYY'; chuỗi lạ ⇒ chính nó (không đoán). */
export function settleMonthLabel(value: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(value);
  return m ? `${m[2]}/${m[1]}` : value;
}

/** Trạng thái phần tiền của một lần chốt, nói cho người dùng (không lộ mã trạng thái kỹ thuật). */
export function settlementCashLabel(row: Pick<ProfitSettlementRow, 'cash_voucher_id' | 'cash_voucher_status' | 'cash_voucher_posting_status'>): string {
  if (!row.cash_voucher_id) return 'Không ra tiền';
  if (row.cash_voucher_status === 'UNAPPROVED') return 'Phiếu chi chờ duyệt';
  if (row.cash_voucher_status !== 'APPROVED') return 'Phiếu chi đang xử lý';
  return row.cash_voucher_posting_status === 'POSTED' ? 'Đã chi tiền' : 'Đã duyệt, chưa chi tiền';
}

/** Lần chốt KHÔNG có phiếu tiền mới huỷ được bằng "Huỷ chốt"; có phiếu thì huỷ phiếu chi đó. */
export const settlementVoidable = (row: Pick<ProfitSettlementRow, 'cash_voucher_id'>): boolean => !row.cash_voucher_id;

/**
 * Cổ đông chưa có mốc "đã trả đủ" và chưa có lần chốt nào: lần chốt đầu sẽ gom TOÀN BỘ phân bổ từ đầu —
 * nhắc chủ đặt mốc trước nếu các tháng cũ đã trả ngoài app (chỉ nhắc, không chặn).
 */
export function shouldRemindMarkerFirst(input: { marker_month: string | null; settlements: readonly unknown[] }): boolean {
  return input.marker_month === null && input.settlements.length === 0;
}

/** Tên hạng mục "Tạm Ứng" để hiện ở form Thu chi; công ty chưa có dòng hạng mục thì dùng tên chuẩn (lệnh lập tự tạo). */
export function advanceTypeName(options: Pick<AdvanceOptions, 'advance_type'>): string {
  return options.advance_type?.name ?? 'Tạm Ứng';
}

/** Toà hạch toán của mọi phiếu tạm ứng / chi lợi nhuận: toà ảo của công ty (máy chủ tự gắn, form chỉ hiện). */
export const ADVANCE_BUILDING_NAME = 'Kho Văn Phòng Chung';

/**
 * Câu cho lý do máy chủ chưa cho lập phiếu tạm ứng (R4 `blocked_reason`); null = không bị chặn.
 * `self`: người nhận là chính người đang lập (tự tạm ứng) — câu nói theo ngôi "bạn".
 */
export function advanceBlockedMessage(reason: AdvanceBlockedReason | null, self: boolean): string | null {
  switch (reason) {
    case 'NOT_CUSTODIAN':
      return 'Chỉ lập phiếu tạm ứng từ sổ quỹ bạn đang giữ.';
    case 'PAYEE_NO_RIGHT':
      return self
        ? 'Bạn chưa được cấp quyền tạm ứng — liên hệ chủ công ty.'
        : 'Người nhận chưa được cấp quyền tạm ứng — nhờ chủ công ty cấp quyền rồi lập lại.';
    case 'SALARY_REVIEW_PENDING':
      return 'Cổ đông còn phiếu lương cần chủ xem lại phần lợi nhuận — chủ công ty xác nhận trước rồi mới tạm ứng được.';
    case 'ROUTE':
      return 'Sổ tổng lợi nhuận chưa bật ở công ty này — chưa lập phiếu tạm ứng được.';
    case 'OTHER':
      return 'Chưa lập được phiếu tạm ứng lúc này — tải lại rồi thử lại.';
    default:
      return null;
  }
}

/**
 * Ứng vượt lợi nhuận chưa chi bao nhiêu SAU phiếu này (0 = không vượt): tổng tạm ứng (đang có + chờ duyệt, gồm
 * phiếu đang lập) trừ lợi nhuận chưa chi. Chỉ để CẢNH BÁO — máy chủ không chặn, phiếu nào cũng chờ chủ duyệt.
 */
export function advanceOverUnpaid(position: Pick<ShareholderPosition, 'unpaid_profit' | 'advance_outstanding'>, advancePendingAfter: number): number {
  const over = position.advance_outstanding + advancePendingAfter - Math.max(position.unpaid_profit, 0);
  return over > 0 && !sameMoney(over, 0) ? over : 0;
}
