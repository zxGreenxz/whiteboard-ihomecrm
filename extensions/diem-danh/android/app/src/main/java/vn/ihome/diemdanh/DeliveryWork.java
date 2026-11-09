package vn.ihome.diemdanh;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

import javax.net.ssl.HttpsURLConnection;

/** Sends the outbox; a record is done only after a receipt pinned to its id. */
public final class DeliveryWork extends Worker {
    private static final String TAG = "DiemDanhDelivery";
    private static final String UNIQUE_NAME = "diemdanh-outbox";
    private static final int BATCH = 30;
    private static final int MAX_RECEIPT_BYTES = 16 * 1024;
    private static final ReentrantLock SENDING = new ReentrantLock();

    /** Replaced by a fake in the device tests so they never reach a server. */
    static volatile Transport transport = new HttpsTransport();

    public DeliveryWork(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    interface Transport {
        HttpResult post(String endpoint, String token, String id, String payload) throws IOException;
    }

    static final class HttpResult {
        final int status;
        final String body;
        final String contentType;

        HttpResult(int status, String body, String contentType) {
            this.status = status;
            this.body = body;
            this.contentType = contentType;
        }

        boolean isJson() {
            return contentType != null && "application/json".equalsIgnoreCase(contentType.split(";")[0].trim());
        }
    }

    enum Outcome { DONE, MORE, RETRY, REVOKED }

    public static void schedule(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(UNIQUE_NAME,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                new OneTimeWorkRequest.Builder(DeliveryWork.class)
                        .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                        .build());
    }

    @NonNull @Override public Result doWork() {
        if (!SENDING.tryLock()) return Result.retry();
        try {
            Context context = getApplicationContext();
            switch (drain(context, this::isStopped)) {
                case RETRY:
                    return Result.retry();
                case MORE:
                    // A healthy backlog continues in a fresh request instead of accruing backoff.
                    schedule(context);
                    return Result.success();
                default:
                    return Result.success();
            }
        } catch (Exception error) {
            // WorkManager persists retries; no exception text or payload goes into its data or logs.
            Log.w(TAG, "delivery failed: " + error.getClass().getSimpleName());
            return Result.retry();
        } finally {
            SENDING.unlock();
        }
    }

    static Outcome drain(Context context, BooleanSupplier stopped) {
        CheckinSettings configuration = new CheckinSettings(context);
        QueueStore store = new QueueStore(context);
        for (QueueStore.Pending item : store.pending(BATCH)) {
            if (stopped.getAsBoolean()) return Outcome.RETRY;
            CheckinSettings.State state = configuration.load();
            if (!state.isActive()) return Outcome.DONE;
            if (!CheckinPolicy.destinationBinding(BuildConfig.INGEST_ENDPOINT, state.token).equals(item.destinationHash)) {
                store.markFailed(item.id, "Bản ghi của lần ghép nối trước; không gửi sang tài khoản mới.");
                continue;
            }
            String payload;
            try {
                payload = item.payload();
            } catch (Exception error) {
                store.markFailed(item.id, "Không giải mã được bản ghi.");
                continue;
            }
            if (!store.isPending(item.id)) continue;
            long startedMs = System.currentTimeMillis();
            HttpResult response;
            try {
                response = transport.post(BuildConfig.INGEST_ENDPOINT, state.token, item.id, payload);
            } catch (IOException error) {
                store.noteRetry(item.id, "Mạng chưa sẵn sàng; sẽ tự thử lại.");
                return Outcome.RETRY;
            }
            long finishedMs = System.currentTimeMillis();
            int status = response.status;
            if (status == 401) {
                revoke(context, configuration);
                return Outcome.REVOKED;
            }
            if (status >= 200 && status <= 299) {
                try {
                    CheckinPolicy.Receipt receipt = requireReceipt(response, item);
                    store.markSent(item.id, receipt.status);
                    applySettings(context, configuration, receipt, startedMs, finishedMs);
                } catch (CheckinPolicy.InvalidReceiptException error) {
                    store.markFailed(item.id, "CRM chưa trả biên nhận hợp lệ cho bản ghi này.");
                }
            } else if (CheckinPolicy.shouldRetry(status)) {
                store.noteRetry(item.id, "Máy chủ báo lỗi " + status + "; sẽ tự thử lại.");
                return Outcome.RETRY;
            } else {
                store.markFailed(item.id, "Máy chủ từ chối (" + status + ").");
            }
        }
        return store.hasPending() ? Outcome.MORE : Outcome.DONE;
    }

    private static CheckinPolicy.Receipt requireReceipt(HttpResult response, QueueStore.Pending item)
            throws CheckinPolicy.InvalidReceiptException {
        if (!response.isJson()) throw new CheckinPolicy.InvalidReceiptException("content type");
        return CheckinPolicy.parseReceipt(response.body, item.id, item.event);
    }

    private static void applySettings(Context context, CheckinSettings configuration, CheckinPolicy.Receipt receipt,
                                      long startedMs, long finishedMs) {
        try {
            if (configuration.applyServerSettings(receipt.settings, startedMs, finishedMs)) {
                SlotScheduler.ensureArmed(context);
            }
        } catch (RuntimeException error) {
            // A settings block we cannot read never undoes a delivered record; the old schedule stays.
            Log.w(TAG, "settings ignored: " + error.getClass().getSimpleName());
        }
    }

    /** The credential is dead: stop every background activity until the user pairs again. */
    private static void revoke(Context context, CheckinSettings configuration) {
        configuration.markRevoked();
        SlotScheduler.cancel(context);
        SafetyNetWork.cancel(context);
    }

    private static final class HttpsTransport implements Transport {
        @Override public HttpResult post(String endpoint, String token, String id, String payload) throws IOException {
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
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
                int status = connection.getResponseCode();
                String contentType = connection.getContentType();
                if (status < 200 || status > 299) return new HttpResult(status, "", contentType);
                return new HttpResult(status, readBounded(connection), contentType);
            } finally {
                connection.disconnect();
            }
        }

        /** An oversized body comes back empty, which the receipt check then rejects. */
        private static String readBounded(HttpsURLConnection connection) throws IOException {
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > MAX_RECEIPT_BYTES) return "";
                    output.write(buffer, 0, count);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }
}
