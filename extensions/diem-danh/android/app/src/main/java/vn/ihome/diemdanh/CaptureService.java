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
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

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
    private static final long WAKE_LOCK_MS = 60_000L;

    private static final Object WAKE_GUARD = new Object();
    private static PowerManager.WakeLock wakeLock;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable hardStop = this::stopNow;
    private final List<Listener> listeners = new ArrayList<>();
    private Handler worker;
    private LocationManager locationManager;
    private CheckinSettings.State state;
    private CheckinPolicy.Fix best;
    private long slotMs;
    private boolean foregroundOk;
    private boolean started;
    private boolean settling;
    private boolean concluded;

    static Intent intent(Context context, long slotMs) {
        return new Intent(context, CaptureService.class).putExtra(EXTRA_SLOT_MS, slotMs);
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
            if (!state.isActive()) {
                finish();
                return;
            }
            String reason = CheckinPolicy.preCaptureReason(state.paused, DeviceHealth.locationPermission(this),
                    Build.VERSION.SDK_INT, DeviceHealth.locationEnabled(this));
            // A background-started location service is refused without "Luôn cho phép".
            if (reason == null && !foregroundOk) reason = CheckinPolicy.REASON_PERMISSION_DENIED;
            if (reason != null) {
                conclude(CheckinPolicy.Fix.none(reason));
                return;
            }
            listen();
        } catch (RuntimeException error) {
            Log.w(TAG, "capture failed: " + error.getClass().getSimpleName());
            finish();
        }
    }

    private void listen() {
        locationManager = getSystemService(LocationManager.class);
        startProvider("fused");
        if (listeners.isEmpty()) {
            startFallbackProviders();
        } else {
            // Some phones expose a fused provider that never answers without Google services.
            worker.postDelayed(this::startFallbackProviders, FALLBACK_PROVIDERS_AFTER_MS);
        }
        worker.postDelayed(this::timeUp, WAIT_MS);
        if (listeners.isEmpty()) timeUp();
    }

    private void startFallbackProviders() {
        if (concluded || CheckinPolicy.acceptable(best)) return;
        startProvider(LocationManager.GPS_PROVIDER);
        startProvider(LocationManager.NETWORK_PROVIDER);
    }

    @SuppressLint("MissingPermission")
    private void startProvider(String provider) {
        try {
            if (!locationManager.getProviders(true).contains(provider)) return;
            Listener listener = new Listener();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // The older overload asks the fused provider for balanced power instead of precision.
                LocationRequest request = new LocationRequest.Builder(0L)
                        .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY).build();
                locationManager.requestLocationUpdates(provider, request, worker::post, listener);
            } else {
                locationManager.requestLocationUpdates(provider, 0L, 0f, listener, worker.getLooper());
            }
            listeners.add(listener);
        } catch (SecurityException | IllegalArgumentException error) {
            Log.w(TAG, "provider unavailable: " + error.getClass().getSimpleName());
        }
    }

    /** A quick coarse fix must not end the capture before GPS had its chance. */
    private void onFix(Location location) {
        if (concluded || location == null) return;
        best = CheckinPolicy.better(best, SlotRecorder.toFix(location, false));
        if (CheckinPolicy.goodEnough(best)) {
            conclude(best);
        } else if (CheckinPolicy.acceptable(best) && !settling) {
            settling = true;
            worker.postDelayed(() -> conclude(best), SETTLE_MS);
        }
    }

    private void timeUp() {
        if (concluded) return;
        conclude(best != null ? best : SlotRecorder.lastKnownOrTimeout(this));
    }

    private void conclude(CheckinPolicy.Fix fix) {
        if (concluded) return;
        concluded = true;
        removeListeners();
        try {
            SlotRecorder.record(this, slotMs, state, fix);
        } catch (Exception error) {
            Log.w(TAG, "slot not recorded: " + error.getClass().getSimpleName());
        }
        finish();
    }

    private void removeListeners() {
        if (locationManager == null) return;
        for (Listener listener : listeners) locationManager.removeUpdates(listener);
        listeners.clear();
    }

    private void finish() {
        main.post(this::stopNow);
    }

    private void stopNow() {
        main.removeCallbacks(hardStop);
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
        @Override public void onLocationChanged(Location location) {
            onFix(location);
        }

        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override public void onProviderEnabled(String provider) {}

        @Override public void onProviderDisabled(String provider) {}
    }
}
