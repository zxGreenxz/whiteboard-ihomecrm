package vn.ihome.diemdanh;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

/** Encrypted outbox: a record is written here before any attempt to send it. */
public final class QueueStore {
    private static final Object LOCK = new Object();
    private static final int KEEP_SENT = 300;
    /** The server refuses records older than 14 days, so nothing older is worth keeping. */
    private static final long MAX_AGE_MS = 15L * 24L * 60L * 60L * 1000L;
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
    }

    static final class Pending {
        final String id;
        final String destinationHash;
        final String event;
        final String encryptedPayload;

        Pending(String id, String destinationHash, String event, String encryptedPayload) {
            this.id = id;
            this.destinationHash = destinationHash;
            this.event = event;
            this.encryptedPayload = encryptedPayload;
        }

        String payload() throws Exception {
            return SecureStorage.decrypt(encryptedPayload, purpose(id));
        }
    }

    /** What the status screen shows for a slot; holds no coordinates. */
    public static final class SlotRow {
        public final long slotMs;
        public final String fixStatus;
        public final String reason;
        public final String state;
        public final String receiptStatus;

        SlotRow(long slotMs, String fixStatus, String reason, String state, String receiptStatus) {
            this.slotMs = slotMs;
            this.fixStatus = fixStatus;
            this.reason = reason;
            this.state = state;
            this.receiptStatus = receiptStatus;
        }
    }

    private static String purpose(String id) {
        return "outbox.v1:" + id;
    }

    /** The primary key makes a repeated slot a no-op, so the first stored payload is what is sent. */
    void enqueuePing(CheckinSettings.State state, String id, String wire, long slotMs, String fixStatus,
                     String fixReason) throws Exception {
        ContentValues values = baseValues(state, id, wire, CheckinPolicy.EVENT_PING);
        values.put("slot_at", slotMs);
        values.put("fix_status", fixStatus);
        values.put("fix_reason", fixReason);
        synchronized (LOCK) {
            database.getWritableDatabase().insertWithOnConflict("outbox", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        }
    }

    /** Only the newest health report matters, so an offline phone keeps one instead of a backlog. */
    void enqueueDeviceState(CheckinSettings.State state, String id, String wire) throws Exception {
        ContentValues values = baseValues(state, id, wire, CheckinPolicy.EVENT_STATE);
        synchronized (LOCK) {
            SQLiteDatabase db = database.getWritableDatabase();
            db.beginTransaction();
            try {
                db.delete("outbox", "event = ? AND state = ?", new String[]{CheckinPolicy.EVENT_STATE, "pending"});
                db.insertWithOnConflict("outbox", null, values, SQLiteDatabase.CONFLICT_REPLACE);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
    }

    private ContentValues baseValues(CheckinSettings.State state, String id, String wire, String event) throws Exception {
        long now = System.currentTimeMillis();
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("destination_hash", CheckinPolicy.destinationBinding(BuildConfig.INGEST_ENDPOINT, state.token));
        values.put("event", event);
        values.put("payload", SecureStorage.encrypt(wire, purpose(id)));
        values.put("state", "pending");
        values.put("created_at", now);
        values.put("updated_at", now);
        return values;
    }

    List<Pending> pending(int limit) {
        List<Pending> result = new ArrayList<>();
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox",
                    new String[]{"id", "destination_hash", "event", "payload"}, "state = ?",
                    new String[]{"pending"}, null, null,
                    "(event = '" + CheckinPolicy.EVENT_STATE + "') DESC, created_at ASC", Integer.toString(limit))) {
                while (cursor.moveToNext()) {
                    result.add(new Pending(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3)));
                }
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

    boolean hasPending() {
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox", new String[]{"id"},
                    "state = ?", new String[]{"pending"}, null, null, null, "1")) {
                return cursor.moveToFirst();
            }
        }
    }

    /** Drops the ciphertext once the server has confirmed the record. */
    void markSent(String id, String receiptStatus) {
        synchronized (LOCK) {
            SQLiteDatabase db = database.getWritableDatabase();
            db.beginTransaction();
            try {
                ContentValues values = new ContentValues();
                values.put("state", "sent");
                values.putNull("payload");
                values.putNull("reason");
                values.put("receipt_status", receiptStatus);
                values.put("updated_at", System.currentTimeMillis());
                db.update("outbox", values, "id = ?", new String[]{id});
                db.delete("outbox", "state = ? AND event = ?", new String[]{"sent", CheckinPolicy.EVENT_STATE});
                db.execSQL("DELETE FROM outbox WHERE state = 'sent' AND id NOT IN "
                        + "(SELECT id FROM outbox WHERE state = 'sent' ORDER BY updated_at DESC LIMIT " + KEEP_SENT + ")");
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
                    "SELECT state, COUNT(*) FROM outbox WHERE event = ? GROUP BY state",
                    new String[]{CheckinPolicy.EVENT_PING})) {
                while (cursor.moveToNext()) {
                    switch (cursor.getString(0)) {
                        case "pending": result.pending = cursor.getInt(1); break;
                        case "sent": result.sent = cursor.getInt(1); break;
                        case "failed": result.failed = cursor.getInt(1); break;
                        default: break;
                    }
                }
            }
        }
        return result;
    }

    /** Most recent slots first, for the status screen. */
    public List<SlotRow> recentSlots(int limit) {
        List<SlotRow> rows = new ArrayList<>();
        synchronized (LOCK) {
            try (Cursor cursor = database.getReadableDatabase().query("outbox",
                    new String[]{"slot_at", "fix_status", "fix_reason", "state", "receipt_status"},
                    "event = ?", new String[]{CheckinPolicy.EVENT_PING}, null, null,
                    "slot_at DESC", Integer.toString(limit))) {
                while (cursor.moveToNext()) {
                    rows.add(new SlotRow(cursor.getLong(0), cursor.getString(1), cursor.getString(2),
                            cursor.getString(3), cursor.getString(4)));
                }
            }
        }
        return rows;
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

    /** Removes records the server would refuse anyway because they are too old. */
    void prune() {
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        synchronized (LOCK) {
            database.getWritableDatabase().delete("outbox", "state != ? AND created_at < ?",
                    new String[]{"sent", Long.toString(cutoff)});
        }
    }

    void clearAll() {
        synchronized (LOCK) {
            database.getWritableDatabase().delete("outbox", null, null);
        }
    }

    private static final class Database extends SQLiteOpenHelper {
        Database(Context context) {
            super(context, "diemdanh_outbox.db", null, 1);
            setWriteAheadLoggingEnabled(true);
        }

        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, destination_hash TEXT NOT NULL, payload TEXT, "
                    + "event TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, slot_at INTEGER, fix_status TEXT, "
                    + "fix_reason TEXT, receipt_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX outbox_state_created ON outbox(state, created_at)");
        }

        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new IllegalStateException("Thiếu nâng cấp cơ sở dữ liệu.");
        }
    }
}
