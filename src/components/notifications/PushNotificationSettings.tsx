import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bell, BellOff, Loader2, Send, Smartphone, Info } from "lucide-react";
import { toast } from "sonner";
import {
  isPushSupported,
  isSubscribed,
  enablePush,
  disablePush,
  sendTestPush,
  getPermission,
  isIOS,
  isStandalone,
} from "@/lib/push";

export default function PushNotificationSettings() {
  const supported = isPushSupported();
  const ios = isIOS();
  const standalone = isStandalone();

  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ready, setReady] = useState(false);
  // Chi tiết lỗi lần gửi thử gần nhất — hiện ngay trên thẻ, không chỉ trong toast
  // (toast biến mất trước khi người dùng kịp đọc mã lỗi).
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setPermission(getPermission());
      if (supported) {
        const s = await isSubscribed().catch(() => false);
        if (alive) setSubscribed(s);
      }
      if (alive) setReady(true);
    })();
    // Nghe push từ service worker (xác nhận đã nhận được khi test)
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "push-received") {
        const p = e.data.payload || {};
        toast.success(p.title || "Đã nhận thông báo", { description: p.body });
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => {
      alive = false;
      navigator.serviceWorker?.removeEventListener("message", onMsg);
    };
  }, [supported]);

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const res = await enablePush();
        if (res === "granted") {
          setSubscribed(true);
          setPermission("granted");
          toast.success("Đã bật thông báo đẩy trên thiết bị này");
        } else if (res === "denied") {
          setPermission("denied");
          toast.error("Bạn đã chặn quyền thông báo. Hãy mở lại trong cài đặt trình duyệt.");
        } else if (res === "unsupported") {
          toast.error("Trình duyệt/thiết bị không hỗ trợ thông báo đẩy");
        } else {
          toast.info("Chưa cấp quyền thông báo");
        }
      } else {
        await disablePush();
        setSubscribed(false);
        toast.success("Đã tắt thông báo trên thiết bị này");
      }
    } catch (e) {
      toast.error("Có lỗi: " + ((e as Error)?.message || String(e)));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setLastError(null);
    try {
      const { sent, total, failed, pruned, errors } = await sendTestPush();

      if (sent > 0) {
        toast.success(
          `Đã gửi tới ${sent}/${total} thiết bị. Không thấy gì? Kiểm tra chế độ Không làm phiền của máy.`,
        );
      } else if (total === 0) {
        toast.warning('Thiết bị này chưa đăng ký. Bật công tắc "Bật trên thiết bị này" trước.');
      } else {
        // Gửi được lệnh nhưng KHÔNG thiết bị nào nhận — đây là ca trước đây bị giấu đi.
        const first = errors[0];
        const detail = first
          ? `HTTP ${first.status ?? "?"} · ${first.host} · ${first.body}`
          : "không có chi tiết lỗi";
        setLastError(detail);
        toast.error(`Gửi thất bại ${failed}/${total} thiết bị — ${detail}`, { duration: 12000 });
        console.error("[push] gửi thử thất bại", errors);
      }

      if (pruned > 0) {
        toast.warning(`${pruned} thiết bị đã hết hạn đăng ký và được gỡ. Hãy bật lại trên máy đó.`);
        setSubscribed(await isSubscribed());
      }
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setLastError(msg);
      toast.error("Gửi thử thất bại: " + msg, { duration: 12000 });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Thông báo đẩy (Push)
          {subscribed ? (
            <Badge className="ml-1">Đang bật</Badge>
          ) : (
            <Badge variant="outline" className="ml-1">Đang tắt</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Nhận thông báo trên thanh trạng thái điện thoại/máy tính (vd: tin nhắn Zalo mới)
          kể cả khi không mở web. Bật riêng cho từng thiết bị.
        </p>

        {!supported && (
          <Alert variant="destructive">
            <Info className="h-4 w-4" />
            <AlertDescription>
              Trình duyệt này không hỗ trợ thông báo đẩy. Hãy dùng Chrome/Edge/Firefox bản mới
              (hoặc Safari trên iOS 16.4+ sau khi "Thêm vào màn hình chính").
            </AlertDescription>
          </Alert>
        )}

        {supported && ios && !standalone && (
          <Alert>
            <Smartphone className="h-4 w-4" />
            <AlertDescription>
              Trên iPhone/iPad: mở Safari → nút Chia sẻ → <b>Thêm vào MH chính</b>, rồi mở app từ
              màn hình chính mới bật được thông báo (yêu cầu iOS 16.4+).
            </AlertDescription>
          </Alert>
        )}

        {supported && permission === "denied" && (
          <Alert variant="destructive">
            <BellOff className="h-4 w-4" />
            <AlertDescription>
              Quyền thông báo đang bị chặn. Mở cài đặt trang web trong trình duyệt → cho phép
              "Thông báo" rồi thử lại.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">Bật trên thiết bị này</div>
            <div className="text-xs text-muted-foreground">
              {subscribed ? "Thiết bị này sẽ nhận thông báo" : "Bấm để cấp quyền & đăng ký"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(busy || !ready) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Switch
              checked={subscribed}
              disabled={!supported || busy || !ready || permission === "denied"}
              onCheckedChange={handleToggle}
            />
          </div>
        </div>

        <Button variant="outline" onClick={handleTest} disabled={!subscribed || testing}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
          Gửi thông báo thử
        </Button>

        {lastError && (
          <Alert variant="destructive">
            <BellOff className="h-4 w-4" />
            <AlertDescription className="space-y-1">
              <div className="font-medium">Lần gửi thử gần nhất thất bại</div>
              <code className="block break-all text-xs">{lastError}</code>
              <div className="text-xs">
                HTTP 403/401 nghĩa là cặp khoá VAPID không khớp với đăng ký trên máy — tắt rồi bật
                lại công tắc ở trên để đăng ký lại bằng khoá hiện tại.
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
