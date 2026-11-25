import { voucherFailureMessage } from "@/lib/voucherFeedback";
import { FinancialAlreadyRecordedError } from "@/lib/financialWorkflow";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2 } from "lucide-react";
import {
  useVerifyIncomeExpense,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import { format } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
}

export function IncomeExpenseVerifyDialog({
  open,
  onOpenChange,
  voucher,
}: Props) {
  const verifyMutation = useVerifyIncomeExpense();
  const [note, setNote] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reconcileRequired, setReconcileRequired] = useState(false);

  const isVerified = !!voucher?.verified_at;

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  useEffect(() => {
    setSubmitError(null);
    setReconcileRequired(false);
  }, [voucher?.id]);

  if (!voucher) return null;

  const handleConfirm = async () => {
    if (reconcileRequired) return;
    try {
      const receipt = await verifyMutation.mutateAsync({id:voucher.id,note:note.trim() || null});
      if (!receipt) {
        setSubmitError("Đã thực hiện cập nhật nhưng chưa đọc được trạng thái đã kiểm. Tải lại phiếu để kiểm tra; không bấm đổi trạng thái thêm lần nữa.");
        setReconcileRequired(true); return;
      }
      onOpenChange(false);
    } catch(error) {
      // Đợt 5: lần bấm sau tự so trạng thái đã kiểm với lúc bấm (đã đổi thì không gửi lần hai, vì gửi lại là đảo ngược),
      // nên kết quả chưa rõ không khoá hộp nữa; câu báo vẫn hiện. Khi máy đã kết luận «đã ở trạng thái …», hộp đang giữ
      // ảnh phiếu cũ: khoá nút tới khi mở lại, kẻo lần bấm sau (không còn dấu) đảo ngược trạng thái vừa xác nhận.
      setSubmitError(voucherFailureMessage(error,"cập nhật trạng thái đã kiểm"));
      if (error instanceof FinancialAlreadyRecordedError) setReconcileRequired(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            {isVerified ? "Bỏ đánh dấu đã kiểm" : "Đánh dấu đã kiểm tra"}
          </DialogTitle>
          <DialogDescription>
            {isVerified ? (
              <>
                Phiếu đã được{" "}
                <b>{voucher.verified_by_name ?? "người khác"}</b> kiểm lúc{" "}
                {voucher.verified_at
                  ? format(new Date(voucher.verified_at), "HH:mm dd/MM/yyyy")
                  : ""}
                . Bỏ kiểm sẽ xoá ghi chú kiểm tra hiện tại.
              </>
            ) : (
              <>
                Xác nhận bạn đã kiểm tra phiếu <b>{voucher.name}</b>. Có thể
                thêm ghi chú kiểm tra (tuỳ chọn).
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {isVerified && voucher.verified_note && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <div className="text-xs font-medium text-emerald-700 mb-0.5">
              Ghi chú kiểm tra
            </div>
            {voucher.verified_note}
          </div>
        )}

        {!isVerified && (
          <div className="space-y-2">
            <Label htmlFor="verify-note">Ghi chú kiểm tra (tuỳ chọn)</Label>
            <Textarea
              id="verify-note"
              placeholder="VD: đã đối chiếu sao kê / đã xác nhận với khách..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
        )}

        {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={verifyMutation.isPending}
          >
            Đóng
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={reconcileRequired || verifyMutation.isPending}
            className={
              isVerified
                ? "bg-zinc-600 hover:bg-zinc-700"
                : "bg-emerald-600 hover:bg-emerald-700"
            }
          >
            {verifyMutation.isPending
              ? "Đang lưu..."
              : isVerified
                ? "Bỏ kiểm"
                : "Xác nhận đã kiểm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default IncomeExpenseVerifyDialog;
