import {validateInputDrafts} from '@/lib/inputDraftValidation';
import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
// "Cấu hình công ty" — mục D7 của /account/notifications: bật/tắt từng họ cho TOÀN công ty
// đang chọn, ngưỡng tiền (chỉ E2/E3), giờ yên công ty.
//
// Chỉ hiện cho người có `settings.view`; sửa cần `settings.edit`. Server vẫn tự gate trong
// `get/set_notification_org_config_v2` — nút mờ ở đây chỉ là lịch sự, KHÔNG phải lớp bảo vệ.
//
// Theo CÔNG TY ĐANG CHỌN (v2 nhận `p_organization_id`) và hiện tên công ty ở tiêu đề: bản v1
// sửa ngầm công ty do current_admin_org_v1 chọn (NOTIF-SETTINGS-14). Lưu CHỈ họ/trường vừa đổi
// kèm `p_expected_updated_at`; người khác vừa sửa ⇒ PT409 ⇒ đọc lại, không đè (NOTIF-SETTINGS-8).

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Building2 } from "lucide-react";
import { LoadingState } from "@/components/loading/LoadingState";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { isMissingRpcError, isPermissionError } from "@/lib/notifications/settingsRpc";
import { QUIET_HOURS_LONG_THRESHOLD, formatHour, quietHoursLength } from "@/lib/notifications/settingsDisplay";
import {
  NotificationOrgConfigConflictError,
  NotificationSettingsReceiptError,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  ORG_MIN_AMOUNT_KEYS,
  diffOrgEvents,
  useNotificationOrgConfig,
  useSetNotificationOrgConfig,
  type NotificationEventConfig,
  type NotificationEventKey,
  type NotificationOrgConfig,
  type NotificationOrgEventMap,
} from "@/hooks/useNotificationSettings";
import { HourSelect } from "./HourSelect";

export default function NotificationOrgConfigCard({ organizationId, organizationName, canEdit }: {
  organizationId: string | null;
  /** Tên từ OrganizationContext — dùng khi máy chủ không trả `organization_name`. */
  organizationName?: string | null;
  canEdit: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useNotificationOrgConfig(organizationId);
  const save = useSetNotificationOrgConfig(organizationId);

  // Bản máy chủ mà bản nháp DỰA TRÊN: diff và `p_expected_updated_at` lấy từ đây, không lấy
  // từ lần đọc mới nhất — nếu máy chủ đổi trong lúc đang sửa thì PT409 phải nổ, không đè.
  const [base, setBase] = useState<NotificationOrgConfig | null>(null);
  const [events, setEvents] = useState<NotificationOrgEventMap | null>(null);
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(7);
  const [conflict, setConflict] = useState(false);
  // Đổi số này để ép đồng bộ lại bản nháp theo dữ liệu máy chủ mới nhất (sau PT409).
  const [resync, setResync] = useState(0);
  const dirty = useRef(false); const sourceOrg = useRef<string>(); const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    if (sourceOrg.current !== data.organizationId) { sourceOrg.current = data.organizationId; dirty.current = false; }
    if (dirty.current) return;
    setBase(data);
    setEvents(data.events);
    setQuietStart(data.quietStart);
    setQuietEnd(data.quietEnd);
  }, [data, resync]);

  const uncertain = save.error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(save.error);
  const readAfterUnknown = async () => {
    const result = await refetch();
    if (!result.isError && result.data) { save.reset(); dirty.current = false; setResync(n => n + 1); }
  };

  const locked = uncertain || isError || !canEdit || !base || save.isPending;
  const changes = base && events ? diffOrgEvents(base.events, events) : {};
  const hasChanges = !!base && (Object.keys(changes).length > 0 || quietStart !== base.quietStart || quietEnd !== base.quietEnd);
  const quietLength = quietHoursLength(quietStart, quietEnd);

  const setEvent = (k: NotificationEventKey, patch: Partial<NotificationEventConfig>) => {
    dirty.current = true;
    setConflict(false);
    setEvents((prev) => {
      const current = prev?.[k];
      return prev && current ? { ...prev, [k]: { ...current, ...patch } } : prev;
    });
  };

  const onSave = () => {
    if (locked || !base || !events || !hasChanges || !validateInputDrafts(root.current)) return;
    save.mutate(
      { events: changes, quietStart, quietEnd, expectedUpdatedAt: base.updatedAt },
      {
        // Ép đồng bộ: hiệu ứng theo `data` có thể đã chạy khi bản nháp còn "dirty" và bỏ qua
        // phong bì mới — không resync thì `base` kẹt bản cũ và lần lưu sau nổ PT409 oan.
        onSuccess: () => { dirty.current = false; setConflict(false); setResync(n => n + 1); },
        onError: (e) => {
          // Hook đã đọc lại; bỏ bản nháp cũ để không gửi lại đè thay đổi của người kia.
          if (e instanceof NotificationOrgConfigConflictError) { dirty.current = false; setConflict(true); setResync(n => n + 1); }
        },
      },
    );
  };

  const name = data?.organizationName ?? organizationName ?? null;

  if (isError) {
    const message = isMissingRpcError(error)
      ? "Máy chủ chưa hỗ trợ cấu hình thông báo theo công ty. Mục này sẽ dùng được sau khi máy chủ cập nhật."
      : isPermissionError(error)
        ? "Tài khoản của bạn không có quyền xem cấu hình thông báo của công ty này."
        : actionErrorMessage(error, "Chưa tải được cấu hình thông báo của công ty. Chưa xác định được trạng thái các công tắc");
    return <Card><CardContent className="space-y-3 p-4"><p role="alert">{message}</p>{!isMissingRpcError(error) && !isPermissionError(error) && <Button variant="outline" onClick={() => void refetch()}>Tải lại cấu hình</Button>}</CardContent></Card>;
  }

  return (
    <Card ref={root}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Building2 className="h-5 w-5" />
          Cấu hình công ty{name ? ` · ${name}` : ""}
        </CardTitle>
        <CardDescription>
          Bật/tắt từng loại thông báo cho TOÀN công ty. Đây là van tổng — tắt ở đây thì không ai
          nhận, kể cả người đã bật trong "Loại thông báo" của họ.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {uncertain && <div role="alert" className="space-y-2 rounded-md border border-amber-400 p-3 text-sm">
          <p>Chưa xác nhận được cấu hình thông báo đã lưu. Giữ nguyên nội dung đang sửa và đọc lại trạng thái trước khi thay đổi tiếp.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void readAfterUnknown()}>Đọc lại trạng thái</Button>
        </div>}
        {conflict && <p role="alert" className="rounded-md border border-amber-400 p-3 text-sm">Cấu hình vừa được người khác sửa — đã tải lại. Kiểm tra rồi sửa lại nếu cần.</p>}
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Bạn chỉ có quyền xem. Cần quyền "Cài đặt · sửa" để thay đổi.
          </p>
        )}

        {isLoading || !events || !base ? (
          <LoadingState label="cấu hình thông báo của công ty" variant="lines" rows={6} onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="divide-y">
              {NOTIFICATION_EVENT_KEYS.map((k) => {
                const config = events[k];
                if (!config) return null; // Máy chủ chưa quản lý khoá này ở cấp công ty.
                const label = NOTIFICATION_EVENT_LABELS[k];
                return (
                  <div key={k} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{label.title}</p>
                      <p className="text-xs text-muted-foreground">{label.desc}</p>
                      {config.enabled && ORG_MIN_AMOUNT_KEYS.has(k) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted-foreground">Chỉ báo khi số tiền từ</span>
                          <div className="w-[150px]">
                            <CurrencyInput
                              aria-label={`Ngưỡng tiền · ${label.title}`} name={`events.${k}.min_amount`}
                              value={config.min_amount ?? 0}
                              disabled={locked}
                              onChange={(v: number) =>
                                setEvent(k, { min_amount: Number.isNaN(v) ? v : v > 0 ? v : null })
                              }
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">đ (để 0 = không lọc)</span>
                        </div>
                      )}
                    </div>
                    <Switch
                      className="mt-1 shrink-0"
                      checked={config.enabled}
                      disabled={locked}
                      onCheckedChange={(v) => setEvent(k, { enabled: v })}
                      aria-label={label.title}
                    />
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <Label className="text-sm font-medium">Giờ yên của công ty</Label>
              <p className="text-xs text-muted-foreground">
                Trong khoảng này thông báo vẫn được ghi vào Bản tin nhưng KHÔNG đẩy ra màn hình;
                máy chủ hoãn tới khi hết khung. Giờ theo múi giờ công ty. Từ = đến là không có giờ yên.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Từ</span>
                <HourSelect label="Giờ bắt đầu yên của công ty" value={quietStart} disabled={locked}
                  onChange={(v) => { dirty.current = true; setConflict(false); setQuietStart(v); }} />
                <span className="text-sm text-muted-foreground">đến</span>
                <HourSelect label="Giờ kết thúc yên của công ty" value={quietEnd} disabled={locked}
                  onChange={(v) => { dirty.current = true; setConflict(false); setQuietEnd(v); }} />
              </div>
              {quietLength >= QUIET_HOURS_LONG_THRESHOLD && (
                <p className="text-sm text-amber-700">
                  Khung yên dài {quietLength} giờ ({formatHour(quietStart)}–{formatHour(quietEnd)}): thông báo đẩy của
                  CẢ công ty bị hoãn trong suốt khung này, kể cả phiếu chờ duyệt.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={locked || !hasChanges} onClick={onSave}>
                {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={locked || !hasChanges}
                onClick={() => { dirty.current = false; setConflict(false); setResync(n => n + 1); }}
              >
                Hoàn tác
              </Button>
              {base.updatedAt && <span className="text-xs text-muted-foreground">Sửa lần cuối {new Date(base.updatedAt).toLocaleString("vi-VN")}</span>}
            </div>

            <p className="text-xs text-muted-foreground">
              Ngưỡng tiền chỉ có ở loại thông tin có số tiền (phiếu được duyệt/từ chối, phiếu bị huỷ).
              Phiếu chờ duyệt, việc được giao, bàn giao và chốt sổ là việc chờ bạn xử lý nên không lọc theo tiền.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
