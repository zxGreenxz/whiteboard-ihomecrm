import { useState } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { useReservationSettlementAudit } from "@/hooks/useReservationSettlement";
import { useReservationRefundEvidence } from "@/hooks/useReservationRefundEvidence";
import { StorageImage } from "@/components/ui/storage-image";
import { AttachmentLightbox } from "@/components/ui/attachment-lightbox";
import { formatCurrency } from "@/lib/utils";
import type { ReservationSettlement } from "@/lib/reservationSettlementRpc";

export function ReservationSettlementDetails({ settlement, onImageOpenChange }: {
  settlement: ReservationSettlement;
  onImageOpenChange?: (open: boolean) => void;
}) {
  const audit = useReservationSettlementAudit(settlement.id);
  const evidence = useReservationRefundEvidence(settlement.id);
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number | null }>({ urls: [], index: null });
  const reason = audit.data?.reason_code === "CHANGED_MIND" ? "Khách đổi ý"
    : audit.data?.reason_code === "NO_SHOW" ? "Không đến ký hợp đồng" : "";
  const changeIndex = (index: number | null) => {
    setLightbox((current) => ({ ...current, index }));
    onImageOpenChange?.(index !== null);
  };
  return <section className="my-4 min-w-0 space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm" aria-label="Thông tin xử lý bỏ cọc">
    <h3 className="font-semibold text-amber-900">Khách đã bỏ cọc</h3>
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
      <dt>Cọc ban đầu</dt><dd className="text-right">{formatCurrency(settlement.depositAmount)}</dd>
      <dt>Giữ lại thành doanh thu</dt><dd className="text-right font-semibold">{formatCurrency(settlement.retainedAmount)}</dd>
      <dt>Đã hoàn cho khách</dt><dd className="text-right text-emerald-700">{formatCurrency(settlement.refundedAmount)}</dd>
      {settlement.refundRemaining > 0 && <><dt>Còn phải hoàn</dt><dd className="text-right font-semibold text-amber-800">{formatCurrency(settlement.refundRemaining)}</dd></>}
    </dl>
    {settlement.refundAmount === 0 && <p>Giữ lại toàn bộ cọc, không hoàn tiền.</p>}
    {settlement.retainedAmount === 0 && <p>Hoàn toàn bộ cọc, không ghi nhận doanh thu.</p>}
    {audit.isLoading ? <p>Đang tải thông tin người xử lý…</p> : audit.error ? <p role="alert">Không tải được thông tin người xử lý và lý do.</p> : audit.data && <div className="space-y-1">
      <p>Ngày xử lý: {audit.data.settlementDate.split("-").reverse().join("/")} · Người xử lý: <b>{audit.data.actorName || "Chưa có tên"}</b></p>
      <p>Lý do: {[reason, audit.data.reason_text].filter(Boolean).join(" — ") || "Khác"}</p>
    </div>}
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <Link className="text-blue-700 underline" to={`/income-expense/voucher/${settlement.sourceVoucherId}`}>Phiếu thu cọc gốc</Link>
      {settlement.revenueVoucherId && <Link className="text-blue-700 underline" to={`/income-expense/voucher/${settlement.revenueVoucherId}`}>Phiếu doanh thu</Link>}
      {settlement.offsetVoucherId && <Link className="text-blue-700 underline" to={`/income-expense/voucher/${settlement.offsetVoucherId}`}>Phiếu cấn cọc</Link>}
    </div>
    {evidence.isLoading ? <p>Đang tải chứng từ hoàn tiền…</p> : evidence.error ? <p role="alert">Không tải được chứng từ hoàn tiền. <button type="button" className="underline" onClick={() => void evidence.refetch()}>Thử lại</button></p> : evidence.data?.map((refund) => <div key={refund.id} className="space-y-2 border-t border-amber-200 pt-2">
      <p><Link className="text-blue-700 underline" to={`/income-expense/voucher/${refund.id}`}>Phiếu hoàn tiền {refund.code || ""}</Link> · {refund.voucher_date.split("-").reverse().join("/")}
        {(refund.approval_status !== "APPROVED" || refund.posting_status !== "POSTED") && <span className="ml-1 font-medium text-amber-800">(Đã hoàn tác / chưa ghi sổ)</span>}</p>
      {!!refund.attachments?.length && <div className="flex flex-wrap gap-2">{refund.attachments.map((url, index) => <button type="button" key={`${index}:${url}`} className="h-20 w-20 overflow-hidden rounded border bg-white" aria-label={`Xem chứng từ hoàn tiền ${index + 1}`}
        onClick={() => { setLightbox({ urls: refund.attachments ?? [], index }); onImageOpenChange?.(true); }}>
        {/\.pdf(?:\?|$)/i.test(url) ? <FileText className="mx-auto h-8 w-8" /> : <StorageImage value={url} alt={`Chứng từ hoàn tiền ${index + 1}`} className="h-full w-full object-cover" />}
      </button>)}</div>}
    </div>)}
    <AttachmentLightbox attachments={lightbox.urls} index={lightbox.index} onIndexChange={changeIndex} />
  </section>;
}
