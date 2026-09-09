import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/hooks/useAccounts";
import { usePayReservationRefund } from "@/hooks/useReservationSettlement";
import { vnTodayISO } from "@/lib/vnDate";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

export function ReservationRefundDialog({ settlementId, amount, open, onOpenChange }: { settlementId: string | null; amount: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: accounts = [] } = useAccounts({ enabled: open });
  const pay = usePayReservationRefund();
  const [accountId, setAccountId] = useState("");
  const [paidOn, setPaidOn] = useState(vnTodayISO());
  const submit = () => settlementId && accountId && pay.mutate({ settlementId, accountId, paidOn }, {
    onSuccess: () => { toast.success(`Đã hoàn ${formatCurrency(amount)} cho khách`); onOpenChange(false); },
    onError: (error) => toast.error(error.message),
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Hoàn tiền cọc</DialogTitle><DialogDescription>Ghi sổ toàn bộ số còn phải hoàn: {formatCurrency(amount)}.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label>Sổ quỹ đã chi</Label><Select value={accountId} onValueChange={setAccountId}><SelectTrigger><SelectValue placeholder="Chọn sổ quỹ thật" /></SelectTrigger><SelectContent>{accounts.filter((a) => a.is_virtual === false).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div><div><Label>Ngày chi</Label><Input type="date" max={vnTodayISO()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></div><Button className="w-full" disabled={!accountId || pay.isPending} onClick={submit}>Tôi đã trả tiền cho khách</Button></div></DialogContent></Dialog>;
}
