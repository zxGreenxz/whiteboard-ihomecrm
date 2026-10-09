package vn.ihome.smsgateway;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Reads only new callbacks supplied by Android; never replays active notification history. */
public final class BankNotificationListenerService extends NotificationListenerService {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override public void onNotificationPosted(StatusBarNotification notification) {
        if (notification == null) return;
        EXECUTOR.execute(() -> receive(notification));
    }

    private void receive(StatusBarNotification notification) {
        try {
            GatewaySettings.Settings settings = new GatewaySettings(this).load();
            String packageName = notification.getPackageName();
            if (!settings.enabled || !settings.notificationsEnabled
                    || !settings.notificationPackages.contains(packageName)) return;
            Bundle extras = notification.getNotification().extras;
            String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
            String expanded = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            String body = expanded.isEmpty() ? text(extras.getCharSequence(Notification.EXTRA_TEXT)) : expanded;
            Set<String> parts = new LinkedHashSet<>();
            if (!body.isEmpty()) parts.add(body);
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null) {
                for (CharSequence line : lines) {
                    String lineText = text(line);
                    if (!lineText.isEmpty() && !body.contains(lineText)) parts.add(lineText);
                }
            }
            body = String.join("\n", parts);
            QueueStore store = new QueueStore(this);
            if (title.isEmpty() && body.isEmpty()) {
                store.recordReceiveFailure("Thông báo không có nội dung đọc được; không gửi.");
                return;
            }
            try {
                GatewayPolicy.validateBody(body);
                GatewayPolicy.validateShortField(title, 512, "Tiêu đề thông báo");
                GatewayPolicy.validateShortField(packageName, 255, "Tên gói ứng dụng");
            } catch (IllegalArgumentException error) {
                store.recordReceiveFailure("Thông báo vượt giới hạn: nội dung8192/tiêu đề512/gói255 byte; không lưu nội dung.");
                return;
            }
            String appName = packageName;
            try {
                PackageManager manager = getPackageManager();
                ApplicationInfo application = manager.getApplicationInfo(packageName, 0);
                appName = manager.getApplicationLabel(application).toString();
            } catch (PackageManager.NameNotFoundException ignored) {
                // The user-selected package remains an unambiguous source identifier.
            }
            try {
                GatewayPolicy.validateShortField(appName, 512, "Tên ứng dụng");
            } catch (IllegalArgumentException error) {
                store.recordReceiveFailure("Tên ứng dụng quá 512 byte; không lưu nội dung thông báo.");
                return;
            }
            store.enqueueNotification(settings, packageName, appName, notification.getKey(),
                    notification.getPostTime(), title, body);
            GatewayWork.schedule(this);
        } catch (Exception error) {
            try {
                new QueueStore(this).recordReceiveFailure("Không lưu/lên lịch được thông báo; kiểm tra cấu hình và bộ nhớ.");
            } catch (Exception ignored) {
                // No sensitive data enters logs if durable storage is unavailable.
            }
        }
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString();
    }
}
