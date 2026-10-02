import {validateInputDrafts} from '@/lib/inputDraftValidation';
import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
// Cấu hình thông báo CẤP TỔ CHỨC — bật/tắt từng sự kiện E1…E6 + giờ yên tĩnh.
//
// Đặt trong tab "Thông báo" của /settings/general. Đúng chỗ: route đó đã gate
// `settings.view` và runtime chỉ vai trò "Chủ sở hữu tổ chức" giữ `settings.view/.edit`
// (đo thật: 2 dòng mỗi khoá, cả hai tổ chức). Server vẫn tự gate `settings.edit` trong
// RPC — nút mờ ở đây chỉ là lịch sự với người xem, KHÔNG phải lớp bảo vệ.
//
// Card RỜI, cố ý không nhét vào mảng NOTIFICATION_SETTINGS: `SettingRow` chỉ render
// 'toggle'/'select'/'number', không có kiểu 'component'; và hai toggle sẵn có ghi vào
// bảng `settings` chung, còn cấu hình này nằm ở app_private.notification_org_config.
// Khuôn đã có tiền lệ ở tab Thu chi (AccountingStandardCard / IeAutoApproveThresholdCard).

import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { BellRing } from "lucide-react";
import { LoadingState } from "@/components/loading/LoadingState";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import {
  NotificationSettingsReceiptError,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  useNotificationOrgConfig,
  useSetNotificationOrgConfig,
  type NotificationEventConfig,
  type NotificationEventKey,
} from "@/hooks/useNotificationSettings";

type EventMap = Record<NotificationEventKey, NotificationEventConfig>;

export default function NotificationOrgConfigCard() {
  const { data: perms } = useMyPermissions();
  const canEdit = canUse(perms, "settings", "edit");

  const { data, isLoading, isError, refetch } = useNotificationOrgConfig();
  const save = useSetNotificationOrgConfig();

  const [events, setEvents] = useState<EventMap | null>(null);
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(7);
  const dirty=useRef(false);const sourceOrg=useRef<string>();const root=useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    if(sourceOrg.current!==data.organizationId){sourceOrg.current=data.organizationId;dirty.current=false;}
    if(dirty.current)return;
    setEvents(data.events);
    setQuietStart(data.quiet_start);
    setQuietEnd(data.quiet_end);
  }, [data]);

  const uncertain = save.error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(save.error);
  const readAfterUnknown = async () => {
    const result = await refetch();
    if (!result.isError && result.data) save.reset();
  };
  const uncertainNotice = uncertain ? <div role="alert" className="rounded-md border border-amber-400 p-3 text-sm">
    <p>Chưa xác nhận được cấu hình thông báo đã lưu. Giữ nguyên nội dung đang sửa và đọc lại trạng thái trước khi thay đổi tiếp.</p>
    <Button type="button" variant="outline" size="sm" onClick={() => void readAfterUnknown()}>Đọc lại trạng thái</Button>
  </div> : null;

  const locked = uncertain || isError || !canEdit || !data?.available || save.isPending;

  const setEvent = (k: NotificationEventKey, patch: Partial<NotificationEventConfig>) => {
    dirty.current=true;
    setEvents((prev) => (prev ? { ...prev, [k]: { ...prev[k], ...patch } } : prev));
  };

  if (isError) {
    return <Card><CardContent className="space-y-3 p-4"><p role="alert">Chưa tải được cấu hình thông báo của tổ chức. Chưa xác định được trạng thái các công tắc.</p><Button variant="outline" onClick={() => void refetch()}>Tải lại cấu hình</Button></CardContent></Card>;
  }

  return (
    <Card ref={root}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-5 w-5" />
          Sự kiện phát thông báo
        </CardTitle>
        <CardDescription>
          Bật/tắt từng loại sự kiện cho TOÀN tổ chức. Đây là van tổng — tắt ở đây thì
          không ai nhận, kể cả người đã bật trong Tài khoản của họ. Sở thích riêng của
          từng người nằm ở trang Tài khoản (/account/profile). Chỉ Chủ sở hữu tổ chức
          thay đổi được.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {uncertainNotice}
        {!data?.available && !isLoading && (
          <p className="text-xs text-muted-foreground">
            Chưa đọc được cấu hình từ máy chủ (tính năng chưa bật, hoặc tài khoản của bạn
            không đủ quyền) — đang hiển thị mặc định: bật hết, yên tĩnh 21h–7h. Tạm thời
            chưa lưu được.
          </p>
        )}
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Bạn chỉ có quyền xem. Cần quyền "Cài đặt · sửa" để thay đổi.
          </p>
        )}

        {isLoading || !events ? (
          <LoadingState label="cấu hình thông báo" variant="lines" rows={6} />
        ) : (
          <>
            <div className="divide-y">
              {NOTIFICATION_EVENT_KEYS.map((k) => (
                <div key={k} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{NOTIFICATION_EVENT_LABELS[k].title}</p>
                    <p className="text-xs text-muted-foreground">
                      {NOTIFICATION_EVENT_LABELS[k].desc}
                    </p>
                    {events[k].enabled && k !== "LIFECYCLE" && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Chỉ báo khi số tiền từ
                        </span>
                        <div className="w-[150px]">
                          <CurrencyInput
                            aria-label={`Ngưỡng tiền · ${NOTIFICATION_EVENT_LABELS[k].title}`} name={`events.${k}.min_amount`}
                            value={events[k].min_amount ?? 0}
                            onChange={(v: number) =>
                              setEvent(k, { min_amount: Number.isNaN(v) ? v : v > 0 ? v : null })
                            }
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          đ (để 0 = không lọc)
                        </span>
                      </div>
                    )}
                  </div>
                  <Switch
                    className="mt-1 shrink-0"
                    checked={events[k].enabled}
                    disabled={locked}
                    onCheckedChange={(v) => setEvent(k, { enabled: v })}
                    aria-label={NOTIFICATION_EVENT_LABELS[k].title}
                  />
                </div>
              ))}
            </div>

            <div className="rounded-md border p-3">
              <Label className="text-sm font-medium">Giờ yên tĩnh</Label>
              <p className="mb-2 text-xs text-muted-foreground">
                Trong khoảng này thông báo vẫn được ghi vào Bản tin nhưng KHÔNG đẩy ra
                màn hình. Giờ Việt Nam (Asia/Ho_Chi_Minh), 0–23.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Từ</span>
                <NumberInput
                  className="w-[80px]"
                  min={0}
                  max={23}
                  aria-label="Giờ bắt đầu yên tĩnh" name="quietStart"
                  value={quietStart}
                  onChange={(v) => {dirty.current=true;setQuietStart(v);}}
                />
                <span className="text-sm text-muted-foreground">giờ đến</span>
                <NumberInput
                  className="w-[80px]"
                  min={0}
                  max={23}
                  aria-label="Giờ kết thúc yên tĩnh" name="quietEnd"
                  value={quietEnd}
                  onChange={(v) => {dirty.current=true;setQuietEnd(v);}}
                />
                <span className="text-sm text-muted-foreground">giờ</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={locked}
                onClick={() => {
                  if(locked||!data||!events||!validateInputDrafts(root.current))return;
                  save.mutate({organizationId:data.organizationId,events,quiet_start:quietStart,quiet_end:quietEnd},{onSuccess:()=>{dirty.current=false;}});
                }}
              >
                {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={locked || !data}
                onClick={() => {
                  if (!data) return;
                  dirty.current=false;
                  setEvents(data.events);
                  setQuietStart(data.quiet_start);
                  setQuietEnd(data.quiet_end);
                }}
              >
                Hoàn tác
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Lưu ý đã đo thật: ngưỡng tiền gần như vô dụng để chống ồn (nâng 300k lên 3tr
              chỉ hạ đỉnh từ 15 xuống 14 thông báo/ngày, và phiếu chờ duyệt bị ép bất kể số
              tiền). Cơ chế chống ồn thật là GỘP nhiều phiếu vào một dòng ở phía máy chủ.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
