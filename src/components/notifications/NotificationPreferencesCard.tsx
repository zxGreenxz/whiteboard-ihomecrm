import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
// "Loại thông báo" — mục D4: sở thích CỦA CHÍNH TÔI, họ sự kiện × 2 kênh (trong app / đẩy về máy),
// trong CÔNG TY ĐANG CHỌN.
//
// 🔴 Vì sao nằm ở /account/notifications chứ KHÔNG phải /settings/general: đo thật bằng
// `get_my_permissions()` dưới JWT thật, `settings.view` chỉ TRUE với số ít tài khoản chủ; người
// NHẬN thông báo đa số không mở nổi trang cài đặt chung để tự tắt. Route này chỉ bọc
// ProtectedRoute ⇒ mọi thành viên vào được, cả desktop lẫn mobile.
//
// Ghi ĐÚNG khoá × trường vừa gạt (NOTIF-SETTINGS-8) và lấy phong bì máy chủ trả về làm trạng
// thái mới — không giữ bản nháp 7 khoá riêng có thể cũ hơn máy chủ.

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ListChecks } from "lucide-react";
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import {
  NotificationSettingsReceiptError,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  PUSH_FOLLOWS_IN_APP_KEYS,
  useMyNotificationPreferences,
  useSetMyNotificationPreference,
  type NotificationEventKey,
  type NotificationPreferenceChange,
} from "@/hooks/useNotificationSettings";

const isUncertain = (error: unknown) => error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(error);

export default function NotificationPreferencesCard({ organizationId }: { organizationId: string | null }) {
  const { data, isLoading, isError, refetch } = useMyNotificationPreferences(organizationId);
  const save = useSetMyNotificationPreference(organizationId);
  // Giá trị đang gửi: công tắc phải nhảy ngay, không đợi mạng. Chỉ một thay đổi một lúc.
  const [pending, setPending] = useState<NotificationPreferenceChange | null>(null);

  const uncertain = isUncertain(save.error);
  const readAfterUnknown = async () => {
    const result = await refetch();
    if (!result.isError && result.data) { save.reset(); setPending(null); }
  };

  const locked = uncertain || isError || !data?.available || save.isPending || !organizationId;

  const valueOf = (key: NotificationEventKey, field: "in_app" | "push"): boolean => {
    if (pending && pending.key === key && pending.field === field) return pending.value;
    return data?.prefs[key]?.[field] ?? false;
  };

  const toggle = (key: NotificationEventKey, field: "in_app" | "push", value: boolean) => {
    if (locked) return;
    const change: NotificationPreferenceChange = { key, field, value };
    setPending(change);
    save.mutate(change, {
      onSuccess: () => setPending(null),
      // Chỉ hoàn nguyên khi biết chắc lưu thất bại; chưa xác nhận thì giữ và khoá tới khi đọc lại.
      onError: (error) => { if (!isUncertain(error)) setPending(null); },
    });
  };

  if (!organizationId) {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground">Bạn chưa thuộc công ty nào nên chưa có tuỳ chọn thông báo để đặt.</CardContent></Card>;
  }
  if (isError) {
    return <Card><CardContent className="space-y-3 p-4"><p role="alert">Chưa tải được tùy chọn thông báo của bạn. Chưa xác định được trạng thái các công tắc.</p><Button variant="outline" onClick={() => void refetch()}>Tải lại tùy chọn</Button></CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-5 w-5" />
          Loại thông báo
        </CardTitle>
        <CardDescription>
          Áp dụng cho riêng tài khoản của bạn. "Trong app" là chuông và trang Bản tin;
          "Đẩy về máy" là thông báo hiện trên điện thoại/máy tính kể cả khi chưa mở web.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {uncertain && <div role="alert" className="space-y-2 rounded-md border border-amber-400 p-3 text-sm">
          <p>Chưa xác nhận được cấu hình thông báo đã lưu. Đọc lại trạng thái trước khi thay đổi tiếp.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void readAfterUnknown()}>Đọc lại trạng thái</Button>
        </div>}

        {isLoading || !data ? (
          <LoadingState label="tùy chọn thông báo" variant="lines" rows={6} onRetry={() => void refetch()} />
        ) : (
          <div className="divide-y">
            <div className="flex items-end justify-end gap-3 pb-2 text-[11px] leading-tight text-muted-foreground">
              <span className="w-14 text-center">Trong app</span>
              <span className="w-14 text-center">Đẩy về máy</span>
            </div>
            {NOTIFICATION_EVENT_KEYS.map((k) => {
              const label = NOTIFICATION_EVENT_LABELS[k];
              const row = data.prefs[k];
              if (!row) {
                return (
                  <div key={k} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{label.title}</p>
                      <p className="text-xs text-muted-foreground">{label.desc}</p>
                      <p className="mt-1 text-xs text-amber-700">Máy chủ chưa hỗ trợ loại này — công tắc sẽ mở sau khi máy chủ cập nhật.</p>
                    </div>
                  </div>
                );
              }
              const inApp = valueOf(k, "in_app");
              const pushLocked = PUSH_FOLLOWS_IN_APP_KEYS.has(k) && !inApp;
              const hintId = `push-locked-${k}`;
              return (
                <div key={k} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{label.title}</p>
                    <p className="text-xs text-muted-foreground">{label.desc}</p>
                    {pushLocked && (
                      <p id={hintId} className="mt-1 text-xs text-muted-foreground">
                        Đẩy về máy đi kèm dòng trong app — bật "Trong app" trước.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 pt-0.5">
                    <div className="flex w-14 justify-center">
                      <Switch
                        checked={inApp}
                        disabled={locked}
                        onCheckedChange={(v) => toggle(k, "in_app", v)}
                        aria-label={`Trong app · ${label.title}`}
                      />
                    </div>
                    <div className="flex w-14 justify-center">
                      <Switch
                        checked={pushLocked ? false : valueOf(k, "push")}
                        disabled={locked || pushLocked}
                        onCheckedChange={(v) => toggle(k, "push", v)}
                        aria-label={`Đẩy về máy · ${label.title}`}
                        aria-describedby={pushLocked ? hintId : undefined}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Tắt "Đẩy về máy" chỉ ngừng thông báo bật lên ngoài màn hình; dòng vẫn nằm trong
          Bản tin nếu "Trong app" còn bật. Nếu công ty đã tắt cả một loại ở "Cấu hình công ty"
          thì không ai nhận loại đó, dù bạn bật ở đây.
        </p>
      </CardContent>
    </Card>
  );
}
