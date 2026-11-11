package vn.ihome.diemdanh;

import android.annotation.SuppressLint;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Turns a capture result into a persisted location.ping. */
final class SlotRecorder {
    private static final String TAG = "DiemDanhRecorder";

    private SlotRecorder() {}

    /**
     * What was true when the alarm was delivered. Measured in the receiver and carried to the service
     * as intent extras, so the diagnostics can tell a late alarm from a capture that started late.
     */
    static final class Trigger {
        private static final String EXTRA_WALL_MS = "triggerWallMs";
        private static final String EXTRA_ELAPSED_MS = "triggerElapsedMs";
        private static final String EXTRA_PROC_AGE_MS = "triggerProcAgeMs";
        private static final String EXTRA_SCREEN_ON = "triggerScreenOn";
        private static final String EXTRA_BUCKET = "triggerBucket";

        /** Phone clock, not yet corrected by the server offset. */
        final long wallMs;
        final long elapsedMs;
        /** Negative when unknown, like {@link #bucket}. */
        final long procAgeMs;
        final boolean screenOn;
        final int bucket;

        private Trigger(long wallMs, long elapsedMs, long procAgeMs, boolean screenOn, int bucket) {
            this.wallMs = wallMs;
            this.elapsedMs = elapsedMs;
            this.procAgeMs = procAgeMs;
            this.screenOn = screenOn;
            this.bucket = bucket;
        }

        /** Never throws: whatever cannot be read stays unknown. */
        static Trigger measure(Context context) {
            long wallMs = System.currentTimeMillis();
            long elapsedMs = SystemClock.elapsedRealtime();
            long procAgeMs = -1L;
            boolean screenOn = false;
            int bucket = -1;
            try {
                procAgeMs = elapsedMs - Process.getStartElapsedRealtime();
                PowerManager power = context.getSystemService(PowerManager.class);
                if (power != null) screenOn = power.isInteractive();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    UsageStatsManager usage = context.getSystemService(UsageStatsManager.class);
                    if (usage != null) bucket = usage.getAppStandbyBucket();
                }
            } catch (RuntimeException error) {
                Log.w(TAG, "trigger not fully measured: " + error.getClass().getSimpleName());
            }
            return new Trigger(wallMs, elapsedMs, procAgeMs, screenOn, bucket);
        }

        Intent putInto(Intent intent) {
            return intent.putExtra(EXTRA_WALL_MS, wallMs)
                    .putExtra(EXTRA_ELAPSED_MS, elapsedMs)
                    .putExtra(EXTRA_PROC_AGE_MS, procAgeMs)
                    .putExtra(EXTRA_SCREEN_ON, screenOn)
                    .putExtra(EXTRA_BUCKET, bucket);
        }

        /** The receiver's measurements, or new ones when the service was started some other way. */
        static Trigger from(Context context, Intent intent) {
            if (intent == null || !intent.hasExtra(EXTRA_WALL_MS) || !intent.hasExtra(EXTRA_ELAPSED_MS)) {
                return measure(context);
            }
            return new Trigger(intent.getLongExtra(EXTRA_WALL_MS, 0L), intent.getLongExtra(EXTRA_ELAPSED_MS, 0L),
                    intent.getLongExtra(EXTRA_PROC_AGE_MS, -1L), intent.getBooleanExtra(EXTRA_SCREEN_ON, false),
                    intent.getIntExtra(EXTRA_BUCKET, -1));
        }
    }

    static long ageMs(Location location) {
        return Math.max(0L, (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L);
    }

    /** {@code cached} = not obtained by this capture: reported as stale, with its true age either way. */
    static CheckinPolicy.Fix toFix(Location location, boolean cached) {
        String status = cached ? CheckinPolicy.FIX_STALE : CheckinPolicy.FIX_FRESH;
        Double accuracy = location.hasAccuracy() ? Double.valueOf(location.getAccuracy()) : null;
        boolean mock = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? location.isMock() : location.isFromMockProvider();
        return CheckinPolicy.Fix.located(status, location.getLatitude(), location.getLongitude(), accuracy,
                location.getProvider(), ageMs(location), mock);
    }

    /**
     * The newest location the phone already holds, or null. Fused is asked by name because Android
     * hides it from the provider list before version 12. {@code heard} is a cached location a
     * listener was handed during the capture; it may be newer than all of them.
     */
    @SuppressLint("MissingPermission")
    static Location newestCached(Context context, Location heard) {
        Location newest = heard;
        try {
            LocationManager manager = context.getSystemService(LocationManager.class);
            List<String> providers = new ArrayList<>(manager.getProviders(true));
            if (!providers.contains(CheckinPolicy.SOURCE_FUSED)) providers.add(CheckinPolicy.SOURCE_FUSED);
            for (String provider : providers) {
                try {
                    Location candidate = manager.getLastKnownLocation(provider);
                    if (candidate != null && (newest == null
                            || candidate.getElapsedRealtimeNanos() > newest.getElapsedRealtimeNanos())) {
                        newest = candidate;
                    }
                } catch (SecurityException | IllegalArgumentException error) {
                    // A source this phone does not have must not hide what the others hold.
                    Log.w(TAG, "last known unavailable: " + error.getClass().getSimpleName());
                }
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "last known unavailable: " + error.getClass().getSimpleName());
        }
        return newest;
    }

    /** Falls back to whatever the phone already knows, reported as stale with its age. */
    static CheckinPolicy.Fix cachedOrTimeout(Location newest) {
        if (newest != null) {
            CheckinPolicy.Fix fix = toFix(newest, true);
            if (CheckinPolicy.usableLastKnown(fix.ageMs)) return fix;
        }
        return CheckinPolicy.Fix.none(CheckinPolicy.REASON_TIMEOUT);
    }

    /**
     * The diagnostics of a capture that began at the given clock readings and ends now, or null:
     * the ping is recorded without them rather than lost over them.
     */
    static JSONObject diag(Trigger trigger, CheckinSettings.State state, long slotMs, String path, String end,
                           boolean foreground, long startElapsedMs, long startUptimeMs, long lastKnownAgeMs,
                           List<CheckinPolicy.DiagSource> sources) {
        try {
            return CheckinPolicy.captureDiag(path, end,
                    trigger.wallMs + state.clockOffsetMs - slotMs,
                    startElapsedMs - trigger.elapsedMs,
                    SystemClock.elapsedRealtime() - startElapsedMs,
                    SystemClock.uptimeMillis() - startUptimeMs,
                    trigger.procAgeMs, trigger.screenOn, trigger.bucket, foreground, lastKnownAgeMs, sources);
        } catch (RuntimeException error) {
            Log.w(TAG, "diagnostics left out: " + error.getClass().getSimpleName());
            return null;
        }
    }

    static void record(Context context, long slotMs, CheckinSettings.State state, CheckinPolicy.Fix fix,
                       JSONObject diag) throws Exception {
        String slotAt = CheckinPolicy.formatInstant(slotMs);
        String recordedAt = CheckinPolicy.formatInstant(state.correctedNow());
        int version = state.schedule == null ? 0 : state.schedule.version;
        JSONObject event = CheckinPolicy.pingEvent(state.deviceId, slotAt, recordedAt, version, fix,
                DeviceHealth.snapshot(context, state.paused), diag);
        new QueueStore(context).enqueuePing(state, event.getString("id"), event.toString(), slotMs, fix.status, fix.reason);
        DeliveryWork.schedule(context);
    }

    /** Used only when Android refused the foreground service for this slot. */
    static void recordWithoutForeground(Context context, long slotMs, Trigger trigger) {
        try {
            long startElapsedMs = SystemClock.elapsedRealtime();
            long startUptimeMs = SystemClock.uptimeMillis();
            CheckinSettings.State state = new CheckinSettings(context).load();
            if (!state.canCapture()) return;
            String reason = CheckinPolicy.preCaptureReason(state.paused, DeviceHealth.locationPermission(context),
                    Build.VERSION.SDK_INT, DeviceHealth.locationEnabled(context));
            CheckinPolicy.Fix fix;
            String end;
            long lastKnownAgeMs = -1L;
            if (reason != null) {
                fix = CheckinPolicy.Fix.none(reason);
                end = CheckinPolicy.END_PRE;
            } else {
                Location newest = newestCached(context, null);
                fix = cachedOrTimeout(newest);
                end = CheckinPolicy.captureEnd(fix, true);
                if (newest != null) lastKnownAgeMs = ageMs(newest);
            }
            record(context, slotMs, state, fix, diag(trigger, state, slotMs, CheckinPolicy.DIAG_PATH_DIRECT, end,
                    false, startElapsedMs, startUptimeMs, lastKnownAgeMs, null));
        } catch (Exception error) {
            Log.w(TAG, "slot not recorded: " + error.getClass().getSimpleName());
        }
    }
}
