// Phiếu chi theo sổ tổng (nguồn `profit.ledger_payout`, `profit.manager_salary`) và đầu vào của
// hộp huỷ dùng chung (E6). Phiếu nguồn cũ (`profit.distribution`, `salary.manager`) KHÔNG thuộc
// nhóm này: chúng giữ luật huỷ / hoàn tác cũ.

import { formatVND } from '@/lib/utils';
import type { LedgerPayoutDetail, MyLedgerPayout, ShareholderLedgerEntry } from './ledgerReaders';
import type { ProfitLedgerSubjectKind } from './sharedReaders';

export const PROFIT_LEDGER_SOURCES = ['profit.ledger_payout', 'profit.manager_salary'] as const;
export type ProfitLedgerSource = (typeof PROFIT_LEDGER_SOURCES)[number];

/** Phiếu chỉ huỷ được bằng E6 (máy chủ F1/F2/F5 chặn sửa, huỷ duyệt, hoàn tác, khôi phục…). */
export function isProfitLedgerVoucher(systemSource: string | null | undefined): systemSource is ProfitLedgerSource {
  return systemSource === 'profit.ledger_payout' || systemSource === 'profit.manager_salary';
}

/** `p_expected_state` của E6 — trạng thái phiếu ĐANG HIỆN trên màn lúc bấm Huỷ. */
export type ProfitCancelExpectedState = 'PENDING' | 'APPROVED_UNPOSTED' | 'POSTED';

/**
 * Bảng của d1_chan_interface §6:
 *   UNAPPROVED (kể cả yêu cầu đã bị từ chối) → PENDING
 *   APPROVED + posting UNPOSTED / NOT_APPLICABLE / null → APPROVED_UNPOSTED
 *   APPROVED + POSTED → POSTED
 *   CANCELLED (hoặc trạng thái lạ) → null: ẩn nút Huỷ (đóng an toàn).
 */
export function expectedCancelState(
  approvalStatus: string | null | undefined,
  postingStatus: string | null | undefined,
): ProfitCancelExpectedState | null {
  if (approvalStatus === 'UNAPPROVED') return 'PENDING';
  if (approvalStatus !== 'APPROVED') return null;
  if (postingStatus === 'POSTED') return 'POSTED';
  if (postingStatus == null || postingStatus === 'UNPOSTED' || postingStatus === 'NOT_APPLICABLE') return 'APPROVED_UNPOSTED';
  // REVERSED và mọi trạng thái ghi sổ khác: không đoán — để người dùng tải lại.
  return null;
}

/** Câu mô tả việc huỷ sẽ làm, theo trạng thái phiếu đang thấy. */
export function cancelEffectSentence(state: ProfitCancelExpectedState, accountName: string | null): string {
  if (state === 'POSTED') return `Phiếu đã chi tiền: huỷ sẽ tạo bút toán đảo, tiền về sổ ${accountName ?? 'quỹ của phiếu'}.`;
  if (state === 'APPROVED_UNPOSTED') return 'Phiếu đã duyệt nhưng chưa chi tiền: huỷ phiếu, không có tiền di chuyển.';
  return 'Phiếu đang chờ duyệt: huỷ yêu cầu duyệt, chưa có tiền di chuyển.';
}

/** Câu số dư sau huỷ (E6.balance_after). */
export function cancelBalanceSentence(kind: ProfitLedgerSubjectKind, balanceAfter: number): string {
  if (kind === 'MANAGER') return `Lương điều hành còn lại: ${formatVND(balanceAfter)}.`;
  return balanceAfter >= 0
    ? `Sổ tổng còn phải trả: ${formatVND(balanceAfter)}.`
    : `Sổ tổng đang tạm ứng: ${formatVND(-balanceAfter)}.`;
}

/** Đầu vào của `ProfitPayoutCancelDialog`. Dựng bằng các hàm bên dưới, không tự ghép tay. */
export interface ProfitPayoutCancelTarget {
  voucherId: string;
  /** Công ty của phiếu — khoá chống gửi trùng gắn theo công ty này. */
  organizationId: string;
  kind: ProfitLedgerSubjectKind;
  code: string | null;
  /** Số tiền phiếu (DƯƠNG). */
  amount: number;
  approvalStatus: string;
  postingStatus: string | null;
  subjectName: string | null;
  accountName: string | null;
}

/**
 * Từ một dòng PAYOUT của sổ chi tiết (E2). Dòng khác, phiếu cũ (không lập qua sổ tổng — E2 chỉ có
 * `maker_user_id` khi phiếu có dòng sổ C2) hoặc phiếu không còn huỷ được ⇒ null.
 */
export function cancelTargetFromLedgerEntry(
  entry: ShareholderLedgerEntry,
  context: { organizationId: string; subjectName: string | null },
): ProfitPayoutCancelTarget | null {
  if (entry.kind !== 'PAYOUT' || !entry.voucher_id || !entry.voucher_status || !entry.maker_user_id) return null;
  if (!expectedCancelState(entry.voucher_status, entry.posting_status)) return null;
  return {
    voucherId: entry.voucher_id,
    organizationId: context.organizationId,
    kind: 'SHAREHOLDER',
    code: entry.voucher_code,
    amount: -entry.amount,
    approvalStatus: entry.voucher_status,
    postingStatus: entry.posting_status,
    subjectName: context.subjectName,
    accountName: entry.account_name,
  };
}

/** Từ một phiếu trong màn tự xem (E3) — chỉ phiếu của chính mình còn chờ duyệt mới tự huỷ được. */
export function cancelTargetFromMyPayout(
  payout: MyLedgerPayout,
  context: { organizationId: string; subjectName: string | null },
): ProfitPayoutCancelTarget | null {
  if (!payout.is_mine_pending || !payout.status) return null;
  if (expectedCancelState(payout.status, payout.posting_status) !== 'PENDING') return null;
  return {
    voucherId: payout.voucher_id,
    organizationId: context.organizationId,
    kind: 'SHAREHOLDER',
    code: payout.voucher_code,
    amount: payout.amount,
    approvalStatus: payout.status,
    postingStatus: payout.posting_status,
    subjectName: context.subjectName,
    accountName: null,
  };
}

/** Từ chi tiết phiếu (E7) — dùng cho Thu chi / Hộp duyệt khi chỉ có mã phiếu. */
export function cancelTargetFromDetail(detail: LedgerPayoutDetail): ProfitPayoutCancelTarget | null {
  if (!isProfitLedgerVoucher(detail.voucher.system_source)) return null;
  if (!expectedCancelState(detail.voucher.approval_status, detail.voucher.posting_status)) return null;
  return {
    voucherId: detail.voucher.id,
    organizationId: detail.organization_id,
    kind: detail.subject.kind,
    code: detail.voucher.code,
    amount: detail.voucher.amount,
    approvalStatus: detail.voucher.approval_status,
    postingStatus: detail.voucher.posting_status,
    subjectName: detail.subject.name,
    accountName: detail.voucher.account_name,
  };
}
