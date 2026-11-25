import { FileText, ListFilter } from "lucide-react";
import { useState } from "react";
import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCameraAlertDeliveries, type CameraAlertScope } from "@/hooks/network-center/useCameraAlerts";
import {
  CAMERA_ALERT_CHANNEL_LABELS, CAMERA_ALERT_KIND_LABELS, CAMERA_ALERT_STATUS_FILTERS, cameraAlertFailure, deliveryStatusView,
  formatVnDateTime,
} from "@/lib/network-center/cameraAlertForm";
import type { CameraAlertDelivery, CameraAlertDeliveryStatus, CameraAlertRepository } from "@/lib/network-center/cameraContracts";

const ALL = "ALL";
const NO_LOG_PERMISSION = "Bạn không có quyền xem nhật ký gửi của công ty này.";

function buildingLabel(row: CameraAlertDelivery, buildingNames: Map<string, string>): string | null {
  if (row.buildingIds.length === 0) return null;
  const names = row.buildingIds.map((id) => buildingNames.get(id) ?? "Toà khác");
  return [...new Set(names)].join(", ");
}

/** Nhật ký gửi 7 ngày — nơi chủ đọc kết quả chạy thử 48 giờ (spec §6, D10). */
export function CameraAlertDeliveryLog({ scope, repository, buildingNames }: {
  scope: CameraAlertScope;
  repository?: CameraAlertRepository;
  buildingNames: Map<string, string>;
}) {
  const [status, setStatus] = useState<CameraAlertDeliveryStatus | null>(null);
  const [open, setOpen] = useState<CameraAlertDelivery | null>(null);
  const query = useCameraAlertDeliveries(scope, status, repository);
  const rows = [...new Map((query.data?.pages ?? []).flatMap((page) => page.items).map((row) => [row.id, row])).values()];

  return (
    <section className="nc-panel" aria-labelledby="camera-alert-log-title">
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">7 ngày gần nhất</p><h3 id="camera-alert-log-title">Nhật ký gửi</h3></div>
        <div className="nc-field nc-log-filter">
          <Label htmlFor="camera-alert-log-status"><ListFilter className="mr-1 inline h-4 w-4" aria-hidden="true" />Trạng thái</Label>
          <Select value={status ?? ALL} onValueChange={(value) => setStatus(value === ALL ? null : value as CameraAlertDeliveryStatus)}>
            <SelectTrigger id="camera-alert-log-status" aria-label="Lọc nhật ký theo trạng thái"><SelectValue /></SelectTrigger>
            <SelectContent className="network-center nc-select-content">
              <SelectItem value={ALL}>Tất cả trạng thái</SelectItem>
              {CAMERA_ALERT_STATUS_FILTERS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="nc-log-intro">Mỗi dòng là một tin Zalo hoặc một lượt chuông CRM. Ở chế độ chạy thử, nhật ký ghi “lẽ ra sẽ gửi gì”, kèm nguyên văn tin.</p>
      {query.isPending ? <LoadingState label="nhật ký gửi" variant="list" rows={4} /> : null}
      {query.isError && rows.length === 0 ? (
        <div className="nc-locked-note nc-display-note" role="alert">
          <p className="flex-1">{cameraAlertFailure(query.error, "tải nhật ký gửi", NO_LOG_PERMISSION).text}</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>Thử lại</Button>
        </div>
      ) : null}
      {query.isSuccess && rows.length === 0 ? (
        <p className="nc-empty-copy">{status ? "Không có tin nào ở trạng thái này trong 7 ngày qua." : "Chưa có tin nào trong 7 ngày qua."}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="nc-delivery-list" aria-label="Các tin đã ghi sổ">
          {rows.map((row) => {
            const view = deliveryStatusView(row);
            const where = buildingLabel(row, buildingNames);
            return (
              <li key={row.id} className="nc-delivery">
                <div className="nc-delivery-meta">
                  <time dateTime={row.createdAt}>{formatVnDateTime(row.createdAt)}</time>
                  <span>{CAMERA_ALERT_KIND_LABELS[row.kind]} · {CAMERA_ALERT_CHANNEL_LABELS[row.channel]}</span>
                </div>
                <div className="min-w-0">
                  <p className="nc-delivery-preview">{row.body}</p>
                  {where ? <small>Toà: {where}</small> : null}
                  {view.detail ? <small>{view.detail}</small> : null}
                </div>
                <div className="nc-delivery-actions">
                  <span className={`nc-status nc-status-${view.tone}`}>{view.label}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(row)} aria-label={`Xem nguyên văn tin lúc ${formatVnDateTime(row.createdAt)}`}>
                    <FileText className="mr-1 h-4 w-4" aria-hidden="true" />Xem nguyên văn
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.isError && rows.length > 0 ? <p className="nc-form-error m-4" role="alert">{cameraAlertFailure(query.error, "tải thêm nhật ký", NO_LOG_PERMISSION).text}</p> : null}
      {query.hasNextPage ? (
        <div className="p-4"><Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Đang tải…" : "Xem tin cũ hơn"}</Button></div>
      ) : null}
      <DeliveryDialog row={open} buildingNames={buildingNames} onClose={() => setOpen(null)} />
    </section>
  );
}

function DeliveryDialog({ row, buildingNames, onClose }: { row: CameraAlertDelivery | null; buildingNames: Map<string, string>; onClose: () => void }) {
  const view = row ? deliveryStatusView(row) : null;
  const where = row ? buildingLabel(row, buildingNames) : null;
  return (
    <Dialog open={row !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="network-center network-center-dialog nc-dialog nc-dialog-wide nc-dialog-fit">
        {row && view ? (
          <>
            <DialogHeader>
              <DialogTitle>{CAMERA_ALERT_KIND_LABELS[row.kind]} · {CAMERA_ALERT_CHANNEL_LABELS[row.channel]}</DialogTitle>
              <DialogDescription>{formatVnDateTime(row.createdAt)} · {view.label}{where ? ` · Toà: ${where}` : ""}</DialogDescription>
            </DialogHeader>
            <pre className="nc-message-body" aria-label="Nguyên văn tin">{row.body}</pre>
            {view.detail ? <p>{view.detail}</p> : null}
            {row.sentAt && row.status === "SENT" ? <p>Gửi lúc {formatVnDateTime(row.sentAt)}.</p> : null}
            {row.releasedAt ? <p>Đã đưa vào bản tin lúc {formatVnDateTime(row.releasedAt)}.</p> : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
