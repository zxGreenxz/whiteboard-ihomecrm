// =============================================================================
// useSettlementActions — ADAPTER hành động của khu "Hợp đồng & quyết toán".
//
// ⚠⚠ LÝ DO FILE NÀY TỒN TẠI — ĐỌC TRƯỚC KHI SỬA ⚠⚠
// Đợt làm trước của tính năng này đã lên production rồi BỊ GỠ, vì agent hôm đó
// sửa thẳng vào trang Thu chi. File này là cách làm ngược lại: khu mới có
// adapter RIÊNG, chỉ GỌI hook sẵn có của Thu chi, KHÔNG sửa một dòng nào của
// `IncomeExpensePage.tsx` / `IncomeExpenseList.tsx` / dialog / hook chung.
//
// Nguyên tắc: đọc cách Thu chi chọn tuyến rồi làm Y HỆT. Chỗ nào khu mới cần
// chặt hơn thì gác thêm ở đây, không sửa câu trả lời chung.
//
// ── BA CHỖ AUDIT BẮT ĐƯỢC, PHẢI LÀM ĐÚNG ────────────────────────────────────
// 1. Duyệt & Chi phải có guard `!isNonCashVoucher` — Thu chi có
//    (IncomeExpensePage.tsx:1123), bản kế hoạch đầu của khu mới thì thiếu.
// 2. Huỷ đi BA NHÁNH (income door / flex writer / thang cũ), không phải một.
//    Xem IncomeExpensePage.tsx:616.
// 3. Nút Chi gác bằng `isCanonicalRead` (nhận cả FROZEN), KHÔNG phải
//    `canWritePosting`, và KHÔNG xét thủ quỹ. Xem IncomeExpenseList.tsx:431.
// =============================================================================

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { PostFinanceExecutionInput } from '@/lib/incomeExpensePostingValidation';
import {
  useApproveIncomeExpenseV2, useApproveAndPostIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
} from '@/hooks/income-expenses/financeV2Mutations';
import { useApproveVoucher } from '@/hooks/income-expenses/statusMutations';
import {
  useCancelVoucherFlex, useFlexCancelEligibility, flexCancelGate,
} from '@/hooks/income-expenses/flexMutations';
import {
  useCancelIncomeVoucher, voucherCancelDecision,
} from '@/hooks/income-expenses/incomeVoucherCancel';
import { useCancelIncomeExpense } from '@/hooks/income-expenses/statusMutations';
import { useAppendIncomeExpenseSupplement } from '@/hooks/income-expenses/supplements';
import { reviseIncomeExpense, VOUCHER_QUERY_KEYS } from '@/hooks/income-expenses/revisions';
import { isStaleVersionError, revisionErrorMessage } from '@/lib/incomeExpenseRevision';
import {
  useFinanceV2Routes, isCanonicalRead, canWriteWorkflow, canWritePosting,
} from '@/lib/financeV2Route';
import { isNonCashVoucher } from '@/lib/financeV2VoucherState';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { DAU_CAN_BO_SUNG, DAU_DA_BO_SUNG, type SettlementRow } from '@/lib/contractSettlement';

/** Nút nào sáng trên MỘT dòng. Boolean thuần — tách hẳn khỏi lệnh. */
export interface SettlementAvailability {
  approve: boolean;
  approveAndPost: boolean;
  post: boolean;
  cancel: boolean;
  /** Lý do khoá nút Huỷ, để hiện nút disabled kèm giải thích như Thu chi. */
  cancelReason: string | null;
  editRecipient: boolean;
  requestSupplement: boolean;
  markSupplementDone: boolean;
}

const KHONG_CO_GI: SettlementAvailability = {
  approve: false, approveAndPost: false, post: false, cancel: false,
  cancelReason: null, editRecipient: false,
  requestSupplement: false, markSupplementDone: false,
};

const KEYS_LAM_MOI = [
  ['income-expenses'], ['income-expense-stats'], ['accounts-with-balance'],
  ['contract-settlement'], ['pending-approvals'],
  ['income-expense-supplements'],
] as const;

export function useSettlementActions(rows: SettlementRow[]) {
  const qc = useQueryClient();
  const { data: perms } = useMyPermissions();
  const v2Routes = useFinanceV2Routes();

  const approveV2 = useApproveIncomeExpenseV2();
  const approveLegacy = useApproveVoucher();
  const approveAndPostV2 = useApproveAndPostIncomeExpenseV2();
  const postV2 = usePostApprovedIncomeExpenseV2();
  const cancelFlex = useCancelVoucherFlex();
  const cancelIncome = useCancelIncomeVoucher();
  const cancelLegacy = useCancelIncomeExpense();
  const supplement = useAppendIncomeExpenseSupplement();
  const [dangSua, setDangSua] = useState(false);
  const canCancel = canUse(perms, 'income_expenses', 'cancel');

  // Cổng chặn server cho việc huỷ — ĐÚNG nguồn Thu chi dùng. Mảng id phải dựng
  // bằng useMemo: queryKey băm từ mảng đã sort, mảng mới mỗi render vẫn cùng key
  // nhưng effect của react-query thì chạy lại vô ích.
  const idsHuyDuoc = useMemo(
    () => canCancel ? rows.filter((r) => r.approvalStatus !== 'CANCELLED').map((r) => r.voucherId) : [],
    [rows, canCancel],
  );
  const { data: flexEligibility } = useFlexCancelEligibility(idsHuyDuoc);

  const permsLoaded = !!perms && !v2Routes.isLoading;
  const canApprove = canUse(perms, 'income_expenses', 'approve');
  const canEdit = canUse(perms, 'income_expenses', 'edit');

  const lamMoi = useCallback(async () => {
    await Promise.all(
      KEYS_LAM_MOI.map((key) => qc.invalidateQueries({ queryKey: [...key] })),
    );
  }, [qc]);

  /**
   * Bảng quyết định nút cho MỘT dòng.
   *
   * ⚠ Khu mới chỉ nhận phiếu EXPENSE nên `voucherCancelDecision` luôn rơi vào
   * nhánh chi; vẫn gọi qua helper chung để nếu sau này có phiếu THU lọt vào thì
   * nó tự đi đúng cửa, không phải sửa lại chỗ này.
   */
  const availabilityOf = useCallback((row: SettlementRow): SettlementAvailability => {
    // Chưa biết quyền/route thì KHÔNG đoán là có. Đoán sai theo hướng "cho bấm"
    // là mời người dùng ăn 42501 giữa chừng một thao tác tiền.
    if (!permsLoaded) return KHONG_CO_GI;
    if (row.approvalStatus === 'CANCELLED') return KHONG_CO_GI;

    const org = v2Routes.getOrg(row.organizationId);
    const canonicalRead = isCanonicalRead(org);
    const unapproved = row.approvalStatus === 'UNAPPROVED';
    const approved = row.approvalStatus === 'APPROVED';
    const posted = row.postingStatus === 'POSTED';
    const notApplicable = row.postingStatus === 'NOT_APPLICABLE';
    const sourceReady = row.validationState !== 'loading' && row.validationState !== 'error';

    const gate = voucherCancelDecision({
      type: 'EXPENSE',
      flexGate: flexCancelGate(flexEligibility?.[row.voucherId]),
    });

    // Guard NON_CASH: Thu chi có (IncomeExpensePage.tsx:1123). Phiếu ghi nhận
    // trên sổ ảo thì "Chi" không có nghĩa — không được mời bấm.
    const nonCash = isNonCashVoucher({
      posting_mode: row.postingMode,
      posting_status: row.postingStatus,
    } as never);

    return {
      // Nút Duyệt của Thu chi KHÔNG phụ thuộc route (IncomeExpenseList.tsx:416).
      approve: sourceReady && unapproved && canApprove,
      approveAndPost:
        sourceReady && unapproved && canApprove && !nonCash &&
        canWriteWorkflow(org) && canWritePosting(org),
      // Nút Chi gác bằng isCanonicalRead, KHÔNG xét thủ quỹ — hộp thoại Chi tự
      // lọc sổ, người không giữ sổ nào sẽ thấy danh sách rỗng.
      post: sourceReady && approved && !posted && !notApplicable && canonicalRead,
      cancel: canCancel && gate.canCancel,
      cancelReason: gate.canCancel ? null : gate.reason,
      // Trục tiền chỉ sửa được khi phiếu Chờ duyệt và chưa ghi sổ.
      editRecipient: unapproved && !posted && canEdit,
      requestSupplement: unapproved && canEdit && !row.supplementPending,
      markSupplementDone: unapproved && canEdit && row.supplementPending,
    };
  }, [permsLoaded, canApprove, canEdit, canCancel, v2Routes, flexEligibility]);

  // ── Lệnh ──────────────────────────────────────────────────────────────────

  const approve = useCallback(async (row: SettlementRow) => {
    if (!availabilityOf(row).approve) throw new Error('Chưa đủ điều kiện duyệt phiếu. Hãy tải lại dữ liệu đối chiếu.');
    const org = v2Routes.getOrg(row.organizationId);
    if (canWriteWorkflow(org)) {
      await approveV2.mutateAsync({
        voucherId: row.voucherId,
        expectedApprovalVersion: row.approvalVersion,
      });
    } else {
      // Org LEGACY: thang ba bậc của Thu chi (bỏ cọc → canonical → legacy), kèm
      // phiên bản đang xem — phiếu vừa bị sửa thì máy chủ trả 40001, không duyệt nhầm.
      await approveLegacy.mutateAsync({
        id: row.voucherId,
        expectedApprovalVersion: row.approvalVersion,
      });
    }
    await lamMoi();
  }, [v2Routes, approveV2, approveLegacy, lamMoi, availabilityOf]);

  const approveAndPost = useCallback(async (input: PostFinanceExecutionInput) => {
    const row = rows.find((r) => r.voucherId === input.subjectId);
    if (!row || !availabilityOf(row).approveAndPost) throw new Error('Chưa đủ điều kiện duyệt và chi phiếu. Hãy tải lại dữ liệu đối chiếu.');
    await approveAndPostV2.mutateAsync(input);
    await lamMoi();
  }, [approveAndPostV2, lamMoi, rows, availabilityOf]);

  const post = useCallback(async (input: PostFinanceExecutionInput) => {
    const row = rows.find((r) => r.voucherId === input.subjectId);
    if (!row || !availabilityOf(row).post) throw new Error('Chưa đủ điều kiện chi phiếu. Hãy tải lại dữ liệu đối chiếu.');
    await postV2.mutateAsync(input);
    await lamMoi();
  }, [postV2, lamMoi, rows, availabilityOf]);

  /** Huỷ đi ĐÚNG ba nhánh như IncomeExpensePage.tsx:616. */
  const cancel = useCallback(async (row: SettlementRow, reason: string) => {
    const gate = voucherCancelDecision({
      type: 'EXPENSE',
      flexGate: flexCancelGate(flexEligibility?.[row.voucherId]),
    });
    if (gate.useIncomeDoor) {
      await cancelIncome.mutateAsync({ voucherId: row.voucherId, reason });
    } else if (gate.useFlexWriter) {
      // Writer linh hoạt là đường DUY NHẤT truyền được CAS hai version. Đường cũ
      // luôn gửi null nên hai người bấm cùng lúc là huỷ đè lên nhau trong im lặng.
      await cancelFlex.mutateAsync({
        voucherId: row.voucherId,
        reason,
        expectedApprovalVersion: row.approvalVersion,
        expectedPostingVersion: row.postingVersion,
      });
    } else {
      await cancelLegacy.mutateAsync({ id: row.voucherId, reason });
    }
    await lamMoi();
  }, [flexEligibility, cancelIncome, cancelFlex, cancelLegacy, lamMoi]);

  /**
   * Sửa tên / ngân hàng / số tài khoản người nhận.
   *
   * Đi cửa sửa phiếu Chờ duyệt có lưu vết (revise_pending_income_expense_v1,
   * 25/09/2026). Patch THƯA: chỉ gửi khoá đã đổi, KHÔNG gửi hạng mục để máy chủ
   * giữ nguyên các dòng. Kèm phiên bản phiếu đang xem: người khác vừa sửa/duyệt
   * thì máy chủ trả 40001 thay vì ghi đè im lặng như kênh cũ.
   */
  const editRecipient = useCallback(async (a: {
    voucherId: string;
    payerName?: string | null;
    bankName?: string | null;
    bankAccount?: string | null;
  }) => {
    // Chỉ ba khoá người nhận; khoá nào không truyền thì không gửi (máy chủ giữ nguyên).
    const patch: Record<string, string | null> = {};
    if (a.payerName !== undefined) patch.payer_name = a.payerName;
    if (a.bankName !== undefined) patch.receive_bank_name = a.bankName;
    if (a.bankAccount !== undefined) patch.receive_bank_account = a.bankAccount;
    if (Object.keys(patch).length === 0) return;
    const row = rows.find((r) => r.voucherId === a.voucherId);
    if (!row) throw new Error('Không tìm thấy phiếu. Hãy tải lại dữ liệu đối chiếu.');

    setDangSua(true);
    try {
      await reviseIncomeExpense({
        voucherId: a.voucherId,
        expectedApprovalVersion: row.approvalVersion,
        patch,
      });
      toast.success('Đã cập nhật thông tin người nhận');
      await lamMoi();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      toast.error(
        code === '42501'
          ? 'Bạn không có quyền sửa thông tin người nhận của phiếu này.'
          : revisionErrorMessage(error),
      );
      if (isStaleVersionError(error)) {
        await Promise.all(VOUCHER_QUERY_KEYS.map((key) => qc.invalidateQueries({ queryKey: [...key] })));
        await lamMoi();
      }
      throw error;
    } finally {
      setDangSua(false);
    }
  }, [rows, lamMoi, qc]);

  /**
   * Ghi chú bổ sung — cơ chế chuyển làn của RIÊNG khu này.
   *
   * ⚠ GIỚI HẠN PHẢI NÓI THẬT: RPC gác bằng quyền ĐỌC phiếu, không phải
   * `income_expenses.edit`. Người tạo phiếu, thủ quỹ giữ sổ, chủ tổ chức đều ghi
   * được dấu. Giao diện gác thêm ở client cho gọn luồng, nhưng KHÔNG được mô tả
   * đây là bước có server bảo vệ theo quyền sửa. Giá trị thật của nó là DẤU VẾT
   * CÓ ĐỊNH DANH: mỗi dòng lưu actor_name + created_at bất biến.
   */
  const ghiChu = useCallback(async (a: {
    voucherId: string; noiDung: string; dau: string; idempotencyKey: string;
  }) => {
    const noiDung = a.noiDung.trim();
    if (!noiDung) {
      toast.error('Cần nhập lý do.');
      return;
    }
    const full = `${a.dau} ${noiDung}`;
    // Giới hạn 5.000 ký tự của RPC tính CẢ tiền tố.
    if (full.length > 5000) {
      toast.error('Nội dung quá dài (tối đa 5.000 ký tự, đã gồm nhãn).');
      return;
    }
    await supplement.mutateAsync({
      voucherId: a.voucherId,
      note: full,
      attachments: [],
      idempotencyKey: a.idempotencyKey,
    });
    await lamMoi();
  }, [supplement, lamMoi]);

  const requestSupplement = useCallback(
    (a: { voucherId: string; noiDung: string; idempotencyKey: string }) =>
      ghiChu({ ...a, dau: DAU_CAN_BO_SUNG }),
    [ghiChu],
  );

  const markSupplementDone = useCallback(
    (a: { voucherId: string; noiDung: string; idempotencyKey: string }) =>
      ghiChu({ ...a, dau: DAU_DA_BO_SUNG }),
    [ghiChu],
  );

  const isBusy =
    approveV2.isPending || approveLegacy.isPending || approveAndPostV2.isPending ||
    postV2.isPending || cancelFlex.isPending || cancelIncome.isPending ||
    cancelLegacy.isPending || supplement.isPending || dangSua;

  return useMemo(() => ({
    availabilityOf,
    approve, approveAndPost, post, cancel,
    editRecipient, requestSupplement, markSupplementDone,
    isBusy, permsLoaded,
  }), [
    availabilityOf, approve, approveAndPost, post, cancel,
    editRecipient, requestSupplement, markSupplementDone, isBusy, permsLoaded,
  ]);
}
