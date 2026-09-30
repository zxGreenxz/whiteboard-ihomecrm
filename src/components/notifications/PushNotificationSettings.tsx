import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
import { actionErrorMessage, notifyActionError } from '@/lib/actionFeedback';
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

  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ready, setReady] = useState(false);
  // Chi tiết lỗi lần gửi thử gần nhất — hiện ngay trên thẻ, không chỉ trong toast
  // (toast biến mất trước khi người dùng kịp đọc mã lỗi).
  const [lastError, setLastError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setPermission(getPermission());
      if (supported) {
        const s = await isSubscribed().catch(error => {
          if (alive) setToggleError(actionErrorMessage(error, 'Chưa kiểm tra được trạng thái thông báo đẩy'));
          return null;
        });
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
    setToggleError(null);
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
        const result = await disablePush();
        if (result === "unsupported") {
          toast.info("Trình duyệt/thiết bị không hỗ trợ thông báo đẩy");
          return;
        }
        setSubscribed(false);
        if (result === "already-disabled") toast.info("Thiết bị này đã tắt thông báo đẩy.");
        else toast.success("Đã tắt thông báo trên thiết bị này");
      }
    } catch (e) {
      setToggleError(actionErrorMessage(e, 'Chưa xác nhận được thay đổi thông báo đẩy trên thiết bị này'));
      if (hasUnconfirmedResponse(e)) { setSubscribed(null); setPendingToggle(e); }
      notifyActionError(e, 'Chưa xác nhận được thay đổi thông báo đẩy trên thiết bị này');
    } finally {
      setBusy(false);
    }
  };

  const readPushState = async () => {
    setBusy(true);
    try {
      setSubscribed(await isSubscribed(pendingToggle));
      setPendingToggle(null);
      setToggleError(null);
    } catch (error) {
      setSubscribed(null);
      setToggleError(actionErrorMessage(error, 'Chưa kiểm tra được trạng thái thông báo đẩy'));
    } finally { setBusy(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setLastError(null);
    try {
      const { sent, total, failed, pruned } = await sendTestPush();

      if (sent > 0 && failed > 0) {
        const message = `Đã tiếp nhận gửi đến ${sent}/${total} thiết bị; ${failed} thiết bị chưa gửi được.`;
        setLastError(message);
        toast.warning(message);
      } else if (sent > 0) {
        toast.success(`Đã tiếp nhận gửi đến ${sent}/${total} thiết bị. Việc hiển thị còn tùy quyền thông báo và chế độ Không làm phiền của thiết bị.`);
      } else if (total === 0) {
        toast.warning('Chưa có thiết bị đăng ký nhận thông báo cho tài khoản này.');
      } else {
        const message = `Chưa gửi được thông báo thử đến ${failed}/${total} thiết bị. Kiểm tra trạng thái đăng ký trên từng thiết bị.`;
        setLastError(message);
        toast.error(message);
      }

      if (pruned > 0) {
        toast.warning(`${pruned} thiết bị đã hết hạn đăng ký. Kiểm tra và bật lại trên máy đó.`);
        try { setSubscribed(await isSubscribed()); }
        catch (error) {
          setSubscribed(null);
          setToggleError(actionErrorMessage(error, 'Chưa kiểm tra được trạng thái đăng ký sau khi gửi thử'));
        }
      }
    } catch (e) {
      const msg = actionErrorMessage(e, 'Chưa xác nhận được kết quả gửi thông báo thử');
      setLastError(msg);
      toast.error(msg, { duration: 12000 });
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
          {subscribed === null ? (<Badge variant="outline" className="ml-1">Chưa xác định</Badge>) : subscribed ? (
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

        {supported && ready && subscribed === null && <Alert variant="destructive"><AlertDescription>Chưa kiểm tra được trạng thái đăng ký của thiết bị này. <Button variant="outline" size="sm" onClick={() => void readPushState()} disabled={busy}>Kiểm tra lại</Button></AlertDescription></Alert>}
        {toggleError && <p role="alert" className="text-sm text-destructive">{toggleError}</p>}
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
              checked={subscribed === true}
              disabled={!supported || busy || !ready || subscribed === null || permission === "denied"}
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
              <div className="font-medium">Kết quả gửi thử gần nhất</div>
              <p className="text-sm">{lastError}</p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
