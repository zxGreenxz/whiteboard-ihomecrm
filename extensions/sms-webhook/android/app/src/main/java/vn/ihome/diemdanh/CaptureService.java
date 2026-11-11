package vn.ihome.diemdanh;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.LocationRequest;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import vn.ihome.smsgateway.R;

/** Short-lived foreground service: takes one location for one slot, queues it and stops. */
public final class CaptureService extends Service {
    private static final String TAG = "DiemDanhCapture";
    private static final String EXTRA_SLOT_MS = "slotMs";
    private static final String CHANNEL_ID = "diemdanh_capture";
    private static final int NOTIFICATION_ID = 7102;
    private static final long WAIT_MS = 38_000L;
    private static final long HARD_STOP_MS = 45_000L;
    private static final long SETTLE_MS = 6_000L;
    private static final long FALLBACK_PROVIDERS_AFTER_MS = 15_000L;
    /** For fixes that queued up behind an overdue timer to be heard before the capture gives up. */
    private static final long GRACE_MS = 1_500L;
    /** After the hard stop the worker gets this long to conclude; then the service stops regardless. */
    private static final long LAST_RESORT_MS = 5_000L;
    private static final long WAKE_LOCK_MS = 60_000L;

    private static final Object WAKE_GUARD = new Object();
    private static PowerManager.WakeLock wakeLock;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable hardStop = this::onHardStop;
    private final Runnable lastResort = this::stopNow;
    private final List<Listener> listeners = new ArrayList<>();
    private Handler worker;
    private LocationManager locationManager;
    private CheckinSettings.State state;
    private SlotRecorder.Trigger trigger;
    private CheckinPolicy.Fix best;
    /** Newest location a source replayed from before this capture: only ever the fallback. */
    private Location cached;
    private long slotMs;
    private long captureStartElapsedMs;
    private long captureStartUptimeMs;
    /** On the uptime clock, like every timer of the worker. */
    private long timeUpDueMs;
    private boolean foregroundOk;
    private boolean started;
    private boolean listening;
    private boolean settling;
    private boolean graceGiven;
    private boolean concluded;

    static Intent intent(Context context, long slotMs, SlotRecorder.Trigger trigger) {
        return trigger.putInto(new Intent(context, CaptureService.class).putExtra(EXTRA_SLOT_MS, slotMs));
    }

    /** Alarm delivery only keeps the CPU awake during onReceive; this bridges to the service. */
    static void holdWake(Context context) {
        synchronized (WAKE_GUARD) {
            if (wakeLock == null) {
                PowerManager power = context.getSystemService(PowerManager.class);
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ihome:diemdanh-capture");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(WAKE_LOCK_MS);
        }
    }

    static void releaseWake() {
        synchronized (WAKE_GUARD) {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        HandlerThread thread = new HandlerThread("diemdanh-capture");
        thread.start();
        worker = new Handler(thread.getLooper());
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // Must happen first on every start or Android kills the app for a missed foreground promise.
        foregroundOk = promote();
        if (started) return START_NOT_STICKY;
        final long slot = intent == null ? 0L : intent.getLongExtra(EXTRA_SLOT_MS, 0L);
        if (slot <= 0L) {
            stopNow();
            return START_NOT_STICKY;
        }
        started = true;
        slotMs = slot;
        trigger = SlotRecorder.Trigger.from(this, intent);
        main.postDelayed(hardStop, HARD_STOP_MS);
        worker.post(this::begin);
        return START_NOT_STICKY;
    }

    private boolean promote() {
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            return true;
        } catch (RuntimeException refused) {
            Log.w(TAG, "foreground refused: " + refused.getClass().getSimpleName());
            return false;
        }
    }

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Ghi vị trí theo mốc",
                NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("Đang ghi vị trí theo mốc điểm danh")
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setContentIntent(open)
                .build();
    }

    private void begin() {
        try {
            state = new CheckinSettings(this).load();
            if (!state.canCapture()) {
                finish();
                return;
            }
            captureStartElapsedMs = SystemClock.elapsedRealtime();
            captureStartUptimeMs = SystemClock.uptimeMillis();
            String reason = CheckinPolicy.preCaptureReason(state.paused, DeviceHealth.locationPermission(this),
                    Build.VERSION.SDK_INT, DeviceHealth.locationEnabled(this));
            // A background-started location service is refused without "Luôn cho phép".
            if (reason == null && !foregroundOk) reason = CheckinPolicy.REASON_PERMISSION_DENIED;
            if (reason != null) {
                conclude(CheckinPolicy.Fix.none(reason), CheckinPolicy.END_PRE, -1L);
                return;
            }
            listen();
        } catch (RuntimeException error) {
            Log.w(TAG, "capture failed: " + error.getClass().getSimpleName());
            finish();
        }
    }

    private void listen() {
        listening = true;
        locationManager = getSystemService(LocationManager.class);
        // First, so that it also hears what the requests below produce. Alone it is no reason to wait.
        startProvider(LocationManager.PASSIVE_PROVIDER, false);
        // By name: before Android 12 the provider list hides fused although it answers.
        boolean active = startProvider(CheckinPolicy.SOURCE_FUSED, false);
        if (CheckinPolicy.fallbackSourcesAtOnce(Build.VERSION.SDK_INT, active)) {
            active |= startFallbackProviders();
        } else {
            // Some phones expose a fused provider that never answers without Google services.
            worker.postDelayed(this::startFallbackProviders, FALLBACK_PROVIDERS_AFTER_MS);
        }
        if (active) {
            timeUpDueMs = SystemClock.uptimeMillis() + WAIT_MS;
            worker.postAtTime(this::timeUp, timeUpDueMs);
        } else {
            finishCapture(true);
        }
    }

    private boolean startFallbackProviders() {
        if (concluded || CheckinPolicy.acceptable(best)) return false;
        boolean gps = startProvider(LocationManager.GPS_PROVIDER, true);
        boolean network = startProvider(LocationManager.NETWORK_PROVIDER, true);
        return gps || network;
    }

    /**
     * Every attempt is kept, a failed one too: the diagnostics report what this phone offered.
     * {@code enabledOnly} because a switched-off provider registers and then never answers.
     */
    @SuppressLint("MissingPermission")
    private boolean startProvider(String provider, boolean enabledOnly) {
        Listener listener = new Listener(provider);
        listeners.add(listener);
        try {
            if (enabledOnly && !locationManager.getProviders(true).contains(provider)) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !LocationManager.PASSIVE_PROVIDER.equals(provider)) {
                // The older overload asks the fused provider for balanced power instead of precision.
                LocationRequest request = new LocationRequest.Builder(0L)
                        .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY).build();
                locationManager.requestLocationUpdates(provider, request, worker::post, listener);
            } else {
                locationManager.requestLocationUpdates(provider, 0L, 0f, listener, worker.getLooper());
            }
            listener.on = true;
        } catch (RuntimeException error) {
            // A source this phone does not have (fused, on some) must not cost the slot its other sources.
            Log.w(TAG, "provider unavailable: " + error.getClass().getSimpleName());
        }
        return listener.on;
    }

    /** A quick coarse fix must not end the capture before GPS had its chance. */
    private void onFix(Listener source, Location location) {
        if (concluded || location == null) return;
        source.heard(location);
        if (!CheckinPolicy.obtainedDuringCapture(location.getElapsedRealtimeNanos() / 1_000_000L,
                captureStartElapsedMs)) {
            // Replayed from before this capture: not this slot's position, at most the fallback.
            if (cached == null || location.getElapsedRealtimeNanos() > cached.getElapsedRealtimeNanos()) {
                cached = location;
            }
            return;
        }
        best = CheckinPolicy.better(best, SlotRecorder.toFix(location, false));
        if (CheckinPolicy.goodEnough(best)) {
            finishCapture(false);
        } else if (CheckinPolicy.acceptable(best) && !settling) {
            settling = true;
            worker.postDelayed(() -> finishCapture(false), SETTLE_MS);
        }
    }

    private void timeUp() {
        if (concluded || !listening || graceGiven) return;
        if (CheckinPolicy.graceForQueuedFixes(best != null, SystemClock.uptimeMillis() - timeUpDueMs)) {
            // Overdue after a freeze or a blocked thread, this check runs ahead of the fixes that queued
            // up meanwhile: they get one short chance to be heard, and the CPU is kept awake for it.
            // On time it concludes at once, so a capture without a live fix records no later than before.
            graceGiven = true;
            holdWake(this);
            // Not queued only when the service is already being destroyed: then conclude now.
            if (worker.postDelayed(() -> finishCapture(true), GRACE_MS)) return;
        }
        finishCapture(true);
    }

    /** Ends with the best live fix, else the newest location the phone already had, else none. */
    private void finishCapture(boolean atTimeLimit) {
        if (concluded) return;
        Location newest = SlotRecorder.newestCached(this, cached);
        CheckinPolicy.Fix fix = best != null ? best : SlotRecorder.cachedOrTimeout(newest);
        conclude(fix, CheckinPolicy.captureEnd(fix, atTimeLimit), newest == null ? -1L : SlotRecorder.ageMs(newest));
    }

    private void conclude(CheckinPolicy.Fix fix, String end, long lastKnownAgeMs) {
        if (concluded) return;
        concluded = true;
        // Read before the listeners are dropped: they hold what each source did.
        JSONObject diag = SlotRecorder.diag(trigger, state, slotMs, CheckinPolicy.DIAG_PATH_SERVICE, end,
                foregroundOk, captureStartElapsedMs, captureStartUptimeMs, lastKnownAgeMs, sources());
        removeListeners();
        try {
            SlotRecorder.record(this, slotMs, state, fix, diag);
        } catch (Exception error) {
            Log.w(TAG, "slot not recorded: " + error.getClass().getSimpleName());
        }
        finish();
    }

    private List<CheckinPolicy.DiagSource> sources() {
        List<CheckinPolicy.DiagSource> sources = new ArrayList<>();
        for (Listener listener : listeners) {
            sources.add(new CheckinPolicy.DiagSource(listener.source, listener.on, listener.count,
                    listener.firstMs, listener.bestM));
        }
        return sources;
    }

    private void removeListeners() {
        if (locationManager == null) return;
        for (Listener listener : listeners) {
            if (listener.on) locationManager.removeUpdates(listener);
        }
        listeners.clear();
    }

    private void finish() {
        main.post(this::stopNow);
    }

    /**
     * The service has run long enough, but the slot is not dropped: the worker concludes it the
     * normal way, and nothing waits here for that. Should the worker be stuck, the service still stops.
     */
    private void onHardStop() {
        holdWake(this);
        worker.post(this::timeUp);
        main.postDelayed(lastResort, LAST_RESORT_MS);
    }

    private void stopNow() {
        main.removeCallbacks(hardStop);
        main.removeCallbacks(lastResort);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        releaseWake();
    }

    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        worker.post(this::removeListeners);
        worker.getLooper().quitSafely();
        releaseWake();
        super.onDestroy();
    }

    /** Every callback is implemented: the defaults only exist on Android 11 and newer. */
    private final class Listener implements LocationListener {
        final String source;
        boolean on;
        long count;
        long firstMs = -1L;
        double bestM = Double.NaN;

        Listener(String source) {
            this.source = source;
        }

        /** Counts every callback, a replayed location too: the diagnostics show what the source did. */
        void heard(Location location) {
            count++;
            if (firstMs < 0L) firstMs = Math.max(0L, SystemClock.elapsedRealtime() - captureStartElapsedMs);
            if (location.hasAccuracy() && (Double.isNaN(bestM) || location.getAccuracy() < bestM)) {
                bestM = location.getAccuracy();
            }
        }

        @Override public void onLocationChanged(Location location) {
            onFix(this, location);
        }

        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override public void onProviderEnabled(String provider) {}

        @Override public void onProviderDisabled(String provider) {}
    }
}
