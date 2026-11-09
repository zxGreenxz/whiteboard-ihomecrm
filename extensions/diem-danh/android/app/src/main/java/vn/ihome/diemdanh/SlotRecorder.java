package vn.ihome.diemdanh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

/** Turns a capture result into a persisted location.ping. */
final class SlotRecorder {
    private static final String TAG = "DiemDanhRecorder";

    private SlotRecorder() {}

    static CheckinPolicy.Fix toFix(Location location, boolean lastKnown) {
        long ageMs = Math.max(0L, (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L);
        String status = lastKnown ? CheckinPolicy.FIX_STALE : CheckinPolicy.statusForAge(ageMs);
        Double accuracy = location.hasAccuracy() ? Double.valueOf(location.getAccuracy()) : null;
        boolean mock = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? location.isMock() : location.isFromMockProvider();
        return CheckinPolicy.Fix.located(status, location.getLatitude(), location.getLongitude(), accuracy,
                location.getProvider(), ageMs, mock);
    }

    /** Falls back to whatever the phone already knows, reported as stale with its age. */
    @SuppressLint("MissingPermission")
    static CheckinPolicy.Fix lastKnownOrTimeout(Context context) {
        try {
            LocationManager manager = context.getSystemService(LocationManager.class);
            Location newest = null;
            for (String provider : manager.getProviders(true)) {
                Location candidate = manager.getLastKnownLocation(provider);
                if (candidate != null && (newest == null
                        || candidate.getElapsedRealtimeNanos() > newest.getElapsedRealtimeNanos())) {
                    newest = candidate;
                }
            }
            if (newest != null) {
                CheckinPolicy.Fix fix = toFix(newest, true);
                if (CheckinPolicy.usableLastKnown(fix.ageMs)) return fix;
            }
        } catch (SecurityException | IllegalArgumentException error) {
            Log.w(TAG, "last known unavailable: " + error.getClass().getSimpleName());
        }
        return CheckinPolicy.Fix.none(CheckinPolicy.REASON_TIMEOUT);
    }

    static void record(Context context, long slotMs, CheckinSettings.State state, CheckinPolicy.Fix fix) throws Exception {
        String slotAt = CheckinPolicy.formatInstant(slotMs);
        String recordedAt = CheckinPolicy.formatInstant(state.correctedNow());
        int version = state.schedule == null ? 0 : state.schedule.version;
        JSONObject event = CheckinPolicy.pingEvent(state.deviceId, slotAt, recordedAt, version, fix,
                DeviceHealth.snapshot(context, state.paused));
        new QueueStore(context).enqueuePing(state, event.getString("id"), event.toString(), slotMs, fix.status, fix.reason);
        DeliveryWork.schedule(context);
    }

    /** Used only when Android refused the foreground service for this slot. */
    static void recordWithoutForeground(Context context, long slotMs) {
        try {
            CheckinSettings.State state = new CheckinSettings(context).load();
            if (!state.isActive()) return;
            String reason = CheckinPolicy.preCaptureReason(state.paused, DeviceHealth.locationPermission(context),
                    Build.VERSION.SDK_INT, DeviceHealth.locationEnabled(context));
            record(context, slotMs, state, reason != null ? CheckinPolicy.Fix.none(reason) : lastKnownOrTimeout(context));
        } catch (Exception error) {
            Log.w(TAG, "slot not recorded: " + error.getClass().getSimpleName());
        }
    }
}
