package vn.ihome.diemdanh;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.UUID;

/** Encrypted device state: credential, device id, last server settings, clock offset, pause flag. */
public final class CheckinSettings {
    private static final Object LOCK = new Object();
    private static final String PREFERENCES = "checkin_private";
    private static final String KEY_STATE = "state";
    private static final String PURPOSE = "checkin.state.v1";

    private final SharedPreferences preferences;

    public CheckinSettings(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public static final class State {
        public final String deviceId;
        public final String token;
        public final boolean paired;
        public final boolean revoked;
        public final boolean suspended;
        public final boolean paused;
        public final CheckinPolicy.Schedule schedule;
        public final long clockOffsetMs;
        public final long armedSlotMs;
        public final long armedOffsetMs;
        public final boolean exactAllowed;
        public final long lastReceiptMs;
        public final String userName;

        State(JSONObject json) {
            deviceId = json.optString("deviceId", "");
            token = json.optString("token", "");
            paired = json.optBoolean("paired", false);
            revoked = json.optBoolean("revoked", false);
            suspended = json.optBoolean("suspended", false);
            paused = json.optBoolean("paused", false);
            clockOffsetMs = json.optLong("clockOffsetMs", 0L);
            armedSlotMs = json.optLong("armedSlotMs", 0L);
            armedOffsetMs = json.optLong("armedOffsetMs", 0L);
            exactAllowed = json.optBoolean("exactAllowed", true);
            lastReceiptMs = json.optLong("lastReceiptMs", 0L);
            userName = json.optString("userName", "");
            schedule = storedSchedule(json);
        }

        public boolean isActive() {
            return paired && !revoked;
        }

        /** While the server refuses the account the phone only reports its health, no location. */
        public boolean canCapture() {
            return isActive() && !suspended;
        }

        /** Phone clock corrected by the last known server offset. */
        public long correctedNow() {
            return System.currentTimeMillis() + clockOffsetMs;
        }

        private static CheckinPolicy.Schedule storedSchedule(JSONObject json) {
            JSONObject stored = json.optJSONObject("settings");
            if (stored == null) return null;
            try {
                return CheckinPolicy.parseSchedule(stored);
            } catch (IllegalArgumentException error) {
                return null;
            }
        }
    }

    private interface Change {
        void apply(JSONObject json) throws JSONException;
    }

    public State load() {
        synchronized (LOCK) {
            try {
                return new State(readLocked());
            } catch (Exception error) {
                throw new IllegalStateException("Không đọc được cấu hình bảo mật của app.", error);
            }
        }
    }

    /** The token is generated once per code and kept, so a lost receipt can be replayed safely. */
    String beginPairing(String code) {
        synchronized (LOCK) {
            try {
                JSONObject json = readLocked();
                if (!code.equals(json.optString("pendingCode", ""))
                        || !CheckinPolicy.validToken(json.optString("pendingToken", ""))) {
                    json.put("pendingCode", code);
                    json.put("pendingToken", CheckinPolicy.newToken(new SecureRandom()));
                    persistLocked(json);
                }
                return json.getString("pendingToken");
            } catch (Exception error) {
                throw new IllegalStateException("Không ghi được mã máy.", error);
            }
        }
    }

    State completePairing(String token, JSONObject settings, long startedMs, long finishedMs, String userName) {
        CheckinPolicy.Schedule schedule = CheckinPolicy.parseSchedule(settings);
        long offset = CheckinPolicy.clockOffsetMs(schedule.serverNow, startedMs, finishedMs);
        return change(json -> {
            json.put("token", token);
            json.put("paired", true);
            json.put("revoked", false);
            json.put("suspended", false);
            json.put("paused", false);
            json.put("settings", settings);
            json.put("clockOffsetMs", offset);
            json.put("lastReceiptMs", finishedMs);
            json.put("userName", userName == null ? "" : userName);
            json.put("armedSlotMs", 0L);
            json.remove("pendingCode");
            json.remove("pendingToken");
        });
    }

    /** Stores server settings from a valid receipt; true when the alarm must be recomputed. */
    boolean applyServerSettings(JSONObject settings, long startedMs, long finishedMs) {
        CheckinPolicy.Schedule next = CheckinPolicy.parseSchedule(settings);
        long offset = CheckinPolicy.clockOffsetMs(next.serverNow, startedMs, finishedMs);
        boolean[] changed = new boolean[1];
        change(json -> {
            State previous = new State(json);
            changed[0] = previous.suspended || previous.schedule == null
                    || !previous.schedule.fingerprint().equals(next.fingerprint())
                    || Math.abs(previous.clockOffsetMs - offset) > CheckinPolicy.OFFSET_RESCHEDULE_MS;
            json.put("settings", settings);
            json.put("clockOffsetMs", offset);
            json.put("lastReceiptMs", finishedMs);
            json.put("suspended", false);
        });
        return changed[0];
    }

    State setPaused(boolean paused) {
        return change(json -> json.put("paused", paused));
    }

    State setArmed(long slotMs, boolean exactAllowed, long offsetMs) {
        return change(json -> {
            json.put("armedSlotMs", slotMs);
            json.put("armedOffsetMs", offsetMs);
            json.put("exactAllowed", exactAllowed);
        });
    }

    /** Only for the credential the server refused: a pairing completed meanwhile stays valid. */
    State markRevoked(String refusedToken) {
        return refuse(refusedToken, "revoked");
    }

    /** Cleared by the next valid receipt, so a server-side problem heals without pairing again. */
    State markSuspended(String refusedToken) {
        return refuse(refusedToken, "suspended");
    }

    private State refuse(String refusedToken, String flag) {
        return change(json -> {
            if (!refusedToken.equals(json.optString("token", ""))) return;
            json.put(flag, true);
            json.put("armedSlotMs", 0L);
        });
    }

    void clearForTest() {
        synchronized (LOCK) {
            preferences.edit().clear().commit();
        }
    }

    private State change(Change change) {
        synchronized (LOCK) {
            try {
                JSONObject json = readLocked();
                change.apply(json);
                persistLocked(json);
                return new State(json);
            } catch (Exception error) {
                throw new IllegalStateException("Không ghi được cấu hình bảo mật của app.", error);
            }
        }
    }

    private JSONObject readLocked() throws Exception {
        String encrypted = preferences.getString(KEY_STATE, null);
        if (encrypted == null) {
            JSONObject initial = new JSONObject();
            initial.put("deviceId", UUID.randomUUID().toString());
            persistLocked(initial);
            return initial;
        }
        return new JSONObject(SecureStorage.decrypt(encrypted, PURPOSE));
    }

    private void persistLocked(JSONObject json) throws Exception {
        String encrypted = SecureStorage.encrypt(json.toString(), PURPOSE);
        if (!preferences.edit().putString(KEY_STATE, encrypted).commit()) {
            throw new IllegalStateException("Không ghi được cấu hình.");
        }
    }
}
