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

  const approve = (row: PendingApproval) =>
    decide.mutate({ requestId: row.request_id, decision: "APPROVE", reason: null });

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
                  <div className="flex gap-2 mt-3">
                    <Button
                      size="sm"
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                      disabled={decide.isPending}
                      onClick={() => approve(r)}
                    >
                      <Check className="h-4 w-4 mr-1" />
                      Duyệt
                    </Button>
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
                            disabled={decide.isPending}
                            onClick={() => approve(r)}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Duyệt
                          </Button>
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
