// BƯỚC SAU của hộp chốt chi lợi nhuận cổ đông / chi lương điều hành của CHỦ (chủ chốt 19/11/2026: "gộp vào 1 màn
// hình luôn Duyệt và Chi có ảnh phía dưới luôn như bình thường", "làm đúng luồng thu chi").
//
// Lệnh lập phiếu (W2 shareholder_profit_settle_v1 / E11 manager_salary_payout_v1) đã LƯU phiếu ở Chờ duyệt trong giao
// dịch riêng. Hook này làm tiếp cho ĐÚNG phiếu vừa lập, bằng đúng các lệnh của màn Chờ duyệt:
//   người bấm GIỮ sổ quỹ của phiếu ⇒ gắn ảnh chứng từ (useDeferredPostingEvidence) rồi approve_and_post_income_expense_v2
//     (useApproveAndPostIncomeExpenseV2 — cùng hook màn Chờ duyệt dùng cho "Duyệt và Chi…");
//   không giữ sổ ⇒ chỉ approve_income_expense_v2; người giữ sổ bấm Chi (kèm ảnh) ở Thu chi.
// "Giữ sổ" xác định như hộp Chi: sổ nằm trong list_cashbooks_for_expense_v2 của người bấm (useCustodianCashbooksV2).
// Trước khi duyệt: đọc lại phiếu như màn Chờ duyệt (đúng phiếu, đúng công ty, đúng sổ lúc lập, phiên bản để so-rồi-ghi).
// Máy chủ (chốt F1 nới 19/11) cho người có quyền chi tự duyệt phiếu chủ lập, duyệt / chi dù mình là người nhận; vẫn đòi
// phiếu đã lưu ở Chờ duyệt trước và chứng từ FINALIZED khi ghi sổ. Hook KHÔNG tự toast: hộp nói theo trạng thái thật.

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DeferredEvidenceError, useDeferredPostingEvidence, type DeferredPostingEvidence } from '@/hooks/income-expenses/deferredPostingEvidence';
import { withDetailReadDeadline } from '@/hooks/income-expenses/detailRead';
import {
  useApproveAndPostIncomeExpenseV2, useApproveIncomeExpenseV2, useCustodianCashbooksV2, useInvalidateMoney,
} from '@/hooks/income-expenses/financeV2Mutations';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { invalidateProfitLedgerQueries } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { loadIncomeExpenseDetails } from '@/lib/incomeExpenseDetailRpc';
import { canUse } from '@/lib/permissionCheck';
import { ledgerAwareVoucherFailure, profitLedgerMachineCode } from '@/lib/profitLedger/voucherFailure';
import { voucherOutcomeUnknown } from '@/lib/voucherFeedback';
import { payoutPostAllowedAsPayee } from '@/lib/voucherActionRules';

/** Bước sau của phiếu vừa lập — quyết lúc bấm theo sổ người bấm đang GIỮ và quyền của người bấm. */
export type OwnerPayoutStep = 'APPROVE_AND_POST' | 'APPROVE';

/** Khoá quyền chi của loại chủ thể: cổ đông ⇒ distribute, lương điều hành ⇒ pay_manager. */
export type OwnerPayoutRight = 'distribute' | 'pay_manager';

/**
 * Bước sau theo sổ đã chọn: undefined = chưa biết (đang tải / đọc lỗi danh sách sổ mình giữ); null = không duyệt được
 * (thiếu quyền duyệt thu chi ⇒ chỉ lập phiếu chờ duyệt như trước); giữ sổ + được chi kể cả khi là người nhận ⇒ Duyệt và
 * Chi; còn lại ⇒ chỉ Duyệt (người giữ sổ bấm Chi ở Thu chi).
 */
function ownerPayoutStepFor(input: {
  custodian: boolean | null;
  canApprove: boolean;
  postAllowedAsPayee: boolean;
}): OwnerPayoutStep | null | undefined {
  if (!input.canApprove) return null;
  if (input.custodian === null) return undefined;
  return input.custodian && input.postAllowedAsPayee ? 'APPROVE_AND_POST' : 'APPROVE';
}

export interface OwnerPayoutTarget {
  voucherId: string;
  /** Công ty của phiếu — khoá chống gửi trùng của lệnh duyệt gắn theo công ty này. */
  organizationId: string;
  /** Sổ quỹ đã chọn lúc lập (phiếu sổ tổng chỉ chi được từ sổ này). */
  accountId: string;
  /** Ngày chi đã chọn lúc lập = ngày tiền ra khỏi sổ ('YYYY-MM-DD'). */
  postedOn: string;
  step: OwnerPayoutStep;
}

/** POSTED: đã duyệt và chi · APPROVED: đã duyệt, chờ người giữ sổ bấm Chi. */
export type OwnerPayoutOutcome = 'POSTED' | 'APPROVED';

/**
 * Lỗi dừng có câu cho người dùng (đọc lại phiếu không khớp…); lỗi máy chủ đi nguyên văn để hộp dịch.
 * `retryable` false: làm tiếp ở hộp vẫn ra đúng lỗi này (phiếu đã huỷ, sổ trên phiếu khác sổ đã chọn).
 */
export class OwnerPayoutStateError extends Error {
  override readonly name = 'OwnerPayoutStateError';
  constructor(message: string, readonly retryable = true) { super(message); }
}

/**
 * Lỗi của bước sau và "Làm tiếp" còn ý nghĩa không:
 *   RETRY — làm lại được (phiên bản phiếu vừa đổi, máy chủ bận, thêm ảnh rồi làm tiếp…);
 *   APPROVE_ONLY — máy chủ chặn chính người nhận tự Chi (PROFIT_LEDGER_PAYEE_SELF_POST): làm tiếp chỉ Duyệt;
 *   BLOCKED — từ chối vì quyền (SQLSTATE 42501: không giữ sổ theo máy chủ, thiếu quyền duyệt thu chi ở toà của phiếu,
 *     PROFIT_LEDGER_MAKER_SELF_APPROVE khi máy chủ không thấy quyền chi…) hoặc phiếu không còn xử lý được ở hộp: gửi lại
 *     vẫn bị từ chối ⇒ khoá "Làm tiếp", chỉ đường sang Chờ duyệt / Thu chi (phiếu vẫn nằm ở Chờ duyệt);
 *   RECONCILE — chưa rõ kết quả: không làm tiếp ở hộp, đối chiếu phiếu ở Thu chi.
 */
export type OwnerPayoutFailureKind = 'RETRY' | 'APPROVE_ONLY' | 'BLOCKED' | 'RECONCILE';

export interface OwnerPayoutStepFailure {
  message: string;
  kind: OwnerPayoutFailureKind;
}

const codeOf = (error: unknown): string =>
  error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';

/** Từ chối chắc chắn vì quyền (42501), kể cả khi nằm trong `cause` của một lần từ chối chắc chắn. */
function isPermissionRejection(error: unknown): boolean {
  if (codeOf(error) === '42501') return true;
  return error instanceof FinancialWorkflowError && error.outcome === 'failure' && codeOf(error.cause) === '42501';
}

/** "Làm tiếp" còn ý nghĩa không: từ chối vì quyền / chưa rõ kết quả ⇒ khoá. */
export function ownerPayoutCanResume(failure: OwnerPayoutStepFailure | null): boolean {
  return !!failure && failure.kind !== 'BLOCKED' && failure.kind !== 'RECONCILE';
}

export function describeOwnerPayoutFailure(error: unknown, step: OwnerPayoutStep): OwnerPayoutStepFailure {
  if (error instanceof OwnerPayoutStateError) return { message: error.message, kind: error.retryable ? 'RETRY' : 'BLOCKED' };
  if (error instanceof DeferredEvidenceError) return { message: error.message, kind: 'RETRY' };
  const posted = step === 'APPROVE_AND_POST';
  const message = ledgerAwareVoucherFailure(error, posted ? 'duyệt và chi phiếu' : 'duyệt phiếu');
  if (voucherOutcomeUnknown(error)) return { message, kind: 'RECONCILE' };
  if (posted && profitLedgerMachineCode(error) === 'PROFIT_LEDGER_PAYEE_SELF_POST') return { message, kind: 'APPROVE_ONLY' };
  if (isPermissionRejection(error)) return { message, kind: 'BLOCKED' };
  return { message, kind: 'RETRY' };
}

export interface OwnerPayoutPosting {
  evidence: DeferredPostingEvidence;
  /** Bước sau nếu bấm với sổ này (ownerPayoutStepFor): undefined = chưa biết; null = chỉ lập phiếu chờ duyệt. */
  stepFor: (accountId: string | null | undefined) => OwnerPayoutStep | null | undefined;
  cashbooksError: boolean;
  retryCashbooks: () => void;
  complete: (target: OwnerPayoutTarget) => Promise<OwnerPayoutOutcome>;
  /** Đang gửi lệnh duyệt / duyệt và chi. */
  pending: boolean;
}

export function useOwnerPayoutPosting(open: boolean, right: OwnerPayoutRight): OwnerPayoutPosting {
  const queryClient = useQueryClient();
  const invalidateMoney = useInvalidateMoney();
  const evidence = useDeferredPostingEvidence(open);
  const cashbooks = useCustodianCashbooksV2(open);
  const { data: perms } = useMyPermissions();
  // Duyệt V2 đòi quyền duyệt thu chi ở toà của phiếu (toà ảo "Chung" — hộp không biết mã toà trước khi lập): hỏi
  // "có quyền duyệt ở đâu đó"; máy chủ là chốt cuối.
  const canApprove = canUse(perms, 'income_expenses', 'approve');
  const postAllowedAsPayee = payoutPostAllowedAsPayee(perms, right);
  const approveAndPost = useApproveAndPostIncomeExpenseV2({ scope: 'target', deferFeedback: true });
  const approve = useApproveIncomeExpenseV2({ scope: 'target', deferFeedback: true });
  const { mutateAsync: approveAndPostAsync } = approveAndPost;
  const { mutateAsync: approveAsync } = approve;
  const { commitTo } = evidence;

  const custodianIds = useMemo(
    () => (cashbooks.data ? new Set(cashbooks.data.map((book) => book.id)) : null),
    [cashbooks.data],
  );
  const permsReady = !!perms;
  const stepFor = useCallback((accountId: string | null | undefined): OwnerPayoutStep | null | undefined => {
    // Quyền chưa tải xong = chưa biết, không phải "không có quyền".
    if (!permsReady) return undefined;
    const custodian = !accountId || !custodianIds ? null : custodianIds.has(accountId);
    return ownerPayoutStepFor({ custodian, canApprove, postAllowedAsPayee });
  }, [permsReady, custodianIds, canApprove, postAllowedAsPayee]);

  const { refetch } = cashbooks;
  const retryCashbooks = useCallback(() => { void refetch(); }, [refetch]);

  const complete = useCallback(async (target: OwnerPayoutTarget): Promise<OwnerPayoutOutcome> => {
    try {
      const [detail] = await withDetailReadDeadline(loadIncomeExpenseDetails(target.organizationId, [target.voucherId]));
      if (!detail || detail.id !== target.voucherId || detail.organization_id !== target.organizationId) {
        throw new OwnerPayoutStateError('Chưa đọc lại được phiếu vừa lập — tải lại rồi duyệt ở Chờ duyệt hoặc Thu chi.');
      }
      if (detail.approval_status === 'CANCELLED') {
        throw new OwnerPayoutStateError('Phiếu vừa lập đã bị huỷ — không duyệt / chi được nữa.', false);
      }
      // Đã có người duyệt (hoặc lượt trước đã xong mà chưa nhận được kết quả): nói đúng trạng thái, không gửi lại.
      if (detail.approval_status === 'APPROVED') return detail.posting_status === 'POSTED' ? 'POSTED' : 'APPROVED';
      if (detail.account_id !== target.accountId) {
        throw new OwnerPayoutStateError('Sổ quỹ trên phiếu khác sổ đã chọn lúc lập — tải lại rồi xử lý phiếu ở Chờ duyệt.', false);
      }
      if (target.step === 'APPROVE_AND_POST') {
        const evidenceIds = await commitTo(target.voucherId, target.organizationId);
        if (evidenceIds.length === 0) {
          throw new OwnerPayoutStateError('Chưa có ảnh nào tính là chứng từ cho lần chi này — thêm ảnh rồi bấm "Làm tiếp".');
        }
        await approveAndPostAsync({
          subjectKind: 'VOUCHER',
          subjectId: target.voucherId,
          cashbookId: target.accountId,
          postedOn: target.postedOn,
          evidenceIds,
          expectedExecutionRevision: 0,
          expectedApprovalVersion: detail.approval_version,
          expectedPostingVersion: detail.posting_version,
          // Hook thay bằng khoá của lượt chống gửi trùng (persistentFinancialWorkflow).
          idempotencyKey: crypto.randomUUID(),
          organizationId: target.organizationId,
        });
        return 'POSTED';
      }
      await approveAsync({
        voucherId: target.voucherId,
        expectedApprovalVersion: detail.approval_version,
        organizationId: target.organizationId,
      });
      return 'APPROVED';
    } finally {
      // Duyệt / chi phiếu sổ tổng đổi số dư sổ tổng, sổ quỹ, Chờ duyệt: làm mới cả hai phía (kể cả khi hỏng giữa chừng).
      invalidateProfitLedgerQueries(queryClient);
      invalidateMoney();
    }
  }, [approveAndPostAsync, approveAsync, commitTo, invalidateMoney, queryClient]);

  return {
    evidence,
    stepFor,
    cashbooksError: cashbooks.isError,
    retryCashbooks,
    complete,
    pending: approveAndPost.isPending || approve.isPending || evidence.committing,
  };
}
