import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
import { actionErrorMessage, notifyActionError } from '@/lib/actionFeedback';
// "Thiết bị này" — mục D2 của trang Cài đặt thông báo: bật/tắt push cho trình duyệt đang
// dùng, gửi thử (đọc `outcome`), và chẩn đoán vì sao không nhận được thông báo.
//
// Nhánh iPhone tách riêng (NOTIF-SETTINGS-10): Safari iOS chỉ cấp PushManager cho web app ĐÃ
// thêm vào màn hình chính, nên ở tab Safari thường `isPushSupported()` = false — trước đây
// người dùng chỉ thấy thẻ đỏ "không hỗ trợ" và không biết phải làm gì.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InlineSkeleton } from "@/components/loading/LoadingState";
import { Bell, BellOff, Loader2, Send, Smartphone, Info, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
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
import {
  CURRENT_PUSH_DEVICE_KEY,
  MY_PUSH_DEVICES_KEY,
  MY_PUSH_LOG_KEY,
  useCurrentPushDevice,
  useMyPushLog,
} from "@/hooks/useNotificationSettings";
import { isMissingRpcError } from "@/lib/notifications/settingsRpc";
import {
  pushOutcomeLabel,
  readTestPushOutcome,
  testPushFeedback,
  type OutcomeTone,
} from "@/lib/notifications/settingsDisplay";

const PERMISSION_LABEL: Record<NotificationPermission | "unsupported", string> = {
  granted: "Đã cho phép",
  denied: "Đang bị chặn",
  default: "Chưa hỏi",
  unsupported: "Không áp dụng",
};

const SW_LABEL = { active: "Đang chạy", waiting: "Đang chờ kích hoạt", none: "Chưa đăng ký", unsupported: "Trình duyệt không hỗ trợ" } as const;

const TONE_CLASS: Record<OutcomeTone, string> = {
  ok: "text-emerald-700",
  warn: "text-amber-700",
  error: "text-destructive",
  muted: "text-muted-foreground",
};

/** Hướng dẫn 3 bước cài PWA trên iPhone/iPad — chỉ hiện ở Safari CHƯA thêm vào màn hình chính. */
export function IosInstallGuide() {
  return (
    <Alert role="note">
      <Smartphone className="h-4 w-4" />
      <AlertTitle>Trên iPhone/iPad: thêm CRM vào màn hình chính để nhận thông báo</AlertTitle>
      <AlertDescription className="space-y-2">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Mở trang này bằng Safari, bấm nút <b>Chia sẻ</b> (ô vuông có mũi tên lên).</li>
          <li>Chọn <b>Thêm vào MH chính</b> rồi bấm <b>Thêm</b>.</li>
          <li>Mở CRM từ <b>biểu tượng trên màn hình chính</b>, vào lại trang này và bật thông báo.</li>
        </ol>
        <p className="text-xs text-muted-foreground">Cần iOS 16.4 trở lên. Tab Safari thường không nhận được thông báo đẩy.</p>
      </AlertDescription>
    </Alert>
  );
}

function PermissionBlockedGuide({ ios }: { ios: boolean }) {
  return (
    <Alert variant="destructive">
      <BellOff className="h-4 w-4" />
      <AlertTitle>Quyền thông báo đang bị chặn</AlertTitle>
      <AlertDescription className="text-sm">
        {ios
          ? <>Mở <b>Cài đặt</b> của iPhone → <b>Thông báo</b> → chọn <b>iHomeCRM</b> → bật <b>Cho phép thông báo</b>, rồi mở lại app và bấm "Kiểm tra lại".</>
          : <>Bấm biểu tượng ổ khoá (hoặc ⓘ) cạnh thanh địa chỉ → <b>Cài đặt trang web</b> → <b>Thông báo</b> → <b>Cho phép</b>, rồi bấm "Kiểm tra lại". Trên Android có thể cần bật thêm ở Cài đặt → Ứng dụng → Chrome → Thông báo.</>}
      </AlertDescription>
    </Alert>
  );
}

export default function PushNotificationSettings() {
  const { selectedOrganizationId } = useOrganization();
  const qc = useQueryClient();
  const supported = isPushSupported();
  const ios = isIOS();
  const standalone = isStandalone();
  const iosNeedsInstall = !supported && ios && !standalone;

  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ready, setReady] = useState(false);
  // Kết quả lần gửi thử gần nhất — hiện ngay trên thẻ, không chỉ trong toast
  // (toast biến mất trước khi người dùng kịp đọc).
  const [testResult, setTestResult] = useState<{ tone: OutcomeTone; message: string } | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<unknown>(null);

  const device = useCurrentPushDevice();
  const log = useMyPushLog(5);
  const refreshDeviceQueries = () => {
    void qc.invalidateQueries({ queryKey: CURRENT_PUSH_DEVICE_KEY });
    void qc.invalidateQueries({ queryKey: MY_PUSH_DEVICES_KEY });
  };

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
        const res = await enablePush(selectedOrganizationId);
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
      refreshDeviceQueries();
    }
  };

  const readPushState = async () => {
    setBusy(true);
    setPermission(getPermission());
    try {
      setSubscribed(await isSubscribed(pendingToggle));
      setPendingToggle(null);
      setToggleError(null);
    } catch (error) {
      setSubscribed(null);
      setToggleError(actionErrorMessage(error, 'Chưa kiểm tra được trạng thái thông báo đẩy'));
    } finally { setBusy(false); refreshDeviceQueries(); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestPush();
      const outcome = readTestPushOutcome(result);
      const feedback = testPushFeedback({ outcome, sent: result.sent, failed: result.failed, total: result.total, pruned: result.pruned });
      setTestResult(feedback);
      if (feedback.tone === "ok") toast.success(feedback.message);
      else if (feedback.tone === "warn") toast.warning(feedback.message);
      else if (feedback.tone === "muted") toast.info(feedback.message);
      else toast.error(feedback.message);

      if (result.pruned > 0) {
        try { setSubscribed(await isSubscribed()); }
        catch (error) {
          setSubscribed(null);
          setToggleError(actionErrorMessage(error, 'Chưa kiểm tra được trạng thái đăng ký sau khi gửi thử'));
        }
        refreshDeviceQueries();
      }
    } catch (e) {
      const msg = actionErrorMessage(e, 'Chưa xác nhận được kết quả gửi thông báo thử');
      setTestResult({ tone: "error", message: msg });
      toast.error(msg, { duration: 12000 });
    } finally {
      setTesting(false);
      void qc.invalidateQueries({ queryKey: MY_PUSH_LOG_KEY });
    }
  };

  const statusBadge = iosNeedsInstall ? <Badge variant="outline">Cần thêm vào màn hình chính</Badge>
    : !supported ? <Badge variant="outline">Không hỗ trợ</Badge>
    : subscribed === null ? <Badge variant="outline">Chưa xác định</Badge>
    : subscribed ? <Badge>Đang bật</Badge>
    : <Badge variant="outline">Đang tắt</Badge>;

  const serverRegistration = !supported ? "Không áp dụng"
    : !ready ? null
    : subscribed === null ? "Chưa xác định — bấm Kiểm tra lại"
    : subscribed ? "Khớp, máy chủ đang gửi tới máy này"
    : permission === "granted" && device.data?.endpoint
      ? "Trình duyệt có đăng ký nhưng máy chủ không gửi tới (có thể đã hết hạn) — tắt rồi bật lại"
      : "Chưa đăng ký";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Bell className="h-5 w-5" />
          Thiết bị này
          {statusBadge}
        </CardTitle>
        <CardDescription>
          Thông báo đẩy hiện trên thanh trạng thái điện thoại/máy tính kể cả khi chưa mở web. Bật riêng cho từng thiết bị.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {iosNeedsInstall && <IosInstallGuide />}

        {!supported && !iosNeedsInstall && (
          <Alert variant="destructive">
            <Info className="h-4 w-4" />
            <AlertDescription>
              Trình duyệt này không hỗ trợ thông báo đẩy. Hãy dùng Chrome/Edge/Firefox bản mới
              (hoặc Safari trên iOS 16.4+ sau khi "Thêm vào màn hình chính").
            </AlertDescription>
          </Alert>
        )}

        {supported && permission === "denied" && <PermissionBlockedGuide ios={ios} />}

        {supported && ready && subscribed === null && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-2">Chưa kiểm tra được trạng thái đăng ký của thiết bị này. <Button variant="outline" size="sm" onClick={() => void readPushState()} disabled={busy}>Kiểm tra lại</Button></AlertDescription></Alert>}
        {toggleError && <p role="alert" className="text-sm text-destructive">{toggleError}</p>}

        {supported && (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium">Bật trên thiết bị này</div>
              <div className="text-xs text-muted-foreground">
                {subscribed ? "Thiết bị này sẽ nhận thông báo đẩy" : "Bấm để cấp quyền & đăng ký"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {(busy || !ready) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <Switch
                aria-label="Bật thông báo đẩy trên thiết bị này"
                checked={subscribed === true}
                disabled={busy || !ready || subscribed === null || permission === "denied"}
                onCheckedChange={handleToggle}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {/* Không đòi máy này đã bật: gửi thử đi tới MỌI thiết bị đang bật của tài khoản (vd thử
              điện thoại từ máy tính), và NO_DEVICE là câu trả lời hữu ích chứ không phải lỗi. */}
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
            Gửi thông báo thử
          </Button>
          {supported && (
            <Button variant="ghost" onClick={() => void readPushState()} disabled={busy}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Kiểm tra lại
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Gửi thử tới mọi thiết bị đang bật nhận thông báo của tài khoản bạn.</p>

        {testResult && (
          <div role="status" className="rounded-md border p-3 text-sm">
            <div className="font-medium">Kết quả gửi thử gần nhất</div>
            <p className={TONE_CLASS[testResult.tone]}>{testResult.message}</p>
          </div>
        )}

        <div className="rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Chẩn đoán</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Trình duyệt hỗ trợ</dt>
            <dd>{supported ? "Có" : iosNeedsInstall ? "Chỉ khi mở từ màn hình chính" : "Không"}</dd>
            <dt className="text-muted-foreground">Quyền thông báo</dt>
            <dd>{PERMISSION_LABEL[permission]}</dd>
            <dt className="text-muted-foreground">Service worker</dt>
            <dd>{device.isLoading ? <InlineSkeleton label="trạng thái service worker" /> : device.isError ? "Chưa kiểm tra được" : device.data ? SW_LABEL[device.data.serviceWorker] : "—"}</dd>
            <dt className="text-muted-foreground">Đăng ký trên máy chủ</dt>
            <dd>{serverRegistration ?? <InlineSkeleton label="đăng ký trên máy chủ" />}</dd>
          </dl>
          <div className="mt-3">
            <p className="mb-1 text-sm text-muted-foreground">5 lần gửi gần nhất tới tài khoản của bạn</p>
            {log.isLoading ? <InlineSkeleton label="nhật ký gửi" width="12rem" />
              : log.isError ? (
                <p className="text-sm">
                  {isMissingRpcError(log.error) ? "Máy chủ chưa có nhật ký gửi." : "Chưa đọc được nhật ký gửi."}{" "}
                  {!isMissingRpcError(log.error) && <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void log.refetch()}>Tải lại</Button>}
                </p>
              )
              : !log.data?.length ? <p className="text-sm">Chưa có lần gửi nào.</p>
              : (
                <ul className="space-y-1 text-sm">
                  {log.data.map((row) => {
                    const meta = pushOutcomeLabel(row.outcome);
                    return (
                      <li key={`${row.createdAt}-${row.outcome}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-muted-foreground">{new Date(row.createdAt).toLocaleString("vi-VN")}</span>
                        <span className={TONE_CLASS[meta.tone]}>{meta.label}{row.sent > 0 ? ` · ${row.sent} máy` : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
