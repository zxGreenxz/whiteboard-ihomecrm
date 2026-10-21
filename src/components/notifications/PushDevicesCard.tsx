// "Thiết bị đã đăng ký" — mục D3: mọi dòng `push_subscriptions` của CHÍNH tôi (RLS select_own),
// đánh dấu máy đang dùng, gỡ từng máy khác (RLS delete_own, đọc biên nhận đúng một dòng).
//
// Máy đang dùng KHÔNG gỡ ở đây: xoá dòng máy chủ mà để nguyên đăng ký trình duyệt thì
// `isSubscribed()` của chính máy này kẹt ở "chưa xác định". Tắt bằng công tắc ở "Thiết bị
// này" (disablePush huỷ trình duyệt trước rồi mới dọn máy chủ).
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LoadingState } from "@/components/loading/LoadingState";
import { MonitorSmartphone, Trash2 } from "lucide-react";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { describeUserAgent } from "@/lib/notifications/settingsDisplay";
import {
  NotificationSettingsReceiptError,
  useCurrentPushDevice,
  useMyPushDevices,
  useRemovePushDevice,
  type MyPushDevice,
} from "@/hooks/useNotificationSettings";

const formatDay = (iso: string) => new Date(iso).toLocaleDateString("vi-VN");

export default function PushDevicesCard() {
  const devices = useMyPushDevices();
  const current = useCurrentPushDevice();
  const remove = useRemovePushDevice();
  const [confirming, setConfirming] = useState<MyPushDevice | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const currentEndpoint = current.data?.endpoint ?? null;
  const uncertain = remove.error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(remove.error);

  const confirmRemove = () => {
    if (!confirming) return;
    const target = confirming;
    setConfirming(null);
    setRemoveError(null);
    remove.mutate(target.id, {
      onError: (error) => setRemoveError(
        error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(error)
          ? "Chưa xác nhận được việc gỡ thiết bị. Danh sách đã được tải lại — kiểm tra trước khi gỡ tiếp."
          : actionErrorMessage(error, "Chưa gỡ được thiết bị"),
      ),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5" />
          Thiết bị đã đăng ký
        </CardTitle>
        <CardDescription>
          Các trình duyệt đang nhận thông báo đẩy của tài khoản bạn. Gỡ máy không còn dùng (máy cũ, máy dùng chung).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {removeError && <p role="alert" className={uncertain ? "text-sm text-amber-700" : "text-sm text-destructive"}>{removeError}</p>}
        {devices.isLoading ? (
          <LoadingState label="thiết bị đã đăng ký" variant="list" rows={2} onRetry={() => void devices.refetch()} />
        ) : devices.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>Chưa tải được danh sách thiết bị. Chưa xác định được máy nào đang nhận thông báo.</p>
            <Button variant="outline" size="sm" onClick={() => void devices.refetch()}>Tải lại danh sách</Button>
          </div>
        ) : !devices.data?.length ? (
          <p className="text-sm text-muted-foreground">Chưa có thiết bị nào đăng ký nhận thông báo đẩy.</p>
        ) : (
          <ul className="divide-y">
            {devices.data.map((device) => {
              const isCurrent = !!currentEndpoint && device.endpoint === currentEndpoint;
              const name = describeUserAgent(device.userAgent);
              return (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{name}</span>
                      {isCurrent && <Badge variant="secondary">Máy này</Badge>}
                      {device.isActive
                        ? <Badge variant="outline" className="border-emerald-300 text-emerald-700">Đang nhận</Badge>
                        : <Badge variant="outline" className="text-muted-foreground">Đã ngừng (hết hạn)</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">Bật từ {formatDay(device.createdAt)}</p>
                  </div>
                  {isCurrent ? (
                    <span className="text-xs text-muted-foreground">Tắt bằng công tắc ở mục "Thiết bị này"</span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Gỡ thiết bị ${name}`}
                      disabled={remove.isPending}
                      onClick={() => setConfirming(device)}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Gỡ
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <AlertDialog open={!!confirming} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Gỡ thiết bị này khỏi danh sách nhận thông báo?</AlertDialogTitle>
              <AlertDialogDescription>
                {confirming ? `${describeUserAgent(confirming.userAgent)} (bật từ ${formatDay(confirming.createdAt)})` : ""} sẽ thôi nhận thông báo đẩy.
                Muốn nhận lại thì mở CRM trên máy đó và bật ở mục "Thiết bị này".
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Huỷ</AlertDialogCancel>
              <AlertDialogAction onClick={confirmRemove}>Gỡ thiết bị</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
