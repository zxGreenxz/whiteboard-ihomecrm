import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useCustodianCashbooksV2 } from "@/hooks/income-expenses/financeV2Mutations";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { can } from "@/lib/permissions";
import { vnTodayISO } from "@/lib/vnDate";
import { formatCurrency } from "@/lib/utils";
import { calculateReservationSplit, reservationSettlementFormSchema, type ReservationSettlementFormValues } from "@/lib/reservationSettlementForm";
import { useReservationSettlementPreview, useSettleReservationDeposit } from "@/hooks/useReservationSettlement";
import { toast } from "sonner";
import { ReservationRefundAttachments } from "./ReservationRefundAttachments";

export function ReservationSettlementDialog({ voucherId, open, onOpenChange }: {
  voucherId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const roomBlockerText = (blocker: string) => ({
    ROOM_UNAVAILABLE: "phòng đang ở trạng thái không thể trả trống",
    ACTIVE_CONTRACT: "phòng còn hợp đồng hiệu lực",
    OTHER_DEPOSIT: "phòng còn khoản cọc khác",
    UNRELATED_HOLD: "phòng còn lượt giữ chỗ khác",
  } as Record<string, string>)[blocker] ?? "phòng còn ràng buộc khác";
  const preview = useReservationSettlementPreview(voucherId, open);
  const settle = useSettleReservationDeposit();
  const { data: realAccounts = [] } = useCustodianCashbooksV2(open);
  const { data: perms } = useMyPermissions();
  const hasSettlementPermission = can(perms, "deposits", "refund") && can(perms, "income_expenses", "approve");
  const form = useForm<ReservationSettlementFormValues>({ resolver: zodResolver(reservationSettlementFormSchema), defaultValues: { depositAmount: 1, refundAmount: 0, refundMode: "NONE", refundAccountId: null, reasonCode: "CHANGED_MIND", reasonText: "", settlementDate: vnTodayISO() } });
  const refundAmount = form.watch("refundAmount");
  const refundMode = form.watch("refundMode");
  const accountId = form.watch("refundAccountId");
  const reasonCode = form.watch("reasonCode");
  const [confirmedPaid, setConfirmedPaid] = useState(false);
  const [uploading, setUploading] = useState(false);
  const refundAttachments = form.watch("refundAttachments") ?? [];

  useEffect(() => {
    if (!open) return;
    form.reset({ depositAmount: preview.data?.depositAmount ?? 1, refundAmount: 0, refundMode: "NONE", refundAccountId: null, reasonCode: "CHANGED_MIND", reasonText: "", settlementDate: vnTodayISO(), refundAttachments: [] });
    setConfirmedPaid(false);
  }, [open, voucherId, preview.data?.depositAmount]);

  useEffect(() => {
    if (refundAmount === 0) form.setValue("refundMode", "NONE");
    else if (refundMode === "NONE") form.setValue("refundMode", preview.data?.canRefundNow ? "NOW" : "LATER");
  }, [refundAmount, preview.data?.canRefundNow, refundMode]);

  const split = useMemo(() => {
    if (!preview.data || preview.data.depositAmount <= 0) return null;
    if (!Number.isSafeInteger(refundAmount) || refundAmount < 0 || refundAmount > preview.data.depositAmount) return null;
    return calculateReservationSplit(preview.data.depositAmount, refundAmount);
  }, [preview.data, refundAmount]);

  const submit = form.handleSubmit((values) => {
    if (!voucherId || !preview.data || uploading || settle.isPending) return;
    settle.mutate({
      voucherId, refundAmount: values.refundAmount, refundMode: values.refundMode, settlementDate: values.settlementDate, reasonCode: values.reasonCode,
      reasonText: values.reasonText.trim(), refundAccountId: values.refundMode === "NOW" ? values.refundAccountId : null,
      basisFingerprint: preview.data.fingerprint,
      refundAttachments: values.refundMode === "NOW" ? values.refundAttachments ?? [] : [],
    }, { onSuccess: (result) => {
      toast.success(`Đã ghi nhận doanh thu ${formatCurrency(result.retainedAmount)}${result.refundRemaining ? ` · Chờ hoàn ${formatCurrency(result.refundRemaining)}` : ""}`);
      if (!result.roomReleased) toast.info(`Phòng chưa thể trả trống vì ${roomBlockerText(result.roomBlockers[0])}.`);
      onOpenChange(false);
    }, onError: (error) => toast.error(error.message) });
  }, (errors) => toast.error(Object.values(errors)[0]?.message || "Kiểm tra lại thông tin"));

  const blockerMessage = preview.data?.blockers[0] ? ({
    NOT_RECEIVED: "Phiếu chưa có bằng chứng tiền đã vào quỹ.", ALREADY_USED: "Phiếu đã được dùng cho nghiệp vụ khác.",
    SOURCE_CHANGED: "Phiếu đã thay đổi. Hãy tải lại trước khi xử lý.", PERMISSION_DENIED: "Bạn chưa đủ quyền xử lý phiếu này.",
    PERIOD_LOCKED: "Ngày xử lý nằm trong kỳ đã khóa.", DEPOSIT_CLASS_MISMATCH: "Hạng mục cọc chưa thống nhất, cần đối chiếu trước.",
  } as const)[preview.data.blockers[0]] : null;

  return <Dialog open={open} onOpenChange={(next) => { if (!uploading && !settle.isPending) onOpenChange(next); }}><DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>Xử lý bỏ cọc</DialogTitle><DialogDescription>Chốt phần giữ lại thành doanh thu và phần cần hoàn cho khách.</DialogDescription></DialogHeader>
    {preview.isLoading ? <Skeleton className="h-48 w-full" /> : preview.error ? <Alert variant="destructive"><AlertDescription>Không tải được số tiền đã đối chiếu. {preview.error.message}</AlertDescription></Alert> : preview.data && <div className="space-y-4">
      <div className="rounded-md bg-muted p-3 text-sm"><b>{preview.data.voucherCode || "Phiếu giữ chỗ"}</b><div>{preview.data.payerName || "—"} · {preview.data.buildingName || "—"}{preview.data.roomName ? ` / ${preview.data.roomName}` : ""}</div><div className="mt-2 text-base font-bold">Cọc thực nhận: {formatCurrency(preview.data.depositAmount)}</div></div>
      {blockerMessage && <Alert variant="destructive"><AlertDescription>{blockerMessage}</AlertDescription></Alert>}
      {preview.data.roomBlockers.length > 0 && <Alert><AlertDescription>Cọc vẫn được xử lý, nhưng phòng chưa thể trả trống vì {roomBlockerText(preview.data.roomBlockers[0])}.</AlertDescription></Alert>}
      {!hasSettlementPermission && <Alert><AlertDescription>Cần quyền Hoàn / bỏ cọc và Duyệt thu chi để xác nhận.</AlertDescription></Alert>}
      <fieldset disabled={uploading || settle.isPending} className="space-y-4">
      <div><Label htmlFor="reservation-refund-amount">Hoàn lại khách</Label><Input id="reservation-refund-amount" type="number" min={0} max={preview.data.depositAmount} step={1} {...form.register("refundAmount", { valueAsNumber: true })} /></div>
      <div className="rounded-md border p-3"><span className="text-muted-foreground">Giữ lại → doanh thu</span><b className="float-right">{split ? formatCurrency(split.retainedAmount) : "—"}</b></div>
      {refundAmount > 0 && <div><Label htmlFor="reservation-refund-mode">Cách hoàn</Label><select id="reservation-refund-mode" className="h-10 w-full rounded-md border bg-background px-3 text-sm" {...form.register("refundMode")}>{preview.data.canRefundNow && <option value="NOW">Hoàn ngay — tôi đã trả tiền cho khách</option>}<option value="LATER">Hoàn sau — ghi nhận phải trả</option></select>{!preview.data.canRefundNow && <p className="mt-1 text-xs text-muted-foreground">Bạn chưa có quyền thực chi; có thể ghi nhận Hoàn sau.</p>}</div>}
      {refundMode === "NOW" && <div><Label htmlFor="reservation-refund-account">Sổ quỹ đã chi</Label><select id="reservation-refund-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm" {...form.register("refundAccountId", { setValueAs: value => value || null })}><option value="">Chọn sổ quỹ</option>{realAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
      {refundMode === "NOW" && <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmedPaid} onCheckedChange={(value) => setConfirmedPaid(value === true)} aria-label="Xác nhận đã trả tiền cho khách" /><span>Tôi xác nhận đã trả tiền cho khách. Khoản hoàn được ghi nhận hôm nay, dù ngày xử lý doanh thu sớm hơn.</span></label>}
      {refundMode === "NOW" && <ReservationRefundAttachments attachments={refundAttachments} onChange={(urls) => form.setValue("refundAttachments", urls, { shouldDirty: true })} disabled={settle.isPending} onUploadingChange={setUploading} />}
      <div><Label htmlFor="reservation-settlement-date">Ngày xử lý</Label><Input id="reservation-settlement-date" type="date" min={preview.data.voucherDate} max={vnTodayISO()} {...form.register("settlementDate")} /></div>
      <div><Label htmlFor="reservation-reason-code">Lý do</Label><select id="reservation-reason-code" className="h-10 w-full rounded-md border bg-background px-3 text-sm" {...form.register("reasonCode")}><option value="CHANGED_MIND">Khách đổi ý</option><option value="NO_SHOW">Không đến ký hợp đồng</option><option value="OTHER">Khác</option></select></div>
      {reasonCode === "OTHER" && <div><Label htmlFor="reservation-reason-text">Nội dung lý do</Label><Input id="reservation-reason-text" {...form.register("reasonText")} /></div>}
      <Button className="w-full" disabled={!preview.data.canSettle || !hasSettlementPermission || !split || (refundMode === "NOW" && !confirmedPaid) || uploading || settle.isPending} onClick={submit}>Xác nhận xử lý</Button>
      </fieldset>
    </div>}
  </DialogContent></Dialog>;
}
