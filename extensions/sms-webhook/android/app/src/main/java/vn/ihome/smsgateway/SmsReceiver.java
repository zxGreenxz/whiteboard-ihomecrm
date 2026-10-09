package vn.ihome.smsgateway;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SmsReceiver extends BroadcastReceiver {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        PendingResult result = goAsync();
        Context application = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                GatewaySettings.Settings settings = new GatewaySettings(application).load();
                if (!settings.enabled || !settings.smsEnabled) return;
                SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
                if (messages == null || messages.length == 0) return;
                String sender = messages[0].getDisplayOriginatingAddress();
                StringBuilder body = new StringBuilder();
                for (SmsMessage message : messages) {
                    String part = message.getMessageBody();
                    if (part != null) body.append(part);
                }
                QueueStore store = new QueueStore(application);
                try {
                    GatewayPolicy.validateBody(body.toString());
                } catch (IllegalArgumentException error) {
                    store.recordReceiveFailure("SMS quá 8192 byte; không lưu nội dung.");
                    return;
                }
                store.enqueueSms(settings, sender, body.toString(), messages[0].getTimestampMillis(),
                        subscriptionId(intent));
                GatewayWork.schedule(application);
            } catch (Exception error) {
                // Never log exceptions: platform/network errors may include message text or URL secrets.
                try {
                    new QueueStore(application).recordReceiveFailure("Không lưu/lên lịch được SMS; kiểm tra cấu hình và bộ nhớ.");
                } catch (Exception ignored) {
                    // A failed disk cannot safely persist diagnostics. No payload is sent on this path.
                }
            } finally {
                result.finish();
            }
        });
    }

    private static Integer subscriptionId(Intent intent) {
        for (String key : new String[]{"android.telephony.extra.SUBSCRIPTION_INDEX", "subscription", "subscription_id"}) {
            if (intent.hasExtra(key)) {
                int value = intent.getIntExtra(key, -1);
                if (value >= 0) return value;
            }
        }
        return null;
    }
}
