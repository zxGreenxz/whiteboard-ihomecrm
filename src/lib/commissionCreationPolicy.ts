import { z } from 'zod';
import { formatVND } from '@/lib/utils';

export const COMMISSION_REASON_MIN = 8;
export const COMMISSION_REASON_MAX = 2000;
export const commissionReasonSchema = z.string().trim().min(COMMISSION_REASON_MIN).max(COMMISSION_REASON_MAX).nullable().optional();

export function defaultCommissionAmount(rentPrice: number, ratePercent: number | null | undefined): number | null {
  if (ratePercent == null || !Number.isFinite(ratePercent) || ratePercent < 0 || !Number.isFinite(rentPrice) || rentPrice < 0) return null;
  return Math.round(rentPrice * ratePercent / 100);
}

/** Compare the agreed gross, never the net after configured support deductions. */
export function commissionNeedsReason(amount: number, defaultAmount: number | null): boolean {
  return amount > 0 && (defaultAmount === null || Math.round(amount * 100) !== Math.round(defaultAmount * 100));
}

export function commissionReasonValid(reason: string): boolean {
  const length = reason.trim().length;
  return length >= COMMISSION_REASON_MIN && length <= COMMISSION_REASON_MAX;
}

export function commissionItemDescription(input: {
  amount: number; rentPrice: number; months: number; ratePercent: number | null | undefined; gross?: boolean;
}): string {
  const actualRate = input.rentPrice > 0 ? `${Number((input.amount / input.rentPrice * 100).toFixed(1)).toLocaleString('vi-VN')}% giá thuê` : 'chưa xác định tỷ lệ';
  const configured = input.ratePercent == null ? 'chưa có bậc cấu hình' : `cấu hình ${input.ratePercent.toLocaleString('vi-VN')}% giá thuê`;
  return `${input.gross ? 'Quyền lợi hoa hồng MG' : 'Hoa hồng MG'} ${formatVND(input.amount)} (${actualRate}); ${configured}, HĐ ${input.months} tháng`;
}
