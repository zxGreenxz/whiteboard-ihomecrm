// Số tiền khách cũ hỗ trợ khách mới khi sang nhượng phòng (plan sang nhượng phòng, đợt 3, chủ duyệt 24/11/2026).
// Máy chủ: migration 20261124154554_so_ho_tro_sang_nhuong_chuyen_coc — create_contract_v2 nhận
// transfer_support_amount và ghi cặp phiếu chuyển cọc trên sổ nội bộ. Ở đây chỉ tính trần để báo trước cho người
// nhập; máy chủ kiểm lại đúng hai trần này.
import { isTransferReason, type ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';

type PendingRow = Pick<ContractExitEarlyTerms, 'pending_link' | 'early_reason' | 'created_at' | 'exit_case_id'>;

/** Hồ sơ còn chờ nối mà máy chủ sẽ nối trước: cũ nhất trước, cùng thứ tự trigger tự nối. */
export function pendingExitHold<T extends PendingRow>(rows: readonly T[] | null | undefined): T | undefined {
  return rows?.filter(row => row.pending_link && isTransferReason(row.early_reason))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.exit_case_id.localeCompare(b.exit_case_id))[0];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Máy chủ chỉ tự nối (và chỉ nhận số hỗ trợ) khi hợp đồng mới bắt đầu từ ngày khách cũ trả phòng trở đi. */
export function exitHoldLinksStart(terms: Pick<ContractExitEarlyTerms, 'actual_move_out_on'>, startDate: string | null | undefined): boolean {
  return !!startDate && ISO_DATE.test(startDate) && startDate >= terms.actual_move_out_on;
}

export interface ExitSupportCaps {
  /** Cọc cũ đã thu trừ phí môi giới (ca nhờ sale). */
  oldCap: number;
  /** Phần cọc còn thiếu của hợp đồng mới trước khi tính số hỗ trợ. */
  newCap: number;
  cap: number;
}
export function exitSupportCaps(
  terms: Pick<ContractExitEarlyTerms, 'early_reason' | 'broker_fee' | 'old_contract_deposit_paid'>,
  totalDeposit: number, paidBeforeSupport: number,
): ExitSupportCaps {
  const oldPaid = Math.max(Number(terms.old_contract_deposit_paid ?? 0) || 0, 0);
  const fee = terms.early_reason === 'SALE_ASSISTED' ? Math.max(Number(terms.broker_fee) || 0, 0) : 0;
  const oldCap = Math.max(oldPaid - fee, 0);
  const newCap = Math.max((Number(totalDeposit) || 0) - (Number(paidBeforeSupport) || 0), 0);
  return { oldCap, newCap, cap: Math.min(oldCap, newCap) };
}

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

/** Lý do số hỗ trợ bị từ chối (cùng hai trần máy chủ kiểm); null khi hợp lệ. */
export function exitSupportError(amount: number, caps: ExitSupportCaps): string | null {
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) !== amount * 100) {
    return 'Số tiền khách cũ hỗ trợ không hợp lệ.';
  }
  if (amount > caps.oldCap) return `Vượt cọc cũ đã thu sau khi trừ phí môi giới (tối đa ${vnd(caps.oldCap)} đ).`;
  if (amount > caps.newCap) {
    return `Vượt phần cọc còn thiếu của hợp đồng mới (tối đa ${vnd(caps.newCap)} đ). Giảm số hỗ trợ hoặc bớt số khách nhận nộp cọc.`;
  }
  return null;
}

/** Dòng ghi chú gửi kèm quyết toán khách cũ (vào ghi chú hoá đơn thanh lý / biên bản). */
export function exitSupportSettlementNote(
  terms: Pick<ContractExitEarlyTerms, 'support_amount' | 'new_contract_number'> & { support_out_code?: string | null; support_in_code?: string | null },
): string | null {
  if (!(terms.support_amount > 0)) return null;
  const codes = [terms.support_out_code, terms.support_in_code].filter(Boolean).join(' / ');
  return `Khách cũ hỗ trợ khách nhận phòng ${vnd(terms.support_amount)}đ: đã cấn sang cọc hợp đồng mới`
    + `${terms.new_contract_number ? ` ${terms.new_contract_number}` : ''}${codes ? ` (phiếu ${codes})` : ''}.`;
}
