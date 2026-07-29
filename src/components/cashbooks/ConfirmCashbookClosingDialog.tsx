// Đợt 6 — XÁC NHẬN nhận bàn giao (bước của người NHẬN). Đây là chữ ký khoá kỳ.
//
// Số dư hệ thống được tính LẠI TƯƠI ngay lúc mở hộp thoại, không dùng lại con
// số người giao đã khai: nếu sổ đã trôi kể từ lúc đề nghị thì server sẽ từ chối,
// và người ký phải thấy điều đó TRƯỚC khi bấm chứ không phải sau.
//
// Ô "tôi đã đếm" bắt gõ lại số tiền thay vì tick một ô: tick là phản xạ, gõ lại
// con số là một hành động có ý thức — và server cũng đối chiếu đúng con số này
// với số người giao khai.

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  useCashbookBalanceAsOf, useConfirmCashbookClosing, useCancelCashbookClosing,
  type PendingClosure,
} from "@/hooks/useCashbookClosing";
import { parseMoneyInput, formatMoney as fmtVND, sameMoney } from "@/lib/moneyInput";


export interface ConfirmCashbookClosingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: PendingClosure | null;
}

export default function ConfirmCashbookClosingDialog({
  open, onOpenChange, request,
}: ConfirmCashbookClosingDialogProps) {
  const [counted, setCounted] = useState("");
  const [agreed, setAgreed] = useState(false);
  const confirmMut = useConfirmCashbookClosing();
  const cancelMut = useCancelCashbookClosing();

  const { data: freshSystem, isLoading: loadingFresh } = useCashbookBalanceAsOf(
    open ? request?.cashbook_id ?? null : null,
    request?.closed_through ?? null,
  );

  useEffect(() => {
    if (!open) { setCounted(""); setAgreed(false); }
  }, [open]);

  if (!request) return null;

  const countedNum = parseMoneyInput(counted);
  const declared = Number(request.counted_balance);
  // So theo ĐỒNG chứ không so === trên số dấu phẩy động: numeric(15,2) qua
  // jsonb có thể về dạng number hoặc string tuỳ đường, và 0.1+0.2 !== 0.3.
  const drifted = freshSystem !== null && freshSystem !== undefined
    && !sameMoney(freshSystem, request.system_balance);
  const matches = countedNum !== null && sameMoney(countedNum, declared);
  const canConfirm = matches && agreed && !drifted && !loadingFresh;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!confirmMut.isPending) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Xác nhận nhận bàn giao — {request.cashbook_name}</DialogTitle>
          <DialogDescription>
            {request.proposed_by_name ?? "Người giữ sổ"} đề nghị chốt sổ tới {request.closed_through}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Số dư theo sổ (tính lại lúc này)</span>
              <span className="tabular-nums">
                {loadingFresh ? "đang tính…" : fmtVND(freshSystem)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bên giao khai đã đếm</span>
              <span className="tabular-nums font-semibold">{fmtVND(declared)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Chênh lệch ghi vào biên bản</span>
              <span className="tabular-nums">{fmtVND(request.difference)}</span>
            </div>
            {request.note && (
              <p className="pt-1 text-muted-foreground">Ghi chú: {request.note}</p>
            )}
          </div>

          {drifted && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Sổ đã thay đổi kể từ lúc đề nghị (số dư giờ là {fmtVND(freshSystem)}, lúc đề nghị
              là {fmtVND(request.system_balance)}). Không ký được — hãy huỷ đề nghị này và
              đếm lại cùng nhau.
            </div>
          )}

          <div className="rounded-md border border-red-300 bg-red-50 p-3 space-y-1">
            <p className="text-sm font-semibold text-red-800 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Ký là khoá VĨNH VIỄN
            </p>
            <p className="text-sm text-red-800">
              Mọi phiếu có ngày ≤ {request.closed_through} sẽ không sửa, huỷ hay xoá được nữa,
              và không ai mở lại được — kể cả chủ tổ chức. Từ lúc này bạn chịu trách nhiệm về
              số tiền đã nhận.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="counted-confirm">Gõ lại số tiền BẠN vừa đếm được</Label>
            <Input
              id="counted-confirm" inputMode="numeric" value={counted}
              onChange={(e) => setCounted(e.target.value)}
              placeholder="Đếm tiền rồi nhập vào đây"
            />
            {countedNum !== null && !matches && (
              <p className="text-sm text-red-700">
                Khác số bên giao khai ({fmtVND(declared)}) — hai bên phải đếm lại cùng nhau.
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
            <span>Tôi đã đếm tiền mặt và xác nhận đã nhận đủ số trên.</span>
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={confirmMut.isPending || cancelMut.isPending}
            onClick={async () => {
              await cancelMut.mutateAsync({
                requestId: request.request_id,
                reason: "Người nhận từ chối / cần đếm lại",
              });
              onOpenChange(false);
            }}
          >
            Từ chối &amp; huỷ đề nghị
          </Button>
          <Button
            className="bg-red-600 hover:bg-red-700"
            disabled={!canConfirm || confirmMut.isPending}
            onClick={async () => {
              await confirmMut.mutateAsync({
                requestId: request.request_id,
                countedBalance: countedNum as number,
              });
              onOpenChange(false);
            }}
          >
            {confirmMut.isPending
              ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Đang chốt…</>)
              : "Ký nhận & khoá kỳ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
