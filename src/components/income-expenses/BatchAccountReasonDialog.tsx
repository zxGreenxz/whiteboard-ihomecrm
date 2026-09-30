import {focusFirstError} from '@/lib/formErrors';
// Đổi sổ quỹ cả đợt = mỗi phiếu con một lần sửa có lưu vết, đổi từ sổ này sang
// sổ khác nên máy chủ bắt lý do (≥ 8 ký tự). Hộp này hỏi lý do MỘT lần cho cả đợt.

import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REVISION_REASON_MAX, REVISION_REASON_MIN } from "@/lib/incomeExpenseRevision";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromName: string | null;
  toName: string | null;
  voucherCount: number;
  pending: boolean;
  onConfirm: (reason: string) => void;
  error?:string|null;
  blocked?:boolean;
  completedIds?:readonly string[];
}

export default function BatchAccountReasonDialog({
  open,
  onOpenChange,
  fromName,
  toName,
  voucherCount,
  pending,
  onConfirm, error, blocked=false,completedIds=[],
}: Props) {
  const [reason, setReason] = useState("");
  const [reasonError,setReasonError]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {setReason("");setReasonError(null);}
  }, [open]);
  const ok = reason.trim().length >= REVISION_REASON_MIN;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent ref={root}>
        <AlertDialogHeader>
          <AlertDialogTitle>Đổi sổ quỹ cả đợt</AlertDialogTitle>
          <AlertDialogDescription>
            Chuyển {voucherCount} phiếu từ sổ <b>{fromName ?? "—"}</b> sang sổ{" "}
            <b>{toName ?? "—"}</b>. Mỗi phiếu được lưu thành một lần sửa (ai sửa,
            lúc nào, lý do) để người duyệt xem. Chỉ làm được khi mọi phiếu còn Chờ
            duyệt.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="batch-account-reason">Lý do đổi sổ *</Label>
          <Textarea
            name="reason" aria-invalid={!!reasonError} aria-describedby={reasonError?"batch-reason-error":undefined}
            id="batch-account-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REVISION_REASON_MAX}
            rows={2}
            placeholder="Vì sao đổi sang sổ khác?"
          />
          {reasonError&&<p id="batch-reason-error" role="alert" className="text-xs text-destructive">{reasonError}</p>}
          <p className="text-xs text-muted-foreground">Ít nhất {REVISION_REASON_MIN} ký tự.</p>
        </div>
        {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
        {completedIds.map(id=><a key={id} className="text-sm underline" href={`/income-expense/voucher/${id}`}>Mở phiếu đã đổi sổ {id}</a>)}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Không đổi</AlertDialogCancel>
          <AlertDialogAction
            disabled={blocked || pending}
            onClick={(e) => {
              e.preventDefault();
              if(!ok){const message=`Nhập lý do đổi sổ từ ${REVISION_REASON_MIN} đến ${REVISION_REASON_MAX} ký tự.`;setReasonError(message);void focusFirstError({reason:message},{root:root.current});return;}
              setReasonError(null);onConfirm(reason.trim());
            }}
          >
            {pending ? "Đang đổi…" : "Đổi sổ"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
