// Trang "Chờ duyệt" — hộp thư yêu cầu duyệt phiếu thu/chi của CHÍNH người đang
// đăng nhập. Server (list_my_pending_approvals_v1) đã lọc theo auth.uid() nên
// route không cần gate quyền: ai vào cũng chỉ thấy phần việc của mình.

import { Fragment, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonBar } from "@/components/loading/LoadingState";
import { Check, ClipboardCheck, RefreshCw, X } from "lucide-react";
import { format } from "date-fns";
import { formatVND } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/useAuth";
import {
  usePendingApprovals,
  usePendingApprovalSources,
  useDecideApproval,
  type PendingApproval,
} from "@/hooks/useApprovals";
// Finance V2 (route-aware §9.6/§12.4): org CANONICAL → "Duyệt" = duyệt-only RPC v2
// trên PHIẾU (subject), thêm "Duyệt và Thu/Chi…" (Posting dialog) khi actor giữ sổ.
// Mặc định LEGACY giữ nguyên decide_financial_request_v2.
import {
  useFinanceV2Routes,
  canWriteWorkflow,
  canWritePosting,
} from "@/lib/financeV2Route";
import {
  useApproveIncomeExpenseV2,
  useApproveAndPostIncomeExpenseV2,
  useCustodianCashbooksV2,
  uploadFinanceEvidence,
  adoptVoucherAttachmentsAsEvidence,
  useAttachPostingEvidence,
  useRemovePostingAttachment,
} from "@/hooks/income-expenses/financeV2Mutations";
import IncomeExpensePostingDialog from "@/components/income-expenses/IncomeExpensePostingDialog";
import { AiSubmittedBadge } from "@/components/approvals/AiSubmittedBadge";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { voucherFailureMessage, voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { loadIncomeExpenseDetails } from '@/lib/incomeExpenseDetailRpc';
import { hasCompleteVoucherDetail } from '@/lib/incomeExpenseDetailRead';
import { withDetailReadDeadline } from '@/hooks/income-expenses/detailRead';
import { isCommissionVoucher } from '@/lib/commissionIntervention';
// Đợt 2 sổ tổng (D2.9): phiếu chi lợi nhuận / lương điều hành — thẻ số dư sổ tổng, khoá Duyệt khi máy chủ
// chắc chắn từ chối, "Duyệt và Chi…" chỉ từ đúng sổ lúc lập, câu báo lỗi theo mã chốt F1/F5.
import { ProfitLedgerApprovalNote } from "@/components/approvals/ProfitLedgerApprovalNote";
import { useProfitLedgerPayoutDetail } from "@/hooks/profit-ledger/useProfitLedgerQueries";
import { invalidateProfitLedgerQueries } from "@/hooks/profit-ledger/useProfitLedgerMutations";
import { ledgerApprovalGate } from "@/lib/profitLedger/approvalGate";
import { isProfitLedgerVoucher } from "@/lib/profitLedger/vouchers";
import { ledgerAwareVoucherFailure } from "@/lib/profitLedger/voucherFailure";

const typeLabel = (type: string | null) => {
  if (type === "INCOME") return { text: "Phiếu thu", className: "bg-emerald-100 text-emerald-700" };
  if (type === "EXPENSE") return { text: "Phiếu chi", className: "bg-rose-100 text-rose-700" };
  return { text: type ?? "—", className: "bg-muted text-muted-foreground" };
};

interface ApprovalActionsProps {
  row: PendingApproval;
  /** Phiếu chi theo sổ tổng (đã đọc được nguồn phiếu). */
  ledger: boolean;
  /** Luật chung cho "Duyệt và Thu/Chi…": tổ chức ghi sổ kiểu mới, đang giữ sổ, đã biết nguồn phiếu. */
  postOption: boolean;
  custodianBookIds: ReadonlySet<string>;
  approveBusy: boolean;
  postBusy: boolean;
  rejectBusy: boolean;
  mobile: boolean;
  onApprove: () => void;
  /** `lockedCashbookId`: phiếu sổ tổng chỉ chi từ sổ lúc lập; phiếu thường null. */
  onPost: (lockedCashbookId: string | null) => void;
  onReject: () => void;
}

/**
 * Ba nút của một yêu cầu. Phiếu thường: y như trước. Phiếu chi theo sổ tổng: đọc E7 (cùng cache với thẻ số
 * dư) — chưa thấy số dư hoặc máy chủ chắc chắn từ chối (sổ tổng chưa bật / đóng băng, phiếu chết, người
 * nhận đã xoá, lương điều hành vượt) ⇒ khoá Duyệt; "Duyệt và Chi…" chỉ khi người duyệt giữ ĐÚNG sổ lúc lập.
 * Từ chối luôn được (chốt F5 cho qua, số dư hồi).
 */
function ApprovalActions({
  row, ledger, postOption, custodianBookIds, approveBusy, postBusy, rejectBusy, mobile, onApprove, onPost, onReject,
}: ApprovalActionsProps) {
  const detail = useProfitLedgerPayoutDetail(ledger ? row.voucher_id : null);
  const gate = ledger && detail.data ? ledgerApprovalGate(detail.data) : null;
  const ledgerBlocked = ledger && (!gate || !!gate.blockReason);
  const ledgerTitle = !ledger ? undefined
    : gate?.blockReason ?? (gate ? undefined : detail.isError ? "Chưa tải được số dư sổ tổng" : "Đang tải số dư sổ tổng");
  const lockedCashbookId = ledger ? gate?.accountId ?? null : null;
  const showPost = postOption && (!ledger || (!ledgerBlocked && !!lockedCashbookId && custodianBookIds.has(lockedCashbookId)));
  return (
    <>
      <Button
        size="sm"
        className={mobile ? "flex-1 bg-emerald-600 hover:bg-emerald-700" : "bg-emerald-600 hover:bg-emerald-700"}
        disabled={approveBusy || ledgerBlocked}
        title={ledgerTitle}
        onClick={onApprove}
      >
        <Check className="h-4 w-4 mr-1" />
        Duyệt
      </Button>
      {showPost && (
        <Button
          size="sm"
          variant="outline"
          className={mobile ? "flex-1 border-blue-600 text-blue-700 hover:bg-blue-50" : "border-blue-600 text-blue-700 hover:bg-blue-50"}
          disabled={postBusy}
          onClick={() => onPost(lockedCashbookId)}
        >
          {row.voucher_type === "INCOME" ? "Duyệt và Thu…" : "Duyệt và Chi…"}
        </Button>
      )}
      <Button
        size="sm"
        variant="destructive"
        className={mobile ? "flex-1" : undefined}
        disabled={rejectBusy}
        onClick={onReject}
      >
        <X className="h-4 w-4 mr-1" />
        Từ chối
      </Button>
    </>
  );
}

const ApprovalsPage = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const pendingQuery = usePendingApprovals();
  const { data: rows = [], isLoading, isFetching, isError, refetch } = pendingQuery;
  const decide = useDecideApproval();
  const { data: authUser } = useAuth();
  // Dán ảnh trong hộp thoại Thu/Chi = đính ảnh lên phiếu rồi nhận nó làm chứng
  // từ, để ảnh hiện được ở dòng thu chi (xem IncomeExpensePage).
  const attachPostingEvidence = useAttachPostingEvidence();
  const removePostingAttachment = useRemovePostingAttachment();

  // Từ chối BẮT BUỘC nhập lý do → mở dialog thay vì gọi thẳng RPC.
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockedRequests, setBlockedRequests] = useState<Set<string>>(() => new Set());
  const reportActionError = (error: unknown, requestId: string) => {
    // Lỗi chốt sổ tổng (PROFIT_LEDGER_…) ra câu riêng; lỗi khác như cũ.
    setActionError(ledgerAwareVoucherFailure(error, "xử lý yêu cầu duyệt"));
    if (voucherOutcomeUnknown(error)) setBlockedRequests(previous => new Set(previous).add(requestId));
  };

  // Nguồn phiếu (RPC hộp thư không có system_source): biết dòng nào là phiếu chi theo sổ tổng.
  const queryClient = useQueryClient();
  const sourcesQuery = usePendingApprovalSources(rows);
  const sourceOf = (row: PendingApproval) => sourcesQuery.data?.[row.voucher_id] ?? null;
  const isLedgerRow = (row: PendingApproval) => isProfitLedgerVoucher(sourceOf(row)?.system_source);
  // Duyệt / từ chối / chi phiếu sổ tổng đổi số dư sổ tổng: làm mới cả các màn sổ tổng.
  const refreshLedger = (row: PendingApproval) => { if (isLedgerRow(row)) invalidateProfitLedgerQueries(queryClient); };

  // Finance V2 route-aware: resolve route theo org của từng request (phiếu subject).
  // organization_id chưa có trên RPC ⇒ null ⇒ LEGACY (flow decide cũ, không đổi).
  const v2Routes = useFinanceV2Routes();
  const approveV2 = useApproveIncomeExpenseV2({scope:'target'});
  const approveAndPostV2 = useApproveAndPostIncomeExpenseV2({scope:'target'});
  // "Duyệt và Thu/Chi…" mở Posting dialog cho request này (chỉ org CANONICAL).
  // lockedCashbookId: phiếu chi theo sổ tổng chỉ chi từ đúng sổ lúc lập (chốt F1 ACCOUNT_LOCKED).
  const [postTarget, setPostTarget] = useState<(PendingApproval & { isCommission: boolean; lockedCashbookId: string | null }) | null>(null);
  const [openingPosting, setOpeningPosting] = useState(false);
  const postingRead = useRef<symbol | null>(null);
  useEffect(() => {
    postingRead.current = null; setOpeningPosting(false); setPostTarget(null);
    return () => { postingRead.current = null; };
  }, [authUser?.id]);
  // Chỉ hỏi sổ CUSTODIAN khi có ít nhất 1 request thuộc org posting-CANONICAL.
  const anyV2Posting = rows.some((r) => {
    const or = v2Routes.getOrg(r.organization_id);
    return !!r.voucher_id && canWriteWorkflow(or) && canWritePosting(or);
  });
  const { data: custodianBooks = [], isError: cashbookError, refetch: retryCashbooks } = useCustodianCashbooksV2(anyV2Posting);

  // V2 duyệt-only áp cho request có phiếu subject (INCOME_EXPENSE) và org workflow-CANONICAL.
  const v2WorkflowFor = (row: PendingApproval) =>
    !!row.voucher_id && canWriteWorkflow(v2Routes.getOrg(row.organization_id));
  // Option "Duyệt và Thu/Chi…" cần thêm posting-CANONICAL, actor đang giữ sổ, và đã biết nguồn phiếu
  // (phiếu chi theo sổ tổng chỉ chi từ sổ lúc lập — ApprovalActions xét thêm cho loại phiếu đó).
  const v2PostOptionFor = (row: PendingApproval) =>
    v2WorkflowFor(row) &&
    canWritePosting(v2Routes.getOrg(row.organization_id)) &&
    custodianBooks.length > 0 &&
    !!sourceOf(row);
  const custodianBookIds = new Set(custodianBooks.map((book) => book.id));

  const openPosting = async (row: PendingApproval, lockedCashbookId: string | null = null) => {
    if (postingRead.current || !row.organization_id || !row.voucher_id || blockedRequests.has(row.request_id) || !v2PostOptionFor(row)) return;
    const token = Symbol('approval voucher detail'); postingRead.current = token;
    setOpeningPosting(true); setActionError(null);
    try {
      const [detail] = await withDetailReadDeadline(loadIncomeExpenseDetails(row.organization_id, [row.voucher_id]));
      if (postingRead.current !== token) return;
      if (!detail || detail.id !== row.voucher_id || detail.organization_id !== row.organization_id || !hasCompleteVoucherDetail(detail)
        || detail.approval_status !== 'UNAPPROVED' || detail.posting_status !== 'UNPOSTED')
        throw new Error('Chưa xác định được đầy đủ phiếu đang chờ duyệt. Vui lòng tải lại trước khi duyệt và thu/chi.');
      // Phiếu sổ tổng: chỉ đi tiếp khi sổ của phiếu (đọc lại ngay lúc bấm) đúng là sổ đã chào trên dòng.
      const ledger = isProfitLedgerVoucher(detail.system_source);
      if (ledger && (!lockedCashbookId || detail.account_id !== lockedCashbookId)) {
        setActionError('Phiếu chi theo sổ tổng chỉ chi được từ sổ quỹ đã chọn lúc lập — sổ trên phiếu vừa khác sổ đang chào. Tải lại danh sách rồi thử lại.');
        return;
      }
      setPostTarget({ ...row, isCommission: isCommissionVoucher(detail), voucher_type: detail.type,
        voucher_name: detail.name, amount: detail.total_amount, approval_version: detail.approval_version, posting_version: detail.posting_version,
        lockedCashbookId: ledger ? lockedCashbookId : null });
    } catch (error) {
      if (postingRead.current === token) setActionError(voucherFailureMessage(error, 'đọc chi tiết phiếu trước khi duyệt và thu/chi'));
    } finally {
      if (postingRead.current === token) { postingRead.current = null; setOpeningPosting(false); }
    }
  };

  const closeReject = () => {
    setRejecting(null);
    setReason("");
    setReasonError(false);
  };

  // Lỗi (hết quyền, request đã đóng…) đã được hook toast nguyên văn — giữ dialog
  // mở để người duyệt sửa lý do/thử lại thay vì mất nội dung vừa gõ.
  const submitReject = async () => {
    if (!rejecting || blockedRequests.has(rejecting.request_id)) return;
    if (!reason.trim()) { setReasonError(true); reasonRef.current?.focus(); return; }
    try {
      await decide.mutateAsync({
        requestId: rejecting.request_id,
        organizationId: rejecting.organization_id,
        decision: "REJECT",
        reason: reason.trim(),
      });
      refreshLedger(rejecting);
      closeReject();
    } catch (error) {
      reportActionError(error, rejecting.request_id);
    }
  };

  const approve = (row: PendingApproval) => {
    if (blockedRequests.has(row.request_id)) return;
    setActionError(null);
    // V2 CANONICAL: duyệt-only trên PHIẾU qua RPC canonical — KHÔNG đổi tồn quỹ
    // (posting làm sau ở dialog Thu/Chi). Không fallback legacy khi RPC lỗi.
    if (v2WorkflowFor(row)) {
      approveV2.mutate(
        {
          voucherId: row.voucher_id,
          organizationId: row.organization_id,
          expectedApprovalVersion: row.approval_version ?? 1,
        },
        { onSuccess: () => { refetch(); refreshLedger(row); }, onError: error => reportActionError(error, row.request_id) },
      );
      return;
    }
    decide.mutate({ requestId: row.request_id,
        organizationId: row.organization_id, decision: "APPROVE", reason: null },
      { onSuccess: () => refreshLedger(row), onError: error => reportActionError(error, row.request_id) });
  };
  const rowActions = (r: PendingApproval, mobile: boolean) => (
    <ApprovalActions
      row={r}
      ledger={isLedgerRow(r)}
      postOption={v2PostOptionFor(r)}
      custodianBookIds={custodianBookIds}
      approveBusy={decide.isPending || approveV2.isPending}
      postBusy={decide.isPending || approveV2.isPending || approveAndPostV2.isPending || openingPosting}
      rejectBusy={decide.isPending}
      mobile={mobile}
      onApprove={() => approve(r)}
      onPost={(lockedCashbookId) => void openPosting(r, lockedCashbookId)}
      onReject={() => setRejecting(r)}
    />
  );
  const postBooks = postTarget?.lockedCashbookId
    ? custodianBooks.filter((book) => book.id === postTarget.lockedCashbookId)
    : custodianBooks;

  const emptyMsg = "Không có yêu cầu nào chờ bạn duyệt";

  return (
    <MainLayout
      title="Chờ duyệt"
      subtitle="Tài chính → Yêu cầu duyệt phiếu thu/chi"
      icon={ClipboardCheck}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {/* Đang tải: vạch xám chỗ số yêu cầu (câu cho trình đọc màn hình nằm ở vùng danh
                sách bên dưới) — chủ chốt 02/10/2026. */}
            {isLoading
              ? <span className="ld-appear block" aria-hidden="true"><SkeletonBar className="h-3" style={{ width: '10rem' }} /></span>
              : isError ? "Chưa cập nhật được yêu cầu chờ duyệt" : `${rows.length} yêu cầu chờ bạn duyệt`}
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Tải lại
          </Button>
        </div>

        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        {sourcesQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            Chưa xác định được loại phiếu chờ duyệt — tạm ẩn "Duyệt và Thu/Chi…" và số dư sổ tổng.{" "}
            <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={() => { void sourcesQuery.refetch(); }}>
              Thử lại
            </Button>
          </p>
        )}
        {openingPosting &&<p role="status" className="text-sm text-muted-foreground">Đang đối chiếu chi tiết phiếu trước khi duyệt và thu/chi…</p>}
        <QueryRegion label="yêu cầu chờ duyệt" queries={[pendingQuery]} skeleton={isMobile ? "list" : "table"} rows={isMobile ? 4 : 6}>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Card className="p-10 text-center">
            <ClipboardCheck className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <div className="mt-3 font-medium">{emptyMsg}</div>
            <div className="text-sm text-muted-foreground mt-1">
              Yêu cầu mới sẽ xuất hiện ở đây ngay khi người lập gửi duyệt.
            </div>
          </Card>
        ) : isMobile ? (
          <div className="space-y-2">
            {rows.map((r) => {
              const t = typeLabel(r.voucher_type);
              return (
                <Card key={r.request_id} className="p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <button
                      className="font-medium text-sm text-blue-600 hover:underline"
                      onClick={() => navigate(`/income-expense/voucher/${r.voucher_id}`)}
                    >
                      {r.voucher_code ?? "—"}
                    </button>
                    <div className="font-bold">{formatVND(r.amount)}</div>
                  </div>
                  <div className="text-sm mt-1">{r.voucher_name ?? "—"}</div>
                  <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className={t.className}>
                      {t.text}
                    </Badge>
                    <AiSubmittedBadge systemSource={r.system_source} />
                    <span className="ml-2">Bước {r.step_no}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {r.maker_name ?? "—"} • {format(new Date(r.submitted_at), "dd/MM/yyyy HH:mm")}
                  </div>
                  {isLedgerRow(r) && <ProfitLedgerApprovalNote voucherId={r.voucher_id} className="mt-2" />}
                  <div className="flex flex-wrap gap-2 mt-3">
                    {rowActions(r, true)}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã phiếu</TableHead>
                  <TableHead>Tên phiếu</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead className="text-right">Số tiền</TableHead>
                  <TableHead>Người lập</TableHead>
                  <TableHead>Gửi lúc</TableHead>
                  <TableHead className="text-center">Bước</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const t = typeLabel(r.voucher_type);
                  const ledger = isLedgerRow(r);
                  return (
                    <Fragment key={r.request_id}>
                    <TableRow className={ledger ? "border-b-0" : undefined}>
                      <TableCell className="font-medium">
                        <button
                          className="text-blue-600 hover:underline"
                          onClick={() => navigate(`/income-expense/voucher/${r.voucher_id}`)}
                        >
                          {r.voucher_code ?? "—"}
                        </button>
                      </TableCell>
                      <TableCell className="max-w-xs truncate">{r.voucher_name ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="outline" className={t.className}>
                            {t.text}
                          </Badge>
                          <AiSubmittedBadge systemSource={r.system_source} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-bold">{formatVND(r.amount)}</TableCell>
                      <TableCell>{r.maker_name ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(r.submitted_at), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-center">{r.step_no}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {rowActions(r, false)}
                        </div>
                      </TableCell>
                    </TableRow>
                    {/* Ô tên phiếu cắt chữ: thẻ số dư sổ tổng nằm ở dòng phụ ngay dưới, cùng yêu cầu. */}
                    {ledger && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="pt-0">
                          <ProfitLedgerApprovalNote voucherId={r.voucher_id} />
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
        </QueryRegion>
      </div>

      {/* Finance V2: Duyệt và Chi/Thu atomic qua Posting dialog (§12.3/§12.4). */}
      {postTarget && (
        <IncomeExpensePostingDialog
          open={!!postTarget}
          onOpenChange={(o) => {
            if (!o) setPostTarget(null);
          }}
          mode="APPROVE_AND_POST"
          voucher={{
            subjectKind: "VOUCHER",
            subjectId: postTarget.voucher_id,
            isCommission: postTarget.isCommission,
            type: postTarget.voucher_type === "INCOME" ? "INCOME" : "EXPENSE",
            approvedTotal: postTarget.amount ?? 0,
            name: postTarget.voucher_name ?? undefined,
            // Phiếu chi theo sổ tổng: chỉ chào đúng sổ lúc lập (máy chủ chặn sổ khác).
            ...(postTarget.lockedCashbookId
              ? { defaultCashbookId: postTarget.lockedCashbookId, cashbookLocked: true }
              : {}),
          }}
          capability={{ isCustodian: postBooks.length > 0, canApprove: true }}
          cashbookOptions={postBooks}
          cashbookError={cashbookError}
          onRetryCashbooks={retryCashbooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={postTarget.approval_version ?? 1}
          expectedPostingVersion={postTarget.posting_version ?? 1}
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onAttachEvidence={(file) =>
            attachPostingEvidence(file, {
              voucherId: postTarget.voucher_id as string,
              userId: authUser?.id ?? "",
              organizationId: postTarget.organization_id,
            })
          }
          onRemoveAttachment={(url) =>
            removePostingAttachment(postTarget.voucher_id as string, url)
          }
          onUploadEvidence={(file) =>
            uploadFinanceEvidence(file, postTarget.organization_id)
          }
          onSubmit={async (input) => {
            await approveAndPostV2.mutateAsync({...input,organizationId:postTarget.organization_id});
            if (postTarget.lockedCashbookId) invalidateProfitLedgerQueries(queryClient);
            setPostTarget(null);
            refetch();
          }}
          isSubmitting={approveAndPostV2.isPending}
        />
      )}

      <Dialog open={!!rejecting} onOpenChange={(open) => !open && closeReject()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Từ chối yêu cầu</DialogTitle>
            <DialogDescription>
              {rejecting?.voucher_code ?? "—"} • {formatVND(rejecting?.amount ?? 0)} — vui lòng nêu
              lý do để người lập biết cần sửa gì.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            ref={reasonRef}
            aria-label="Lý do từ chối"
            aria-invalid={reasonError}
            aria-describedby={reasonError ? "reject-reason-error" : undefined}
            value={reason}
            onChange={(e) => { setReason(e.target.value); if (e.target.value.trim()) setReasonError(false); }}
            placeholder="Lý do từ chối (bắt buộc)"
            rows={4}
          />
          {reasonError && <p id="reject-reason-error" role="alert" className="text-sm text-destructive">Nhập lý do từ chối để người lập biết cần sửa gì.</p>}
          {rejecting && isLedgerRow(rejecting) && (
            <p className="text-xs text-muted-foreground">
              Phiếu chi theo sổ tổng: từ chối xong số dư sổ tổng trả lại ngay; phiếu chỉ còn bỏ được bằng nút Huỷ (ghi lý do).
            </p>
          )}
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={closeReject} disabled={decide.isPending}>
              Đóng
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={decide.isPending || !!rejecting && blockedRequests.has(rejecting.request_id)}
            >
              Xác nhận từ chối
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default ApprovalsPage;
