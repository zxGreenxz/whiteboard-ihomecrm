// "Sức khoẻ giao thông báo" — mục D7: cho người có `settings.view` thấy kênh push có đang câm
// không (NOTIF-SETTINGS-3: production từng 0 thiết bị active suốt 16 ngày mà không màn nào
// báo), hàng chờ có kẹt không, và thông báo nào không có người nhận (no_recipient_log).
// Chỉ đọc — `get_notification_delivery_health_v1(p_organization_id)`.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingState } from "@/components/loading/LoadingState";
import { Activity, AlertTriangle, Info, RefreshCw } from "lucide-react";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { isMissingRpcError, isPermissionError } from "@/lib/notifications/settingsRpc";
import { assessDeliveryQueue, noRecipientLabel, pushOutcomeLabel, type DrainProblem } from "@/lib/notifications/settingsDisplay";
import { NOTIFICATION_EVENT_LABELS, useNotificationDeliveryHealth } from "@/hooks/useNotificationSettings";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN") : "Chưa có");

/** Câu cảnh báo khi CHÍNH lượt gửi định kỳ có dấu hiệu hỏng (assessDeliveryQueue). */
function drainProblemText(p: DrainProblem): string {
  switch (p.kind) {
    case "error":
      return `Lượt gửi định kỳ gần nhất báo lỗi: ${p.message}. Lượt gửi có thể đang lỗi.`;
    case "stale":
      return `Lượt gửi định kỳ thành công gần nhất cách đây ${p.minutes} phút (lúc ${fmt(p.since)}), trong khi lượt chạy mỗi 15 phút. Lượt gửi có thể đang lỗi.`;
    case "never-ok":
      return "Chưa có lượt gửi định kỳ nào thành công. Lượt gửi có thể đang lỗi.";
  }
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export default function NotificationDeliveryHealthCard({ organizationId }: { organizationId: string | null }) {
  const health = useNotificationDeliveryHealth(organizationId, true);
  const h = health.data;

  const danhGia = h ? assessDeliveryQueue(h) : null;
  const lifecycleStates = h ? Object.entries(h.lifecycle.pushStates) : [];
  const logOutcomes = h ? Object.entries(h.pushLog7d).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Sức khoẻ giao thông báo
        </CardTitle>
        <CardDescription>Số liệu 7 ngày gần nhất của công ty đang chọn. Chỉ đọc.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {health.isLoading ? (
          <LoadingState label="sức khoẻ giao thông báo" variant="cards" rows={4} onRetry={() => void health.refetch()} />
        ) : health.isError || !h ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{isMissingRpcError(health.error)
              ? "Máy chủ chưa có số liệu sức khoẻ thông báo. Mục này sẽ dùng được sau khi máy chủ cập nhật."
              : isPermissionError(health.error)
                ? "Tài khoản của bạn không có quyền xem số liệu này."
                : actionErrorMessage(health.error, "Chưa tải được số liệu sức khoẻ thông báo")}</p>
            {!isMissingRpcError(health.error) && !isPermissionError(health.error) && (
              <Button variant="outline" size="sm" onClick={() => void health.refetch()}>Tải lại</Button>
            )}
          </div>
        ) : (
          <>
            {h.activeDevices === 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Chưa có thiết bị nào đang nhận thông báo đẩy trong công ty. Mọi thông báo chỉ nằm trong
                  chuông/Bản tin — nhắc thành viên bật ở "Thiết bị này".
                </AlertDescription>
              </Alert>
            )}
            {danhGia?.drainProblem && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{drainProblemText(danhGia.drainProblem)}</AlertDescription>
              </Alert>
            )}
            {danhGia?.queueNote?.kind === "stuck-eligible" && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Có thông báo đẩy đủ điều kiện gửi đã chờ {danhGia.queueNote.minutes} phút (từ {fmt(danhGia.queueNote.since)}).
                </AlertDescription>
              </Alert>
            )}
            {danhGia?.queueNote?.kind === "old-maybe-quiet" && (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                Có thông báo đẩy chờ gửi từ {fmt(danhGia.queueNote.since)} — có thể đang hoãn vì giờ yên.
              </p>
            )}
            {!!danhGia?.deferredQuiet && (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {danhGia.deferredQuiet} thông báo đang hoãn vì giờ yên — sẽ gửi khi hết giờ yên.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Thành viên có thiết bị" value={`${h.membersWithDevice}/${h.membersTotal}`} />
              <Stat label="Thiết bị đang nhận" value={h.activeDevices} />
              <Stat label="Đang chờ gửi" value={h.queue.queued} hint={h.queue.sending ? `${h.queue.sending} đang gửi` : undefined} />
              <Stat
                label="Lượt gửi gần nhất"
                value={h.lastDrainAt ? new Date(h.lastDrainAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "—"}
                hint={h.lastDrainAt
                  ? `${new Date(h.lastDrainAt).toLocaleDateString("vi-VN")}${danhGia?.latestDrainFailed ? " · lượt này lỗi" : ""}`
                  : "Chưa chạy"}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Đã đẩy (7 ngày)" value={h.last7d.sent} />
              <Stat label="Không có thiết bị" value={h.last7d.noDevice} />
              <Stat label="Lỗi gửi" value={h.last7d.failed} />
              <Stat label="Bỏ qua" value={h.last7d.skipped} hint="Đã đọc hoặc đã tắt" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1 text-sm">
                <p className="font-medium">Kết quả gửi (7 ngày)</p>
                {logOutcomes.length === 0 ? <p className="text-muted-foreground">Chưa có lượt gửi.</p> : (
                  <ul className="space-y-0.5">
                    {logOutcomes.map(([outcome, n]) => (
                      <li key={outcome} className="flex justify-between gap-3"><span>{pushOutcomeLabel(outcome).label}</span><span className="tabular-nums">{n}</span></li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-1 text-sm">
                {/* Lane nhắc việc máy chủ: trả phòng (NOTICE/TURNOVER/EXIT) + hoá đơn, HĐ hết hạn, thiếu cọc (171251). */}
                <p className="font-medium">Nhắc việc từ máy chủ</p>
                {lifecycleStates.length === 0 ? <p className="text-muted-foreground">Chưa có lượt nhắc.</p> : (
                  <ul className="space-y-0.5">
                    {lifecycleStates.map(([state, n]) => (
                      <li key={state} className="flex justify-between gap-3"><span>{pushOutcomeLabel(state).label}</span><span className="tabular-nums">{n}</span></li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">Gửi thành công gần nhất: {fmt(h.lifecycle.lastSuccessAt)}</p>
              </div>
            </div>

            <div className="space-y-1 text-sm">
              <p className="font-medium">Thông báo không có người nhận (7 ngày)</p>
              {h.noRecipient7d.length === 0 ? <p className="text-muted-foreground">Không có.</p> : (
                <ul className="space-y-0.5">
                  {h.noRecipient7d.map((row) => {
                    const nhan = noRecipientLabel(row, NOTIFICATION_EVENT_LABELS);
                    return (
                      <li key={`${row.event}-${row.reason}`} className="flex flex-wrap justify-between gap-x-3">
                        <span>{nhan.event} · {nhan.reason}</span><span className="tabular-nums">{row.n}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">Số liệu lúc {fmt(h.generatedAt)}</span>
              <Button variant="ghost" size="sm" onClick={() => void health.refetch()} disabled={health.isFetching}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Tải lại số liệu
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
