// MỘT bộ xử lý thao tác trên một phiếu thu chi: Duyệt / Duyệt và Thu-Chi / Thu-Chi phiếu đã
// duyệt / Hoàn tác ghi sổ / Huỷ duyệt / Huỷ / Khôi phục / Bản sao / Sửa / Bổ sung / Đánh dấu đã
// kiểm / Lịch sử / Dừng lặp / Huỷ cả đợt. Hộp xác nhận đi kèm: VoucherActionDialogs.
//
// Dời nguyên từ IncomeExpensePage (28/10/2026). Trước đó trang Thu chi máy tính và trang điện
// thoại mỗi trang tự chép một bản và đã lệch nhau (điện thoại thiếu hàng rào chi cổ đông, thiếu
// Huỷ duyệt…). Chủ chốt: "đừng để phân mảnh mất sự thống nhất" — mọi màn mở phiếu (Thu chi hai
// khổ, Báo cáo lợi nhuận) dùng đúng bộ này; sửa luồng nào thì sửa Ở ĐÂY.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isCommissionVoucher } from "@/lib/commissionIntervention";
import { isCommissionReasonValid } from "@/lib/commissionAudit";
import { useIncomeExpenseRevisions, useReviseIncomeExpense } from "@/hooks/income-expenses/revisions";
import { checkSelfApproveBeforeApprove, useSelfApproveGate } from "@/hooks/income-expenses/selfApproveGate";
import { focusFirstError } from "@/lib/formErrors";
import { voucherFailureMessage, voucherOutcomeUnknown, VoucherPartialError } from "@/lib/voucherFeedback";
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import {
  useCancelIncomeExpense,
  useRestoreIncomeExpense,
  useApproveVoucher,
  useUnapproveVoucher,
  useStopRecurring,
  useCancelIncomeExpenseBatch,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import { accountChangeNeedsReason, approvalEditPatch, REVISION_REASON_MIN } from "@/lib/incomeExpenseRevision";
// Finance V2 (route-aware §9.6/§12): duyệt-only / duyệt+ghi sổ atomic khi org CANONICAL.
import { useFinanceV2Routes, canWriteWorkflow, canWritePosting } from "@/lib/financeV2Route";
import {
  useApproveIncomeExpenseV2,
  useApproveAndPostIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
  useReversePostingV2,
  useCustodianCashbooksV2,
  useAttachPostingEvidence,
  useRemovePostingAttachment,
} from "@/hooks/income-expenses/financeV2Mutations";
// Đợt 4: hỏi-trước can_flex_cancel_v1 + writer huỷ-một-nhát có CAS hai version.
import { useFlexCancelEligibility, useCancelVoucherFlex, flexCancelGate } from "@/hooks/income-expenses/flexMutations";
// ĐỢT A: phiếu THU đi cửa riêng cancel_income_voucher_v1 (huỷ ở đâu cũng được, tự liên kết
// hoá đơn). Phiếu CHI giữ nguyên thang cũ — hai đường tách hẳn.
import {
  useIncomeCancelEligibility,
  useCancelIncomeVoucher,
  voucherCancelDecision,
} from "@/hooks/income-expenses/incomeVoucherCancel";

export interface VoucherActionsOptions {
  /**
   * Phiếu đang hiện ở màn gọi (trang danh sách Thu chi, hoặc đúng một phiếu ở Báo cáo).
   * Dùng để tra loại / phiên bản khi thao tác chỉ có id (huỷ, khôi phục, huỷ duyệt) và để
   * hỏi máy chủ TRƯỚC phiếu nào huỷ được.
   */
  vouchers: readonly IncomeExpenseWithRelations[];
  /**
   * Gọi sau mỗi thao tác đã ghi (hoặc có thể đã ghi: đóng form sửa / bản sao / bổ sung /
   * đánh dấu đã kiểm). Hook ghi của Thu chi đã tự làm mới khoá `income-expenses`; màn khác
   * dùng chỗ này để làm mới số riêng của nó.
   */
  onChanged?: () => void;
}

/**
 * Hỏi máy chủ TRƯỚC phiếu nào huỷ được — MỘT chỗ cho trang Thu chi và hộp phiếu con của Phiếu
 * tổng (phiếu con không nằm trong trang danh sách nên trang không hỏi hộ được; thiếu câu trả lời
 * thì nút Huỷ rơi về luật quyền chung và ẩn với người lập phiếu không có quyền huỷ).
 */
export function useVoucherCancelEligibility(vouchers: readonly IncomeExpenseWithRelations[]) {
  // Đợt 4 — can_flex_cancel_v1. Danh sách id phải dựng bằng useMemo: queryKey băm từ mảng đã
  // sort, mảng mới mỗi render vẫn cùng key nhưng effect của react-query thì chạy lại vô ích.
  const flexCancelIds = useMemo(
    () => vouchers.filter((v) => v.approval_status !== "CANCELLED").map((v) => v.id),
    [vouchers],
  );
  const { data: cancelEligibility } = useFlexCancelEligibility(flexCancelIds);

  // ĐỢT A: phiếu THU hỏi reader riêng (can_cancel_income_voucher_v1) — nó biết cả thứ tự LIFO
  // của đợt thu lẫn tiền thừa đã cấn đi đâu, những thứ reader của phiếu chi không có khái niệm.
  const incomeCancelIds = useMemo(
    () => vouchers.filter((v) => v.type === "INCOME" && v.approval_status !== "CANCELLED").map((v) => v.id),
    [vouchers],
  );
  const { data: incomeCancelEligibility } = useIncomeCancelEligibility(incomeCancelIds);
  return { cancelEligibility, incomeCancelEligibility };
}

export function useVoucherActions({ vouchers, onChanged }: VoucherActionsOptions) {
  const queryClient = useQueryClient();
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  const changed = useCallback(() => { onChangedRef.current?.(); }, []);

  const [editingVoucher, setEditingVoucher] = useState<IncomeExpenseWithRelations | null>(null);
  // Tạo bản sao từ phiếu đã huỷ: mở form TẠO MỚI prefill toàn bộ (kể cả ảnh).
  const [copyVoucher, setCopyVoucher] = useState<IncomeExpenseWithRelations | null>(null);
  const [quickEditVoucher, setQuickEditVoucher] = useState<IncomeExpenseWithRelations | null>(null);
  const [verifyVoucher, setVerifyVoucher] = useState<IncomeExpenseWithRelations | null>(null);
  // Đợt 4: màn đọc lại mốc lập/duyệt/huỷ + nhật ký thay đổi trước/sau.
  const [historyVoucher, setHistoryVoucher] = useState<IncomeExpenseWithRelations | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  // Loại phiếu đang huỷ, nhớ riêng vì phiếu mở từ CHI TIẾT ĐỢT (phiếu tổng) hầu như không nằm
  // trong trang danh sách lẻ hiện tại: tra ngược trong `vouchers` sẽ ra null ⇒ type=undefined
  // ⇒ rơi ngược về thang huỷ CŨ.
  const [cancelTargetType, setCancelTargetType] = useState<string | null>(null);
  // Huỷ phiếu ĐÃ CHI: cảnh báo hoàn-tác-tiền + lý do (ghi vào reversal).
  const [cancelReason, setCancelReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockedVoucherId, setBlockedVoucherId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<IncomeExpenseWithRelations | null>(null);
  const approveHistoryQuery = useIncomeExpenseRevisions(approveTarget?.id);
  const approveHistoryBlocked = !!approveTarget && (approveHistoryQuery.isError || approveHistoryQuery.isLoading || approveHistoryQuery.data === undefined);
  // Câu 25: hộp xác nhận là MỘT chỗ cho mọi nơi bấm Duyệt (dòng danh sách, hộp chi tiết, hộp đợt).
  const approveSelfGate = useSelfApproveGate(approveTarget?.id, !!approveTarget);
  // Đang hỏi lại cổng ngay trước khi lưu/duyệt ⇒ khoá các nút của hộp, không bấm hai lần lúc chờ.
  const [selfApproveChecking, setSelfApproveChecking] = useState(false);
  // Duyệt phiếu: cho bổ sung/đổi sổ quỹ + đính kèm ngay trước khi ghi vào tồn quỹ.
  const [approveAccountId, setApproveAccountId] = useState<string>("");
  const [approveAttachments, setApproveAttachments] = useState<string[]>([]);
  // Đổi từ sổ này sang sổ khác ngay trước khi duyệt = một lần sửa phiếu ⇒ cần lý do.
  const [approveReason, setApproveReason] = useState("");
  const [unapproveTarget, setUnapproveTarget] = useState<string | null>(null);
  // V2: mở Posting dialog "Duyệt và Chi/Thu" (chỉ khi route CANONICAL).
  const [approveAndPostOpen, setApproveAndPostOpen] = useState(false);
  // V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT-CHƯA GHI SỔ (CUSTODIAN, không cần quyền duyệt).
  const [postApprovedTarget, setPostApprovedTarget] = useState<IncomeExpenseWithRelations | null>(null);
  // Mô hình 2 nút: HOÀN TÁC phiếu đã ghi sổ (kèm lý do).
  const [reverseTarget, setReverseTarget] = useState<IncomeExpenseWithRelations | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [batchCancelReason, setBatchCancelReason] = useState("");
  useEffect(() => { setLifecycleReason(""); setActionError(null); }, [restoreTarget]);
  useEffect(() => { setBatchCancelReason(""); setActionError(null); }, [cancelBatchTarget]);

  const cancelMutation = useCancelIncomeExpense();
  const flexCancelMutation = useCancelVoucherFlex();
  const cancelIncomeMutation = useCancelIncomeVoucher();
  const restoreMutation = useRestoreIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
  const approveMutation = useApproveVoucher();
  const unapproveMutation = useUnapproveVoucher();
  const reviseMutation = useReviseIncomeExpense();
  const stopRecurringMutation = useStopRecurring();

  // Mảng rỗng CỐ ĐỊNH khi sổ quỹ chưa về: `= []` mới mỗi lần render làm effect nạp hộp Duyệt chạy lại
  // liên tục, xoá cả lý do người dùng đang gõ (review độc lập 28/10/2026).
  const { data: accountsData } = useAccounts();
  const accounts = useMemo(() => accountsData ?? [], [accountsData]);
  const { data: authUser } = useAuth();
  // Dán ảnh trong hộp thoại Thu/Chi = đính ảnh lên phiếu rồi nhận nó làm chứng từ — nhờ vậy ảnh
  // hiện luôn ở dòng thu chi (chủ báo 27/08/2026).
  const attachPostingEvidence = useAttachPostingEvidence();
  const removePostingAttachment = useRemovePostingAttachment();

  // Finance V2 route-aware (§9.6): org CANONICAL → duyệt-only không đổi tồn quỹ, "Duyệt và
  // Chi/Thu" đi qua Posting dialog atomic. Mặc định LEGACY giữ flow cũ.
  const v2Routes = useFinanceV2Routes();
  const approveOrgRoutes = v2Routes.getOrg(
    (approveTarget as { organization_id?: string } | null)?.organization_id ?? null,
  );
  const v2ApproveOnly = canWriteWorkflow(approveOrgRoutes);
  const v2ApproveAndPost = v2ApproveOnly && canWritePosting(approveOrgRoutes);
  const approveV2Mutation = useApproveIncomeExpenseV2();
  const approveAndPostV2Mutation = useApproveAndPostIncomeExpenseV2();
  const postApprovedV2Mutation = usePostApprovedIncomeExpenseV2();
  const reversePostingV2Mutation = useReversePostingV2();
  const { data: custodianBooks = [], isError: cashbookError, refetch: retryCashbooks } = useCustodianCashbooksV2(
    approveAndPostOpen || !!postApprovedTarget,
  );

  const { cancelEligibility, incomeCancelEligibility } = useVoucherCancelEligibility(vouchers);

  // Phiếu đang huỷ có ĐÃ GHI SỔ không (đổi lời cảnh báo + ô lý do).
  const cancelTargetVoucher = cancelTarget ? vouchers.find((v) => v.id === cancelTarget) ?? null : null;
  const unapproveTargetVoucher = vouchers.find((v) => v.id === unapproveTarget);
  const unapproveNeedsReason = !!unapproveTarget && (!unapproveTargetVoucher || isCommissionVoucher(unapproveTargetVoucher));
  const restoreTargetVoucher = vouchers.find((v) => v.id === restoreTarget);
  const restoreNeedsReason = !!restoreTarget && (!restoreTargetVoucher || isCommissionVoucher(restoreTargetVoucher));
  const cancelTargetPosted = cancelTargetVoucher?.posting_status === "POSTED";
  const cancelTargetIsIncome = (cancelTargetVoucher?.type ?? cancelTargetType) === "INCOME";
  // Hộp thoại xác nhận cũng phải tôn trọng câu trả lời của server: phiếu mở từ chi tiết/đợt có
  // thể không nằm trong trang hiện tại ⇒ không có dòng ⇒ gate mặc định "cho bấm", writer là chốt
  // chặn cuối.
  const cancelTargetGate = voucherCancelDecision({
    type: cancelTargetVoucher?.type ?? cancelTargetType,
    income: cancelTarget ? incomeCancelEligibility?.[cancelTarget] : undefined,
    flexGate: flexCancelGate(cancelTarget ? cancelEligibility?.[cancelTarget] : undefined),
  });

  const isShareholderPayout = !!approveTarget?.shareholder_id;
  const approvalAccounts = isShareholderPayout ? accounts.filter((account) => !account.is_virtual) : accounts;

  // Nạp giá trị hiện tại của phiếu mỗi khi mở hộp thoại duyệt.
  useEffect(() => {
    if (approveTarget) {
      const currentAccount = accounts.find((account) => account.id === approveTarget.account_id);
      setApproveAccountId(
        approveTarget.shareholder_id && currentAccount?.is_virtual ? "" : approveTarget.account_id ?? "",
      );
      setApproveAttachments(approveTarget.attachments ?? []);
      setApproveReason("");
      setActionError(null); setReasonError(null);
    }
  }, [accounts, approveTarget]);
  const approveNeedsReason = !!approveTarget && (
    accountChangeNeedsReason(approveTarget.account_id, approveAccountId) ||
    (isCommissionVoucher(approveTarget) && Object.keys(approvalEditPatch(approveTarget, { account_id: approveAccountId, attachments: approveAttachments })).length > 0)
  );
  const approveReasonOk = approveReason.trim().length >= REVISION_REASON_MIN;

  // ── Mở hộp ────────────────────────────────────────────────────────────────
  const edit = useCallback((voucher: IncomeExpenseWithRelations) => { setEditingVoucher(voucher); }, []);
  const quickEdit = useCallback((voucher: IncomeExpenseWithRelations) => { setQuickEditVoucher(voucher); }, []);
  const verify = useCallback((voucher: IncomeExpenseWithRelations) => { setVerifyVoucher(voucher); }, []);
  const history = useCallback((voucher: IncomeExpenseWithRelations) => { setHistoryVoucher(voucher); }, []);
  const copy = useCallback((voucher: IncomeExpenseWithRelations) => { setCopyVoucher(voucher); }, []);
  const approve = useCallback((voucher: IncomeExpenseWithRelations) => { setApproveTarget(voucher); }, []);
  const postApproved = useCallback((voucher: IncomeExpenseWithRelations) => { setPostApprovedTarget(voucher); }, []);
  const reverse = useCallback((voucher: IncomeExpenseWithRelations) => { setReverseTarget(voucher); }, []);
  const unapprove = useCallback((id: string) => {
    setLifecycleReason(""); setActionError(null);
    setUnapproveTarget(id);
  }, []);
  const cancel = useCallback((id: string, type?: string | null) => {
    setCancelTarget(id);
    setCancelTargetType(type ?? null);
  }, []);
  const restore = useCallback((id: string) => { setRestoreTarget(id); }, []);
  const cancelBatch = useCallback((batchId: string) => { setCancelBatchTarget(batchId); }, []);
  // Ghi ngay (không hộp xác nhận, như danh sách). Chờ promise chứ không dùng onSuccess của lượt gọi:
  // hộp chi tiết đóng ngay sau bấm nên màn gọi (vd Báo cáo LN) có thể đã gỡ, TanStack bỏ callback đó.
  // Lỗi đã được hook báo bằng toast.
  const { mutateAsync: stopRecurringAsync } = stopRecurringMutation;
  const stopRecurring = useCallback((id: string) => {
    void stopRecurringAsync(id).then(changed, () => undefined);
  }, [stopRecurringAsync, changed]);

  // ── Xác nhận ──────────────────────────────────────────────────────────────

  // Nếu người dùng đổi sổ quỹ hoặc thêm/bớt ảnh thì lưu trước — qua cửa sửa phiếu có lưu vết
  // (revise_pending_income_expense_v1) — rồi duyệt ĐÚNG phiên bản vừa sửa. Phiếu bị người khác
  // sửa giữa chừng ⇒ máy chủ trả 40001, không duyệt nhầm.
  const confirmApprove = useCallback(async () => {
    const target = approveTarget;
    if (!target) return;
    if (blockedVoucherId === target.id || approveHistoryBlocked) return;
    if (!v2ApproveOnly && approveNeedsReason && !approveReasonOk) {
      setReasonError("approveReason");
      void focusFirstError({ approveReason: "Nhập lý do thay đổi có ít nhất 8 ký tự." });
      return;
    }
    setActionError(null);
    // Câu 25: hỏi lại máy chủ NGAY TRƯỚC khi lưu đổi sổ/ảnh hay duyệt — bị chặn thì không lưu gì
    // (bị chặn: ghi chú trong hộp tự hiện từ cache cổng; chưa kiểm được: báo lỗi ở đây).
    setSelfApproveChecking(true);
    const selfCheck = await checkSelfApproveBeforeApprove(queryClient, target.id);
    setSelfApproveChecking(false);
    if (!selfCheck.ok) {
      if (selfCheck.reason === "unverified") setActionError(selfCheck.message);
      return;
    }
    // V2 CANONICAL: duyệt-only qua RPC canonical — KHÔNG đổi tồn quỹ, không quick-update sổ/ảnh
    // (posting fields thuộc Posting dialog, §12.3). Không có fallback legacy.
    if (v2ApproveOnly) {
      try {
        await approveV2Mutation.mutateAsync({
          voucherId: target.id,
          expectedApprovalVersion: (target as { approval_version?: number }).approval_version ?? 1,
        });
        setApproveTarget(null);
        changed();
      } catch (error) {
        setActionError(voucherFailureMessage(error, "duyệt phiếu"));
        if (voucherOutcomeUnknown(error)) setBlockedVoucherId(target.id);
      }
      return;
    }
    const patch = approvalEditPatch(target, {
      account_id: approveAccountId || null,
      attachments: approveAttachments,
    });
    let revisionSaved = false;
    try {
      let version = target.approval_version;
      if (Object.keys(patch).length > 0) {
        const revised = await reviseMutation.mutateAsync({
          voucherId: target.id,
          expectedApprovalVersion: version,
          patch,
          reason: approveReason.trim() || null,
          silent: true,
        });
        version = revised.approval_version;
        revisionSaved = revised.changed !== false;
      }
      await approveMutation.mutateAsync({ id: target.id, expectedApprovalVersion: version });
      setApproveTarget(null);
      changed();
    } catch (error) {
      setActionError(revisionSaved
        ? `Đã lưu thay đổi của phiếu nhưng chưa hoàn tất duyệt. ${voucherFailureMessage(error, "duyệt phiếu")} Tải lại phiếu trước khi tiếp tục.`
        : voucherFailureMessage(error, "duyệt phiếu"));
      if (revisionSaved || voucherOutcomeUnknown(error)) setBlockedVoucherId(target.id);
      if (revisionSaved) changed();
    }
  }, [
    approveTarget,
    approveAccountId,
    approveAttachments,
    approveReason,
    approveNeedsReason, approveReasonOk, blockedVoucherId, approveHistoryBlocked,
    approveMutation,
    reviseMutation,
    v2ApproveOnly,
    approveV2Mutation,
    queryClient,
    changed,
  ]);

  // "Duyệt và Thu/Chi…": kiểm cổng tự duyệt trước khi mở hộp ghi sổ (hộp đó nhận chứng từ
  // trước khi duyệt).
  const openApproveAndPost = useCallback(async () => {
    if (!approveTarget) return;
    setSelfApproveChecking(true);
    const selfCheck = await checkSelfApproveBeforeApprove(queryClient, approveTarget.id);
    setSelfApproveChecking(false);
    if (!selfCheck.ok) {
      if (selfCheck.reason === "unverified") setActionError(selfCheck.message);
      return;
    }
    setApproveAndPostOpen(true);
  }, [approveTarget, queryClient]);

  const confirmUnapprove = async () => {
    if (!unapproveTarget || unapproveMutation.isPending) return;
    if (unapproveNeedsReason && !isCommissionReasonValid(lifecycleReason)) { setActionError("Nhập lý do bỏ duyệt từ 8 đến 2.000 ký tự."); return; }
    try {
      await unapproveMutation.mutateAsync({ id: unapproveTarget, reason: unapproveNeedsReason ? lifecycleReason : undefined });
      setUnapproveTarget(null);
      changed();
    } catch (error) { setActionError(voucherFailureMessage(error, "bỏ duyệt phiếu")); }
  };

  const confirmRestore = async () => {
    if (!restoreTarget || restoreMutation.isPending) return;
    if (restoreNeedsReason && !isCommissionReasonValid(lifecycleReason)) { setActionError("Nhập lý do khôi phục từ 8 đến 2.000 ký tự."); return; }
    try {
      await restoreMutation.mutateAsync({ id: restoreTarget, reason: restoreNeedsReason ? lifecycleReason : undefined });
      setRestoreTarget(null);
      changed();
    } catch (error) { setActionError(voucherFailureMessage(error, "khôi phục phiếu")); }
  };

  const confirmCancel = async () => {
    if (!cancelTarget || blockedVoucherId === cancelTarget) return;
    const reason = cancelReason.trim();
    if (reason.length < 8) {
      setReasonError("cancelReason"); void focusFirstError({ cancelReason: "Nhập lý do huỷ có ít nhất 8 ký tự." }); return;
    }
    setActionError(null);
    try {
      if (cancelTargetGate.useIncomeDoor) await cancelIncomeMutation.mutateAsync({ voucherId: cancelTarget, reason });
      else if (cancelTargetGate.useFlexWriter && cancelTargetVoucher) await flexCancelMutation.mutateAsync({ voucherId: cancelTarget, reason, expectedApprovalVersion: cancelTargetVoucher.approval_version ?? null, expectedPostingVersion: cancelTargetVoucher.posting_version ?? null });
      else await cancelMutation.mutateAsync({ id: cancelTarget, reason });
      setCancelTarget(null); setCancelTargetType(null); setCancelReason("");
      changed();
    } catch (error) {
      setActionError(voucherFailureMessage(error, "huỷ phiếu"));
      if (voucherOutcomeUnknown(error) || error instanceof VoucherPartialError) setBlockedVoucherId(cancelTarget);
    }
  };

  const confirmCancelBatch = async () => {
    if (!cancelBatchTarget || blockedVoucherId === cancelBatchTarget) return;
    if (!isCommissionReasonValid(batchCancelReason)) { setActionError("Nhập lý do huỷ cả đợt từ 8 đến 2.000 ký tự."); return; }
    setActionError(null);
    try {
      const result = await cancelBatchMutation.mutateAsync({ batchId: cancelBatchTarget, reason: batchCancelReason });
      if (result.failures?.length) {
        setActionError(`Đã huỷ ${result.count} phiếu; ${result.failures.length} phiếu chưa hoàn tất. Kiểm tra từng phiếu trong đợt trước khi thao tác tiếp.`);
        setBlockedVoucherId(cancelBatchTarget);
        changed();
        return;
      }
      setCancelBatchTarget(null);
      changed();
    } catch (error) {
      setActionError(voucherFailureMessage(error, "huỷ đợt phiếu"));
      if (error instanceof VoucherPartialError || voucherOutcomeUnknown(error)) setBlockedVoucherId(cancelBatchTarget);
    }
  };

  const confirmReverse = async () => {
    if (!reverseTarget?.account_id || blockedVoucherId === reverseTarget.id) return;
    if (isCommissionVoucher(reverseTarget) && !isCommissionReasonValid(reverseReason)) { setActionError("Nhập lý do hoàn tác hoa hồng từ 8 đến 2.000 ký tự."); return; }
    setActionError(null);
    try {
      await reversePostingV2Mutation.mutateAsync({ voucherId: reverseTarget.id, cashbookId: reverseTarget.account_id, reason: reverseReason.trim() || null, isCommission: isCommissionVoucher(reverseTarget) });
      setReverseTarget(null); setReverseReason("");
      changed();
    } catch (error) {
      setActionError(voucherFailureMessage(error, "hoàn tác thu/chi"));
      if (voucherOutcomeUnknown(error)) setBlockedVoucherId(reverseTarget.id);
    }
  };

  // ── Đóng hộp ──────────────────────────────────────────────────────────────
  // Form sửa / bản sao / bổ sung / đánh dấu đã kiểm tự lưu bên trong: đóng = có thể đã ghi.
  const closeEdit = useCallback(() => { setEditingVoucher(null); changed(); }, [changed]);
  const closeCopy = useCallback(() => { setCopyVoucher(null); changed(); }, [changed]);
  const closeQuickEdit = useCallback(() => { setQuickEditVoucher(null); changed(); }, [changed]);
  const closeVerify = useCallback(() => { setVerifyVoucher(null); changed(); }, [changed]);
  const closeHistory = useCallback(() => { setHistoryVoucher(null); }, []);
  const closeCancel = useCallback(() => { setCancelTarget(null); setCancelTargetType(null); setCancelReason(""); }, []);
  const closeRestore = useCallback(() => { setRestoreTarget(null); }, []);
  const closeApprove = useCallback(() => { setApproveTarget(null); }, []);
  const closeUnapprove = useCallback(() => { setUnapproveTarget(null); }, []);
  const closeReverse = useCallback(() => { setReverseTarget(null); setReverseReason(""); }, []);
  const closePostApproved = useCallback(() => { setPostApprovedTarget(null); }, []);
  const closeCancelBatch = useCallback(() => { setCancelBatchTarget(null); }, []);

  const anyOpen = !!(editingVoucher || copyVoucher || quickEditVoucher || verifyVoucher || historyVoucher ||
    cancelTarget || restoreTarget || approveTarget || unapproveTarget || reverseTarget || postApprovedTarget ||
    cancelBatchTarget);

  return {
    // Mở hộp — truyền thẳng cho danh sách / hộp chi tiết / hộp đợt.
    edit, quickEdit, verify, history, copy, approve, postApproved, reverse, unapprove, cancel, restore,
    cancelBatch, stopRecurring,
    // Câu trả lời trước của máy chủ cho nút Huỷ (danh sách + hộp chi tiết dùng chung).
    cancelEligibility, incomeCancelEligibility,
    /** Có hộp nào của bộ này đang mở (màn ngoài Thu chi dùng để biết lúc đóng hẳn). */
    anyOpen,
    // ── Phần dưới chỉ VoucherActionDialogs dùng ──
    dialogs: {
      authUserId: authUser?.id ?? null,
      actionError, reasonError, setReasonError, blockedVoucherId,
      editingVoucher, closeEdit,
      copyVoucher, closeCopy,
      quickEditVoucher, closeQuickEdit,
      verifyVoucher, closeVerify,
      historyVoucher, closeHistory,
      cancel: {
        target: cancelTarget, close: closeCancel, confirm: confirmCancel,
        posted: cancelTargetPosted, isIncome: cancelTargetIsIncome, gate: cancelTargetGate,
        reason: cancelReason, setReason: setCancelReason,
        pending: flexCancelMutation.isPending || cancelIncomeMutation.isPending || cancelMutation.isPending,
      },
      restore: {
        target: restoreTarget, close: closeRestore, confirm: confirmRestore,
        needsReason: restoreNeedsReason, reason: lifecycleReason, setReason: setLifecycleReason,
        pending: restoreMutation.isPending,
      },
      unapprove: {
        target: unapproveTarget, close: closeUnapprove, confirm: confirmUnapprove,
        needsReason: unapproveNeedsReason, reason: lifecycleReason, setReason: setLifecycleReason,
        pending: unapproveMutation.isPending,
      },
      approve: {
        target: approveTarget, close: closeApprove, confirm: confirmApprove, openApproveAndPost,
        v2ApproveOnly, v2ApproveAndPost, selfGate: approveSelfGate, selfChecking: selfApproveChecking,
        historyBlocked: approveHistoryBlocked, accounts: approvalAccounts, isShareholderPayout,
        accountId: approveAccountId, setAccountId: setApproveAccountId,
        attachments: approveAttachments, setAttachments: setApproveAttachments,
        needsReason: approveNeedsReason, reason: approveReason, setReason: setApproveReason,
        pending: approveMutation.isPending || reviseMutation.isPending || approveV2Mutation.isPending,
      },
      approveAndPost: {
        open: approveAndPostOpen, setOpen: setApproveAndPostOpen,
        submit: async (input: Parameters<typeof approveAndPostV2Mutation.mutateAsync>[0]) => {
          await approveAndPostV2Mutation.mutateAsync(input);
          setApproveAndPostOpen(false);
          setApproveTarget(null);
          changed();
        },
        pending: approveAndPostV2Mutation.isPending,
      },
      postApproved: {
        target: postApprovedTarget, close: closePostApproved,
        submit: async (input: Parameters<typeof postApprovedV2Mutation.mutateAsync>[0]) => {
          await postApprovedV2Mutation.mutateAsync(input);
          setPostApprovedTarget(null);
          changed();
        },
        pending: postApprovedV2Mutation.isPending,
      },
      reverse: {
        target: reverseTarget, close: closeReverse, confirm: confirmReverse,
        reason: reverseReason, setReason: setReverseReason, pending: reversePostingV2Mutation.isPending,
      },
      cancelBatch: {
        target: cancelBatchTarget, close: closeCancelBatch, confirm: confirmCancelBatch,
        reason: batchCancelReason, setReason: setBatchCancelReason,
      },
      posting: {
        custodianBooks, cashbookError, retryCashbooks, attachPostingEvidence, removePostingAttachment,
      },
    },
  };
}

export type VoucherActions = ReturnType<typeof useVoucherActions>;
