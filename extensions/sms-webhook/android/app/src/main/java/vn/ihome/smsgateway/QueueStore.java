package vn.ihome.smsgateway;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteConstraintException;

import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public final class QueueStore {
    private static final Object LOCK = new Object();
    private static Database sharedDatabase;
    private final Database database;

    public QueueStore(Context context) {
        synchronized (LOCK) {
            if (sharedDatabase == null) sharedDatabase = new Database(context.getApplicationContext());
            database = sharedDatabase;
        }
    }

    public static final class Stats {
        public int pending;
        public int sent;
        public int failed;
        public int heartbeatPending;
        public long lastHeartbeatAt;
    }

    static final class Pending {
        final String id;
        final String destinationHash;
        final String encryptedPayload;

        Pending(String id, String destinationHash, String encryptedPayload) {
            this.id = id;
            this.destinationHash = destinationHash;
            this.encryptedPayload = encryptedPayload;
        }

        String payload() throws Exception {
            return SecureStorage.decrypt(encryptedPayload, "outbox.v1:" + id);
        }
    }

    void enqueueSms(GatewaySettings.Settings settings, String sender, String body,
                    long messageTimestamp, Integer subscriptionId) throws Exception {
        String id = GatewayPolicy.messageId(settings.deviceId, sender, body,
                messageTimestamp, subscriptionId);
        enqueue(settings, id, "sms.received", sender, body, messageTimestamp, subscriptionId);
    }

    void enqueueTest(GatewaySettings.Settings settings) throws Exception {
        String id = GatewayPolicy.sha256(settings.deviceId + ":test:" + UUID.randomUUID());
        enqueue(settings, id, "gateway.test", "SMS Gateway", "Tin nhắn kiểm tra kết nối — dữ liệu giả lập.",
                System.currentTimeMillis(), null);
    }

    void enqueueHeartbeat(GatewaySettings.Settings settings, boolean notificationAccess,
                          boolean smsPermission, String appVersion) throws Exception {
        String id = GatewayPolicy.sha256(settings.deviceId + ":heartbeat:" + UUID.randomUUID());
        JSONObject payload = envelope(settings, id, "gateway.heartbeat", System.currentTimeMillis());
        payload.put("smsEnabled", settings.smsEnabled);
        payload.put("notificationsEnabled", settings.notificationsEnabled);
        payload.put("notificationAccess", notificationAccess);
        payload.put("smsPermission", smsPermission);
        payload.put("appVersion", appVersion);
        persistPayload(settings, id, payload);
    }

    void enqueueNotification(GatewaySettings.Settings settings, String packageName, String appName,
                             String notificationKey, long postTime, String title, String body) throws Exception {
        GatewayPolicy.validateBody(body);
        GatewayPolicy.validateShortField(title, 512, "Tiêu đề thông báo");
        GatewayPolicy.validateShortField(appName, 512, "Tên ứng dụng");
        GatewayPolicy.validateShortField(packageName, 255, "Tên gói ứng dụng");
        // Include the platform key, timestamp and rendered content: callbacks for the same
        // notification deduplicate, while content edits become distinct events.
        String id = GatewayPolicy.notificationId(settings.deviceId, packageName, notificationKey,
                postTime, title, body);
        JSONObject payload = envelope(settings, id, "notification.received", postTime);
        payload.put("packageName", packageName);
        payload.put("appName", appName);
        payload.put("title", title);
        payload.put("body", body);
        persistPayload(settings, id, payload);
    }

    private void enqueue(GatewaySettings.Settings settings, String id, String event,
                         String sender, String body, long timestamp, Integer subscriptionId) throws Exception {
        GatewayPolicy.validateBody(body);
        GatewayPolicy.validateShortField(sender == null ? "" : sender, 255, "Nguồn gửi SMS");
        JSONObject payload = envelope(settings, id, event, timestamp);
        payload.put("sender", sender == null ? "" : sender);
        payload.put("body", body);
        payload.put("subscriptionId", subscriptionId == null ? JSONObject.NULL : subscriptionId);
        persistPayload(settings, id, payload);
    }

    private JSONObject envelope(GatewaySettings.Settings settings, String id, String event, long timestamp) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("schemaVersion", 1);
        payload.put("event", event);
        payload.put("id", id);
        payload.put("deviceId", settings.deviceId);
        // The source timestamp is stable across redeliveries, preserving the exact idempotent envelope.
        payload.put("receivedAt", Instant.ofEpochMilli(timestamp).toString());
        return payload;
    }

    private void persistPayload(GatewaySettings.Settings settings, String id, JSONObject payload) throws Exception {
        String wirePayload = payload.toString();
        GatewayPolicy.validateWirePayload(wirePayload);
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("destination_hash", GatewayPolicy.destinationBinding(settings.endpoint, settings.token));
        values.put("event", payload.getString("event"));
        values.put("payload", SecureStorage.encrypt(wirePayload, "outbox.v1:" + id));
        values.put("state", "pending");
        values.put("created_at", System.currentTimeMillis());
        values.put("updated_at", System.currentTimeMillis());
        synchronized (LOCK) {
            SQLiteDatabase db = database.getWritableDatabase();
            try {
                db.insertOrThrow("outbox", null, values);
            } catch (SQLiteConstraintException duplicate) {
                try (Cursor cursor = db.query("outbox", new String[]{"id"}, "id = ?",
                        new String[]{id}, null, null, null)) {
                    if (!cursor.moveToFirst()) throw duplicate;
                }
            }
        }
    }

    /** Records an operational failure without storing SMS text, sender or credentials. */
    void recordReceiveFailure(String reason) {
        ContentValues values = new ContentValues();
        values.put("id", GatewayPolicy.sha256("receive-error:" + UUID.randomUUID()));
        values.put("destination_hash", "");
        values.put("event", "receive.error");
        values.putNull("payload");
        values.put("state", "failed");
        values.put("reason", reason);
        values.put("created_at", System.currentTimeMillis());
        values.put("updated_at", System.currentTimeMillis());
        synchronized (LOCK) {
            database.getWritableDatabase().insertOrThrow("outbox", null, values);
        }
    }

    List<Pending> pending(int limit) {
        return pending(limit, false);
    }

    List<Pending> pending(int limit, boolean heartbeatOnly) {
        List<Pending> result = new ArrayList<>();
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox",
                    new String[]{"id", "destination_hash", "payload"},
                    heartbeatOnly ? "state = ? AND event = 'gateway.heartbeat'" : "state = ?",
                    new String[]{"pending"}, null, null,
                    "(event = 'gateway.heartbeat') DESC, created_at ASC", Integer.toString(limit))) {
                while (cursor.moveToNext()) result.add(new Pending(cursor.getString(0),
                        cursor.getString(1), cursor.getString(2)));
            }
        }
        return result;
    }

    boolean isPending(String id) {
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox", new String[]{"id"},
                    "id = ? AND state = ?", new String[]{id, "pending"}, null, null, null)) {
                return cursor.moveToFirst();
            }
        }
    }

    void markSent(String id) {
        synchronized (LOCK) {
            SQLiteDatabase db = database.getWritableDatabase();
            db.beginTransaction();
            try {
                ContentValues values = new ContentValues();
                values.put("state", "sent");
                values.putNull("payload");
                values.putNull("reason");
                values.put("updated_at", System.currentTimeMillis());
                db.update("outbox", values, "id = ?", new String[]{id});
                db.execSQL("DELETE FROM outbox WHERE state = 'sent' AND id NOT IN "
                        + "(SELECT id FROM outbox WHERE state = 'sent' ORDER BY updated_at DESC LIMIT 100)");
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
    }

    void markFailed(String id, String reason) {
        updateState(id, "failed", reason);
    }

    void noteRetry(String id, String reason) {
        updateState(id, "pending", reason);
    }

    private void updateState(String id, String state, String reason) {
        ContentValues values = new ContentValues();
        values.put("state", state);
        values.put("reason", reason);
        values.put("updated_at", System.currentTimeMillis());
        synchronized (LOCK) {
            database.getWritableDatabase().update("outbox", values, "id = ?", new String[]{id});
        }
    }

    public Stats stats() {
        Stats result = new Stats();
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().rawQuery(
                    "SELECT state, COUNT(*) FROM outbox WHERE event != 'gateway.heartbeat' GROUP BY state", null)) {
                while (cursor.moveToNext()) {
                    switch (cursor.getString(0)) {
                        case "pending": result.pending = cursor.getInt(1); break;
                        case "sent": result.sent = cursor.getInt(1); break;
                        case "failed": result.failed = cursor.getInt(1); break;
                        default: break;
                    }
                }
            }
            try (Cursor cursor = database.getReadableDatabase().rawQuery(
                    "SELECT COUNT(*) FROM outbox WHERE event = 'gateway.heartbeat' AND state = 'pending'", null)) {
                if (cursor.moveToFirst()) result.heartbeatPending = cursor.getInt(0);
            }
            try (Cursor cursor = database.getReadableDatabase().rawQuery(
                    "SELECT MAX(updated_at) FROM outbox WHERE event = 'gateway.heartbeat' AND state = 'sent'", null)) {
                if (cursor.moveToFirst() && !cursor.isNull(0)) result.lastHeartbeatAt = cursor.getLong(0);
            }
        }
        return result;
    }

    public long lastHeartbeatFor(String endpoint, String token) {
        if (endpoint.isEmpty() || token.isEmpty()) return 0;
        String binding = GatewayPolicy.destinationBinding(endpoint, token);
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().rawQuery(
                    "SELECT MAX(updated_at) FROM outbox WHERE event = 'gateway.heartbeat' "
                            + "AND state = 'sent' AND destination_hash = ?", new String[]{binding})) {
                return cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : 0;
            }
        }
    }

    public String recentSummary() {
        StringBuilder summary = new StringBuilder();
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox",
                    new String[]{"state", "reason", "updated_at", "event"}, null, null,
                    null, null, "updated_at DESC", "8")) {
                while (cursor.moveToNext()) {
                    String state = cursor.getString(0);
                    String label = "sent".equals(state) ? "Đã gửi" : "failed".equals(state) ? "Lỗi" : "Đang chờ";
                    if ("gateway.heartbeat".equals(cursor.getString(3))) label = "Kết nối · " + label;
                    summary.append(Instant.ofEpochMilli(cursor.getLong(2))).append(" · ").append(label);
                    if (!cursor.isNull(1)) summary.append(" · ").append(cursor.getString(1));
                    summary.append('\n');
                }
            }
        }
        return summary.length() == 0 ? "Chưa có tin nhắn trong hàng đợi." : summary.toString().trim();
    }

    /** Delete unsent messages including permanently failed messages. */
    public void clearPending() {
        synchronized (LOCK) {
            database.getWritableDatabase().delete("outbox", "state != ?", new String[]{"sent"});
        }
    }

    public void clearAll() {
        synchronized (LOCK) {
            database.getWritableDatabase().delete("outbox", null, null);
        }
    }

    public void retryFailed() {
        ContentValues values = new ContentValues();
        values.put("state", "pending");
        values.putNull("reason");
        values.put("updated_at", System.currentTimeMillis());
        synchronized (LOCK) {
            database.getWritableDatabase().update("outbox", values,
                    "state = ? AND payload IS NOT NULL", new String[]{"failed"});
        }
    }

    private static final class Database extends SQLiteOpenHelper {
        Database(Context context) {
            super(context, "sms_outbox.db", null, 2);
            setWriteAheadLoggingEnabled(true);
        }

        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, destination_hash TEXT NOT NULL, "
                    + "payload TEXT, event TEXT NOT NULL DEFAULT 'unknown', state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, "
                    + "updated_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX outbox_state_created ON outbox(state, created_at)");
        }

        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion == 1 && newVersion == 2) {
                db.execSQL("ALTER TABLE outbox ADD COLUMN event TEXT NOT NULL DEFAULT 'unknown'");
                // Previous releases bound only the URL. Preserve their records for inspection/
                // deletion; never silently move them to a newly assigned CRM source token.
                db.execSQL("UPDATE outbox SET state = 'failed', reason = 'Tin từ phiên bản cũ chưa gắn mã nguồn CRM; cần xóa hoặc xử lý riêng.' WHERE state = 'pending'");
                return;
            }
            throw new IllegalStateException("Thiếu nâng cấp cơ sở dữ liệu.");
        }
    }
}
