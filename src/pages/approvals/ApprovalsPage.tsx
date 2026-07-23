// Trang "Chờ duyệt" — hộp thư yêu cầu duyệt phiếu thu/chi của CHÍNH người đang
// đăng nhập. Server (list_my_pending_approvals_v1) đã lọc theo auth.uid() nên
// route không cần gate quyền: ai vào cũng chỉ thấy phần việc của mình.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { Check, ClipboardCheck, RefreshCw, X } from "lucide-react";
import { format } from "date-fns";
import { formatVND } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  usePendingApprovals,
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
} from "@/hooks/income-expenses/financeV2Mutations";
import IncomeExpensePostingDialog from "@/components/income-expenses/IncomeExpensePostingDialog";

const typeLabel = (type: string | null) => {
  if (type === "INCOME") return { text: "Phiếu thu", className: "bg-emerald-100 text-emerald-700" };
  if (type === "EXPENSE") return { text: "Phiếu chi", className: "bg-rose-100 text-rose-700" };
  return { text: type ?? "—", className: "bg-muted text-muted-foreground" };
};

const ApprovalsPage = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data: rows = [], isLoading, isFetching, refetch } = usePendingApprovals();
  const decide = useDecideApproval();

  // Từ chối BẮT BUỘC nhập lý do → mở dialog thay vì gọi thẳng RPC.
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);
  const [reason, setReason] = useState("");

  // Finance V2 route-aware: resolve route theo org của từng request (phiếu subject).
  // organization_id chưa có trên RPC ⇒ null ⇒ LEGACY (flow decide cũ, không đổi).
  const v2Routes = useFinanceV2Routes();
  const approveV2 = useApproveIncomeExpenseV2();
  const approveAndPostV2 = useApproveAndPostIncomeExpenseV2();
  // "Duyệt và Thu/Chi…" mở Posting dialog cho request này (chỉ org CANONICAL).
  const [postTarget, setPostTarget] = useState<PendingApproval | null>(null);
  // Chỉ hỏi sổ CUSTODIAN khi có ít nhất 1 request thuộc org posting-CANONICAL.
  const anyV2Posting = rows.some((r) => {
    const or = v2Routes.getOrg(r.organization_id);
    return !!r.voucher_id && canWriteWorkflow(or) && canWritePosting(or);
  });
  const { data: custodianBooks = [] } = useCustodianCashbooksV2(anyV2Posting);

  // V2 duyệt-only áp cho request có phiếu subject (INCOME_EXPENSE) và org workflow-CANONICAL.
  const v2WorkflowFor = (row: PendingApproval) =>
    !!row.voucher_id && canWriteWorkflow(v2Routes.getOrg(row.organization_id));
  // Option "Duyệt và Thu/Chi…" cần thêm posting-CANONICAL và actor đang giữ sổ.
  const v2PostOptionFor = (row: PendingApproval) =>
    v2WorkflowFor(row) &&
    canWritePosting(v2Routes.getOrg(row.organization_id)) &&
    custodianBooks.length > 0;

  const closeReject = () => {
    setRejecting(null);
    setReason("");
  };

  // Lỗi (hết quyền, request đã đóng…) đã được hook toast nguyên văn — giữ dialog
  // mở để người duyệt sửa lý do/thử lại thay vì mất nội dung vừa gõ.
  const submitReject = async () => {
    if (!rejecting || !reason.trim()) return;
    try {
      await decide.mutateAsync({
        requestId: rejecting.request_id,
        decision: "REJECT",
        reason: reason.trim(),
      });
      closeReject();
    } catch {
      /* toast đã hiện trong useDecideApproval */
    }
  };

  const approve = (row: PendingApproval) => {
    // V2 CANONICAL: duyệt-only trên PHIẾU qua RPC canonical — KHÔNG đổi tồn quỹ
    // (posting làm sau ở dialog Thu/Chi). Không fallback legacy khi RPC lỗi.
    if (v2WorkflowFor(row)) {
      approveV2.mutate(
        {
          voucherId: row.voucher_id,
          expectedApprovalVersion: row.approval_version ?? 1,
        },
        { onSuccess: () => refetch() },
      );
      return;
    }
    decide.mutate({ requestId: row.request_id, decision: "APPROVE", reason: null });
  };

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
            {isLoading ? "Đang tải…" : `${rows.length} yêu cầu chờ bạn duyệt`}
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Tải lại
          </Button>
        </div>

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
                  <div className="text-xs text-muted-foreground mt-1">
                    <Badge variant="outline" className={t.className}>
                      {t.text}
                    </Badge>
                    <span className="ml-2">Bước {r.step_no}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {r.maker_name ?? "—"} • {format(new Date(r.submitted_at), "dd/MM/yyyy HH:mm")}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button
                      size="sm"
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                      disabled={decide.isPending || approveV2.isPending}
                      onClick={() => approve(r)}
                    >
                      <Check className="h-4 w-4 mr-1" />
                      Duyệt
                    </Button>
                    {v2PostOptionFor(r) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-blue-600 text-blue-700 hover:bg-blue-50"
                        disabled={
                          decide.isPending ||
                          approveV2.isPending ||
                          approveAndPostV2.isPending
                        }
                        onClick={() => setPostTarget(r)}
                      >
                        {r.voucher_type === "INCOME" ? "Duyệt và Thu…" : "Duyệt và Chi…"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1"
                      disabled={decide.isPending}
                      onClick={() => setRejecting(r)}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Từ chối
                    </Button>
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
                  return (
                    <TableRow key={r.request_id}>
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
                        <Badge variant="outline" className={t.className}>
                          {t.text}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-bold">{formatVND(r.amount)}</TableCell>
                      <TableCell>{r.maker_name ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(r.submitted_at), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-center">{r.step_no}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700"
                            disabled={decide.isPending || approveV2.isPending}
                            onClick={() => approve(r)}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Duyệt
                          </Button>
                          {v2PostOptionFor(r) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-blue-600 text-blue-700 hover:bg-blue-50"
                              disabled={
                                decide.isPending ||
                                approveV2.isPending ||
                                approveAndPostV2.isPending
                              }
                              onClick={() => setPostTarget(r)}
                            >
                              {r.voucher_type === "INCOME" ? "Duyệt và Thu…" : "Duyệt và Chi…"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={decide.isPending}
                            onClick={() => setRejecting(r)}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Từ chối
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
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
            type: postTarget.voucher_type === "INCOME" ? "INCOME" : "EXPENSE",
            approvedTotal: postTarget.amount ?? 0,
            name: postTarget.voucher_name ?? undefined,
          }}
          capability={{ isCustodian: custodianBooks.length > 0, canApprove: true }}
          cashbookOptions={custodianBooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={postTarget.approval_version ?? 1}
          expectedPostingVersion={postTarget.posting_version ?? 1}
          onSubmit={async (input) => {
            await approveAndPostV2.mutateAsync(input);
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
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Lý do từ chối (bắt buộc)"
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeReject} disabled={decide.isPending}>
              Đóng
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={!reason.trim() || decide.isPending}
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
