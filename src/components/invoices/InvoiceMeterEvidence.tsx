import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readDocumentEvidence } from '@/lib/meter-capture/service';
import { MeterEvidenceThumb } from '@/components/meter-readings/MeterEvidenceThumb';
import { Button } from '@/components/ui/button';

/** Only internal detail views import this component; invoice/print DTOs never carry media refs. */
export function InvoiceMeterEvidence({ invoiceId }: { invoiceId: string }) {
  const { selectedOrganizationId: orgId } = useOrganization();
  const [open, setOpen] = useState(false);
  const evidence = useQuery({
    queryKey: ['invoice-meter-evidence', orgId, invoiceId],
    queryFn: () => { if (!orgId) throw new Error('Chưa chọn tổ chức.'); return readDocumentEvidence(orgId, invoiceId); },
    enabled: open && !!orgId && !!invoiceId,
    staleTime: 60_000,
    retry: false,
  });
  return <section className="rounded-xl border bg-card p-4 space-y-3 print:hidden" aria-label="Chứng cứ chỉ số nội bộ">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Chứng cứ chỉ số · Nội bộ</h3><Button type="button" variant="outline" size="sm" onClick={() => setOpen(value => !value)}>{open ? 'Thu gọn' : 'Xem ảnh / clip đồng hồ'}</Button></div>
    {open && <>
      {!orgId ? <p role="alert" className="text-sm text-destructive">Chọn tổ chức để xem chứng cứ.</p>
        : evidence.isPending ? <p role="status" className="text-sm text-muted-foreground">Đang tải chứng cứ đã gắn với hóa đơn…</p>
        : evidence.isError ? <p role="alert" className="text-sm text-destructive">Không tải được chứng cứ của hóa đơn. <button type="button" className="underline" onClick={() => void evidence.refetch()}>Thử lại</button></p>
        : evidence.data?.length ? <div className="space-y-3">{evidence.data.map((row, index) => <div key={`${row.meterId}:${index}`} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
          <span className="w-full font-medium">{row.meterName}</span>
          <span>Số đầu: <strong>{Number(row.previousReading).toLocaleString('vi-VN')}</strong></span><MeterEvidenceThumb captureId={row.startCaptureId} label={`Ảnh số đầu ${row.meterName}`} />
          <span>→</span><span>Số cuối: <strong>{Number(row.currentReading).toLocaleString('vi-VN')}</strong></span><MeterEvidenceThumb captureId={row.endCaptureId} label={`Ảnh số cuối ${row.meterName}`} />
        </div>)}</div>
        : <p className="text-sm text-muted-foreground">Hóa đơn này chưa có chỉ số liên kết ảnh/clip.</p>}
      <p className="text-xs text-muted-foreground">Ảnh và clip phục vụ đối chiếu nội bộ, không xuất hiện trên bản in hoặc trang hóa đơn của khách.</p>
    </>}
  </section>;
}
