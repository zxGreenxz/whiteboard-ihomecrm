// "Giờ yên của tôi" — mục D5: khung giờ cá nhân trong đó thông báo ĐẨY bị hoãn tới hết khung;
// chuông/Bản tin vẫn ghi ngay. Máy chủ lấy giao của khung công ty và khung cá nhân (plan B3).
// Giờ theo múi giờ công ty (`org_timezone_v1`), 0..23, `[từ, đến)`; từ = đến là không có khung.
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/loading/LoadingState";
import { Moon } from "lucide-react";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { isMissingRpcError } from "@/lib/notifications/settingsRpc";
import { QUIET_HOURS_LONG_THRESHOLD, formatHour, quietHoursLength } from "@/lib/notifications/settingsDisplay";
import { NotificationSettingsReceiptError, useMyQuietHours, useSetMyQuietHours } from "@/hooks/useNotificationSettings";
import { HourSelect } from "./HourSelect";

export default function NotificationQuietHoursCard({ organizationId }: { organizationId: string | null }) {
  const query = useMyQuietHours(organizationId);
  const save = useSetMyQuietHours(organizationId);
  const [enabled, setEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(7);
  const dirty = useRef(false);
  const source = useRef<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    if (source.current !== organizationId) { source.current = organizationId; dirty.current = false; }
    if (dirty.current) return;
    setEnabled(query.data.enabled);
    setQuietStart(query.data.quietStart);
    setQuietEnd(query.data.quietEnd);
  }, [query.data, organizationId]);

  const uncertain = save.error instanceof NotificationSettingsReceiptError || hasUnconfirmedResponse(save.error);
  const locked = uncertain || !query.data || save.isPending || !organizationId;
  const length = quietHoursLength(quietStart, quietEnd);
  const invalid = enabled && length === 0;
  const edit = <T,>(set: (v: T) => void) => (v: T) => { dirty.current = true; set(v); };

  const onSave = () => {
    if (locked || invalid) return;
    save.mutate({ enabled, quietStart, quietEnd }, { onSuccess: () => { dirty.current = false; } });
  };
  const readAfterUnknown = async () => {
    const result = await query.refetch();
    if (!result.isError && result.data) { save.reset(); dirty.current = false; setEnabled(result.data.enabled); setQuietStart(result.data.quietStart); setQuietEnd(result.data.quietEnd); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-5 w-5" />
          Giờ yên của tôi
        </CardTitle>
        <CardDescription>
          Trong khung này, thông báo đẩy về máy được hoãn tới khi hết khung; chuông và Bản tin vẫn ghi
          ngay như thường. Giờ theo múi giờ của công ty.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!organizationId ? (
          <p className="text-sm text-muted-foreground">Bạn chưa thuộc công ty nào nên chưa đặt được giờ yên.</p>
        ) : query.isLoading ? (
          <LoadingState label="giờ yên của bạn" variant="lines" rows={2} onRetry={() => void query.refetch()} />
        ) : query.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{isMissingRpcError(query.error)
              ? "Máy chủ chưa hỗ trợ giờ yên cá nhân. Mục này sẽ dùng được sau khi máy chủ cập nhật."
              : actionErrorMessage(query.error, "Chưa tải được giờ yên của bạn")}</p>
            {!isMissingRpcError(query.error) && <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Tải lại</Button>}
          </div>
        ) : (
          <>
            {uncertain && <div role="alert" className="space-y-2 rounded-md border border-amber-400 p-3 text-sm">
              <p>Chưa xác nhận được giờ yên đã lưu. Giữ nguyên nội dung đang sửa và đọc lại trạng thái trước khi thay đổi tiếp.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void readAfterUnknown()}>Đọc lại trạng thái</Button>
            </div>}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="my-quiet-hours-enabled" className="text-sm font-medium">Bật giờ yên</Label>
              <Switch id="my-quiet-hours-enabled" checked={enabled} disabled={locked} onCheckedChange={edit(setEnabled)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Từ</span>
              <HourSelect label="Giờ bắt đầu yên của tôi" value={quietStart} onChange={edit(setQuietStart)} disabled={locked || !enabled} />
              <span className="text-sm text-muted-foreground">đến</span>
              <HourSelect label="Giờ kết thúc yên của tôi" value={quietEnd} onChange={edit(setQuietEnd)} disabled={locked || !enabled} />
            </div>
            {invalid && <p role="alert" className="text-sm text-destructive">Giờ bắt đầu và giờ kết thúc phải khác nhau.</p>}
            {enabled && length >= QUIET_HOURS_LONG_THRESHOLD && (
              <p className="text-sm text-amber-700">
                Khung yên dài {length} giờ ({formatHour(quietStart)}–{formatHour(quietEnd)}): thông báo đẩy sẽ bị hoãn gần như cả ngày.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={locked || invalid} onClick={onSave}>
                {save.isPending ? "Đang lưu…" : "Lưu giờ yên"}
              </Button>
              {query.data?.updatedAt && (
                <span className="text-xs text-muted-foreground">Lưu lần cuối {new Date(query.data.updatedAt).toLocaleString("vi-VN")}</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
