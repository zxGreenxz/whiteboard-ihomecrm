package vn.ihome.smsgateway;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import org.json.JSONObject;

import javax.net.ssl.HttpsURLConnection;

public final class GatewayWork extends Worker {
    private static final ReentrantLock SENDING = new ReentrantLock();

    public GatewayWork(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager manager = WorkManager.getInstance(context.getApplicationContext());
        // A periodic recovery also catches process death between SQLite commit and scheduling.
        manager.enqueueUniquePeriodicWork("sms-outbox-recovery", ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(GatewayWork.class, 15, TimeUnit.MINUTES)
                        .setConstraints(constraints)
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
        manager.enqueueUniqueWork("sms-outbox", ExistingWorkPolicy.APPEND_OR_REPLACE,
                new OneTimeWorkRequest.Builder(GatewayWork.class).setConstraints(constraints)
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    public static void enqueueTest(Context context) throws Exception {
        GatewaySettings.Settings settings = new GatewaySettings(context).load();
        if (!settings.enabled) throw new IllegalArgumentException("Bật chuyển tiếp trước khi gửi thử.");
        GatewayPolicy.validateEndpoint(settings.endpoint);
        GatewayPolicy.validateToken(settings.token);
        new QueueStore(context).enqueueTest(settings);
        schedule(context);
    }

    static void scheduleHeartbeatDelivery(Context context) {
        // Independent of the SMS retry chain: an old failing message must not hide a live phone.
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                "gateway-heartbeat-delivery", ExistingWorkPolicy.APPEND_OR_REPLACE,
                new OneTimeWorkRequest.Builder(GatewayWork.class)
                        .setInputData(new Data.Builder().putBoolean("heartbeatOnly", true).build())
                        .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    @NonNull @Override public Result doWork() {
        if (!SENDING.tryLock()) return Result.retry();
        try {
            Context context = getApplicationContext();
            GatewaySettings configuration = new GatewaySettings(context);
            QueueStore store = new QueueStore(context);
            boolean heartbeatOnly = getInputData().getBoolean("heartbeatOnly", false);
            List<QueueStore.Pending> pending = store.pending(20, heartbeatOnly);
            for (QueueStore.Pending item : pending) {
                if (isStopped()) return Result.retry();
                GatewaySettings.Settings settings = configuration.load();
                if (!settings.enabled) return Result.success();
                String endpoint = GatewayPolicy.validateEndpoint(settings.endpoint);
                GatewayPolicy.validateToken(settings.token);
                if (!GatewayPolicy.destinationBinding(endpoint, settings.token).equals(item.destinationHash)) {
                    store.markFailed(item.id, "Webhook hoặc mã nguồn đã đổi; không chuyển tin sang nguồn mới.");
                    continue;
                }
                String payload;
                try {
                    payload = item.payload();
                } catch (Exception error) {
                    store.markFailed(item.id, "Không giải mã được tin; cần xóa hoặc khôi phục thiết bị.");
                    continue;
                }
                // Recheck immediately before opening a connection, after decrypting the record.
                GatewaySettings.Settings latest = configuration.load();
                if (!latest.enabled) return Result.success();
                if (!latest.endpoint.equals(settings.endpoint) || !latest.token.equals(settings.token)) {
                    return Result.retry();
                }
                JSONObject event = new JSONObject(payload);
                if (!sourceAllowed(latest, event)) {
                    store.markFailed(item.id, "Nguồn dữ liệu đã tắt/bỏ chọn; cần bật lại rồi thử lại.");
                    continue;
                }
                if (!store.isPending(item.id)) continue;
                try {
                    DeliveryResponse response = post(endpoint, latest.token, item.id, payload,
                            latest.pairedSourceId, "gateway.heartbeat".equals(event.getString("event")));
                    int status = response.status;
                    if (status >= 200 && status <= 299) {
                        configuration.confirmSource(endpoint, latest.token, response.sourceId);
                        store.markSent(item.id);
                    } else if (GatewayPolicy.shouldRetry(status)) {
                        store.noteRetry(item.id, "HTTP " + status + "; sẽ tự thử lại.");
                        return Result.retry();
                    } else {
                        store.markFailed(item.id, "HTTP " + status + "; cần xử lý rồi bấm thử lại.");
                    }
                } catch (InvalidReceiptException error) {
                    store.markFailed(item.id, "CRM chưa trả biên nhận hợp lệ cho đúng nguồn/tin; kiểm tra kết nối rồi thử lại.");
                } catch (IOException error) {
                    store.noteRetry(item.id, "Mạng/TLS chưa sẵn sàng; sẽ tự thử lại.");
                    return Result.retry();
                }
            }
            // A healthy backlog is more work, not a network failure. Continue with a fresh
            // request so exponential retry delays do not accumulate after successful batches.
            QueueStore.Stats remaining = store.stats();
            if (heartbeatOnly) {
                if (remaining.heartbeatPending > 0) scheduleHeartbeatDelivery(context);
            } else if (remaining.pending > 0 || remaining.heartbeatPending > 0) {
                schedule(context);
            }
            return Result.success();
        } catch (Exception error) {
            // WorkManager persists retries. Do not put exception messages or payload in its Data/logs.
            return Result.retry();
        } finally {
            SENDING.unlock();
        }
    }

    private boolean sourceAllowed(GatewaySettings.Settings settings, JSONObject payload) throws Exception {
        switch (payload.getString("event")) {
            case "sms.received": return settings.smsEnabled;
            case "notification.received":
                return settings.notificationsEnabled
                        && settings.notificationPackages.contains(payload.getString("packageName"));
            case "gateway.test": return true;
            case "gateway.heartbeat": return true;
            default: return false;
        }
    }

    private DeliveryResponse post(String endpoint, String token, String id, String payload,
                                  String expectedSourceId, boolean heartbeat)
            throws IOException, InvalidReceiptException {
        GatewayPolicy.validateWirePayload(payload);
        HttpsURLConnection connection = (HttpsURLConnection) new URL(endpoint).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("X-Idempotency-Key", id);
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            if (isStopped()) throw new IOException("Worker stopped");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status > 299) return new DeliveryResponse(status, null);
            String contentType = connection.getContentType();
            if (contentType == null || !"application/json".equalsIgnoreCase(contentType.split(";")[0].trim())) {
                throw new InvalidReceiptException();
            }
            String response;
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 8192) throw new InvalidReceiptException();
                    output.write(buffer, 0, count);
                }
                response = new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
            return new DeliveryResponse(status, parseReceipt(response, id, expectedSourceId, heartbeat));
        } finally {
            connection.disconnect();
        }
    }

    static String parseReceipt(String response, String id, String expectedSourceId, boolean heartbeat)
            throws InvalidReceiptException {
        try {
            JSONObject receipt = new JSONObject(response);
            JSONObject data = receipt.getJSONObject("data");
            if (!Integer.valueOf(1).equals(receipt.opt("schemaVersion")) || !data.has("eventId")) {
                throw new InvalidReceiptException();
            }
            String sourceId = data.getString("sourceId");
            GatewayPolicy.validateReceipt(1, Boolean.TRUE.equals(receipt.opt("ok")),
                    data.getString("status"), data.getString("externalId"), sourceId,
                    data.isNull("eventId") ? null : data.getString("eventId"),
                    data.getString("acceptedAt"), id, expectedSourceId, heartbeat);
            return sourceId;
        } catch (Exception error) {
            throw new InvalidReceiptException();
        }
    }

    private static final class DeliveryResponse {
        final int status;
        final String sourceId;

        DeliveryResponse(int status, String sourceId) {
            this.status = status;
            this.sourceId = sourceId;
        }
    }

    static final class InvalidReceiptException extends Exception {}
}
