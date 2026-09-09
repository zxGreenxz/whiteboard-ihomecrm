import { useEffect, useMemo, useState } from "react";
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
import { calculateReservationSplit, reservationSettlementFormSchema } from "@/lib/reservationSettlementForm";
import type { RefundMode, SettlementReason } from "@/lib/reservationSettlementRpc";
import { useReservationSettlementPreview, useSettleReservationDeposit } from "@/hooks/useReservationSettlement";
import { toast } from "sonner";

export function ReservationSettlementDialog({ voucherId, open, onOpenChange }: {
  voucherId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useReservationSettlementPreview(voucherId, open);
  const settle = useSettleReservationDeposit();
  const { data: realAccounts = [] } = useCustodianCashbooksV2(open);
  const { data: perms } = useMyPermissions();
  const hasSettlementPermission = can(perms, "deposits", "refund") && can(perms, "income_expenses", "approve");
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundMode, setRefundMode] = useState<RefundMode>("NONE");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<SettlementReason>("CHANGED_MIND");
  const [reasonText, setReasonText] = useState("");
  const [settlementDate, setSettlementDate] = useState(vnTodayISO());
  const [confirmedPaid, setConfirmedPaid] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRefundAmount(0); setRefundMode("NONE"); setAccountId(null);
    setReasonCode("CHANGED_MIND"); setReasonText(""); setSettlementDate(vnTodayISO()); setConfirmedPaid(false);
  }, [open, voucherId]);

  useEffect(() => {
    if (refundAmount === 0) setRefundMode("NONE");
    else if (refundMode === "NONE") setRefundMode(preview.data?.canRefundNow ? "NOW" : "LATER");
  }, [refundAmount, preview.data?.canRefundNow, refundMode]);

  const split = useMemo(() => {
    if (!preview.data) return null;
    try { return calculateReservationSplit(preview.data.depositAmount, refundAmount); }
    catch { return null; }
  }, [preview.data, refundAmount]);

  const submit = () => {
    if (!voucherId || !preview.data) return;
    const parsed = reservationSettlementFormSchema.safeParse({
      depositAmount: preview.data.depositAmount, refundAmount, refundMode,
      settlementDate, reasonCode, reasonText, refundAccountId: accountId,
    });
    if (!parsed.success) { toast.error(parsed.error.issues[0]?.message || "Kiểm tra lại thông tin"); return; }
    settle.mutate({
      voucherId, refundAmount, refundMode, settlementDate, reasonCode,
      reasonText: reasonText.trim(), refundAccountId: refundMode === "NOW" ? accountId : null,
      basisFingerprint: preview.data.fingerprint,
    }, { onSuccess: (result) => {
      toast.success(`Đã ghi nhận doanh thu ${formatCurrency(result.retainedAmount)}${result.refundRemaining ? ` · Chờ hoàn ${formatCurrency(result.refundRemaining)}` : ""}`);
      onOpenChange(false);
    }, onError: (error) => toast.error(error.message) });
  };

  const blockerMessage = preview.data?.blockers[0] ? ({
    NOT_RECEIVED: "Phiếu chưa có bằng chứng tiền đã vào quỹ.", ALREADY_USED: "Phiếu đã được dùng cho nghiệp vụ khác.",
    SOURCE_CHANGED: "Phiếu đã thay đổi. Hãy tải lại trước khi xử lý.", PERMISSION_DENIED: "Bạn chưa đủ quyền xử lý phiếu này.",
    PERIOD_LOCKED: "Ngày xử lý nằm trong kỳ đã khóa.", DEPOSIT_CLASS_MISMATCH: "Hạng mục cọc chưa thống nhất, cần đối chiếu trước.",
  } as const)[preview.data.blockers[0]] : null;

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>Xử lý bỏ cọc</DialogTitle><DialogDescription>Chốt phần giữ lại thành doanh thu và phần cần hoàn cho khách.</DialogDescription></DialogHeader>
    {preview.isLoading ? <Skeleton className="h-48 w-full" /> : preview.error ? <Alert variant="destructive"><AlertDescription>Không tải được số tiền đã đối chiếu. {preview.error.message}</AlertDescription></Alert> : preview.data && <div className="space-y-4">
      <div className="rounded-md bg-muted p-3 text-sm"><b>{preview.data.voucherCode || "Phiếu giữ chỗ"}</b><div>{preview.data.payerName || "—"} · {preview.data.buildingName || "—"}{preview.data.roomName ? ` / ${preview.data.roomName}` : ""}</div><div className="mt-2 text-base font-bold">Cọc thực nhận: {formatCurrency(preview.data.depositAmount)}</div></div>
      {blockerMessage && <Alert variant="destructive"><AlertDescription>{blockerMessage}</AlertDescription></Alert>}
      {!hasSettlementPermission && <Alert><AlertDescription>Cần quyền Hoàn / bỏ cọc và Duyệt thu chi để xác nhận.</AlertDescription></Alert>}
      <div><Label htmlFor="reservation-refund-amount">Hoàn lại khách</Label><Input id="reservation-refund-amount" type="number" min={0} max={preview.data.depositAmount} step={1} value={refundAmount} onChange={(e) => setRefundAmount(Number(e.target.value))} /></div>
      <div className="rounded-md border p-3"><span className="text-muted-foreground">Giữ lại → doanh thu</span><b className="float-right">{split ? formatCurrency(split.retainedAmount) : "—"}</b></div>
      {refundAmount > 0 && <div><Label htmlFor="reservation-refund-mode">Cách hoàn</Label><select id="reservation-refund-mode" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={refundMode} onChange={(event) => setRefundMode(event.target.value as RefundMode)}>{preview.data.canRefundNow && <option value="NOW">Hoàn ngay — tôi đã trả tiền cho khách</option>}<option value="LATER">Hoàn sau — ghi nhận phải trả</option></select>{!preview.data.canRefundNow && <p className="mt-1 text-xs text-muted-foreground">Bạn chưa có quyền thực chi; có thể ghi nhận Hoàn sau.</p>}</div>}
      {refundMode === "NOW" && <div><Label htmlFor="reservation-refund-account">Sổ quỹ đã chi</Label><select id="reservation-refund-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={accountId ?? ""} onChange={(event) => setAccountId(event.target.value || null)}><option value="">Chọn sổ quỹ</option>{realAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
      {refundMode === "NOW" && <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmedPaid} onCheckedChange={(value) => setConfirmedPaid(value === true)} aria-label="Xác nhận đã trả tiền cho khách" /><span>Tôi xác nhận đã trả tiền cho khách. Khoản hoàn được ghi nhận hôm nay, dù ngày xử lý doanh thu sớm hơn.</span></label>}
      <div><Label htmlFor="reservation-settlement-date">Ngày xử lý</Label><Input id="reservation-settlement-date" type="date" min={preview.data.voucherDate} max={vnTodayISO()} value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} /></div>
      <div><Label htmlFor="reservation-reason-code">Lý do</Label><select id="reservation-reason-code" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={reasonCode} onChange={(event) => setReasonCode(event.target.value as SettlementReason)}><option value="CHANGED_MIND">Khách đổi ý</option><option value="NO_SHOW">Không đến ký hợp đồng</option><option value="OTHER">Khác</option></select></div>
      {reasonCode === "OTHER" && <div><Label htmlFor="reservation-reason-text">Nội dung lý do</Label><Input id="reservation-reason-text" value={reasonText} onChange={(e) => setReasonText(e.target.value)} /></div>}
      <Button className="w-full" disabled={!preview.data.canSettle || !hasSettlementPermission || !split || (refundMode === "NOW" && !confirmedPaid) || settle.isPending} onClick={submit}>Xác nhận xử lý</Button>
    </div>}
  </DialogContent></Dialog>;
}
