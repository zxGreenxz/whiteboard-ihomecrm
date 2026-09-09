import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCustodianCashbooksV2 } from "@/hooks/income-expenses/financeV2Mutations";
import { usePayReservationRefund } from "@/hooks/useReservationSettlement";
import { vnTodayISO } from "@/lib/vnDate";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

export function ReservationRefundDialog({ settlementId, amount, open, onOpenChange }: { settlementId: string | null; amount: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: accounts = [] } = useCustodianCashbooksV2(open);
  const pay = usePayReservationRefund();
  const [accountId, setAccountId] = useState("");
  const [paidOn, setPaidOn] = useState(vnTodayISO());
  const [confirmedPaid, setConfirmedPaid] = useState(false);
  useEffect(() => {
    if (!open) return;
    setAccountId(""); setPaidOn(vnTodayISO()); setConfirmedPaid(false);
  }, [open, settlementId]);
  const submit = () => settlementId && accountId && pay.mutate({ settlementId, accountId, paidOn }, {
    onSuccess: (result) => {
      if (result.refundState !== "PAID" || result.refundRemaining !== 0) {
        toast.error("Khoản hoàn vẫn đang chờ. Hãy tải lại và kiểm tra phiếu chi.");
        return;
      }
      toast.success(`Đã hoàn ${formatCurrency(amount)} cho khách`); onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Hoàn tiền cọc</DialogTitle><DialogDescription>Ghi sổ toàn bộ số còn phải hoàn: {formatCurrency(amount)}.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="reservation-pay-account">Sổ quỹ đã chi</Label><select id="reservation-pay-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Chọn sổ quỹ bạn đang giữ</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>{accounts.length === 0 && <p className="text-sm text-amber-700">Bạn cần là Người giữ ít nhất một sổ quỹ để hoàn tiền.</p>}<div><Label htmlFor="reservation-refund-paid-on">Ngày chi</Label><Input id="reservation-refund-paid-on" type="date" max={vnTodayISO()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></div><label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmedPaid} onCheckedChange={(value) => setConfirmedPaid(value === true)} aria-label="Xác nhận đã trả toàn bộ tiền hoàn" />Tôi xác nhận đã trả toàn bộ tiền hoàn cho khách.</label><Button className="w-full" disabled={!accountId || !confirmedPaid || pay.isPending} onClick={submit}>Ghi nhận hoàn tiền</Button></div></DialogContent></Dialog>;
}
