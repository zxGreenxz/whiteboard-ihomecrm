import { focusFirstError } from "@/lib/formErrors";
import { reservationSettlementErrorMessage } from "@/lib/reservationSettlementRpc";
import { voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { useEffect, useRef, useState } from "react";
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
import { ReservationRefundAttachments } from "./ReservationRefundAttachments";

export function ReservationRefundDialog({ settlementId, amount, open, onOpenChange }: { settlementId: string | null; amount: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const accountsQuery = useCustodianCashbooksV2(open);
  const accounts = accountsQuery.data ?? [];
  const pay = usePayReservationRefund();
  const form = useForm<ReservationRefundPaymentValues>({ shouldFocusError: false, resolver: zodResolver(reservationRefundPaymentSchema), defaultValues: { accountId: "", paidOn: vnTodayISO() } });
  const accountId = form.watch("accountId");
  const [confirmedPaid, setConfirmedPaid] = useState(false);
  const formRoot = useRef<HTMLDivElement>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { setSubmitError(null); setUncertain(false); }, [settlementId]);
  const refundAttachments = form.watch("refundAttachments") ?? [];
  useEffect(() => {
    if (!open) return;
    form.reset({ accountId: "", paidOn: vnTodayISO(), refundAttachments: [] }); setConfirmedPaid(false);
  }, [open, settlementId]);
  const submit = form.handleSubmit(({ accountId, paidOn, refundAttachments }) => settlementId && !uncertain && !accountsQuery.isError && !accountsQuery.isLoading && !uploading && !pay.isPending && pay.mutate({ settlementId, accountId, paidOn, refundAttachments }, {
    onSuccess: (result) => {
      if (result.refundState !== "PAID" || result.refundRemaining !== 0) {
        toast.error("Khoản hoàn vẫn đang chờ. Hãy tải lại và kiểm tra phiếu chi.");
        return;
      }
      toast.success(`Đã hoàn ${formatCurrency(amount)} cho khách`); onOpenChange(false);
    },
    onError: (error) => { const message = reservationSettlementErrorMessage(error); setSubmitError(message); if (voucherOutcomeUnknown(error)) setUncertain(true); toast.error(message); },
  }), (errors) => void focusFirstError(errors, { root: formRoot.current, order: ["accountId", "paidOn"] }));
  return <Dialog open={open} onOpenChange={(next) => { if (!uploading && !pay.isPending) onOpenChange(next); }}><DialogContent ref={formRoot} className="max-w-md max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>Hoàn tiền cọc</DialogTitle><DialogDescription>Ghi sổ toàn bộ số còn phải hoàn: {formatCurrency(amount)}.</DialogDescription></DialogHeader>
    {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
    {accountsQuery.isError && <div role="alert" className="text-sm text-destructive"><p>Chưa tải được sổ quỹ hoàn tiền. Tải lại danh sách trước khi ghi nhận.</p><Button variant="outline" onClick={() => void accountsQuery.refetch()}>Tải lại sổ quỹ</Button></div>}
    <fieldset className="space-y-4" disabled={uploading || pay.isPending}>
      <div><Label htmlFor="reservation-pay-account">Sổ quỹ đã chi</Label><select id="reservation-pay-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm aria-[invalid=true]:border-destructive" aria-invalid={!!form.formState.errors.accountId} aria-describedby={form.formState.errors.accountId ? "accountId-error" : undefined} {...form.register("accountId")}><option value="">Chọn sổ quỹ bạn đang giữ</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>{form.formState.errors.accountId && <p id="accountId-error" role="alert" className="text-sm text-destructive">{form.formState.errors.accountId?.message}</p>}</div>
      {!accountsQuery.isError && !accountsQuery.isLoading && accounts.length === 0 && <p className="text-sm text-amber-700">Bạn cần là Người giữ ít nhất một sổ quỹ để hoàn tiền.</p>}
      <div><Label htmlFor="reservation-refund-paid-on">Ngày chi</Label><Input id="reservation-refund-paid-on" type="date" max={vnTodayISO()} aria-invalid={!!form.formState.errors.paidOn} aria-describedby={form.formState.errors.paidOn ? "paidOn-error" : undefined} {...form.register("paidOn")} />{form.formState.errors.paidOn && <p id="paidOn-error" role="alert" className="text-sm text-destructive">{form.formState.errors.paidOn?.message}</p>}</div>
      <ReservationRefundAttachments attachments={refundAttachments} onChange={(urls) => form.setValue("refundAttachments", urls, { shouldDirty: true })} disabled={pay.isPending} onUploadingChange={setUploading} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmedPaid} onCheckedChange={(value) => setConfirmedPaid(value === true)} aria-label="Xác nhận đã trả toàn bộ tiền hoàn" />Tôi xác nhận đã trả toàn bộ tiền hoàn cho khách.</label>
      <Button className="w-full" disabled={uncertain || accountsQuery.isError || accountsQuery.isLoading || !confirmedPaid || uploading || pay.isPending} onClick={submit}>Ghi nhận hoàn tiền</Button>
    </fieldset>
  </DialogContent></Dialog>;
}
