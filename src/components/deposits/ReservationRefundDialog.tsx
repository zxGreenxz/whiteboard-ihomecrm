import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { reservationRefundPaymentSchema, type ReservationRefundPaymentValues } from "@/lib/reservationSettlementForm";

export function ReservationRefundDialog({ settlementId, amount, open, onOpenChange }: { settlementId: string | null; amount: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: accounts = [] } = useCustodianCashbooksV2(open);
  const pay = usePayReservationRefund();
  const form = useForm<ReservationRefundPaymentValues>({ resolver: zodResolver(reservationRefundPaymentSchema), defaultValues: { accountId: "", paidOn: vnTodayISO() } });
  const accountId = form.watch("accountId");
  const [confirmedPaid, setConfirmedPaid] = useState(false);
  useEffect(() => {
    if (!open) return;
    form.reset({ accountId: "", paidOn: vnTodayISO() }); setConfirmedPaid(false);
  }, [open, settlementId]);
  const submit = form.handleSubmit(({ accountId, paidOn }) => settlementId && pay.mutate({ settlementId, accountId, paidOn }, {
    onSuccess: (result) => {
      if (result.refundState !== "PAID" || result.refundRemaining !== 0) {
        toast.error("Khoản hoàn vẫn đang chờ. Hãy tải lại và kiểm tra phiếu chi.");
        return;
      }
      toast.success(`Đã hoàn ${formatCurrency(amount)} cho khách`); onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  }));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Hoàn tiền cọc</DialogTitle><DialogDescription>Ghi sổ toàn bộ số còn phải hoàn: {formatCurrency(amount)}.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="reservation-pay-account">Sổ quỹ đã chi</Label><select id="reservation-pay-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm" {...form.register("accountId")}><option value="">Chọn sổ quỹ bạn đang giữ</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>{accounts.length === 0 && <p className="text-sm text-amber-700">Bạn cần là Người giữ ít nhất một sổ quỹ để hoàn tiền.</p>}<div><Label htmlFor="reservation-refund-paid-on">Ngày chi</Label><Input id="reservation-refund-paid-on" type="date" max={vnTodayISO()} {...form.register("paidOn")} /></div><label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmedPaid} onCheckedChange={(value) => setConfirmedPaid(value === true)} aria-label="Xác nhận đã trả toàn bộ tiền hoàn" />Tôi xác nhận đã trả toàn bộ tiền hoàn cho khách.</label><Button className="w-full" disabled={!accountId || !confirmedPaid || pay.isPending} onClick={submit}>Ghi nhận hoàn tiền</Button></div></DialogContent></Dialog>;
}
