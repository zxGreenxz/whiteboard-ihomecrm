package vn.ihome.diemdanh;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

/** Periodic repair: re-arms a lost alarm and tells the server how this phone is doing. */
public final class SafetyNetWork extends Worker {
    private static final String TAG = "DiemDanhSafetyNet";
    private static final String UNIQUE_NAME = "diemdanh-safety-net";

    public SafetyNetWork(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(SafetyNetWork.class, 15, TimeUnit.MINUTES).build());
    }

    public static void cancel(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(UNIQUE_NAME);
    }

    /** No network constraint: re-arming must work offline, and sending waits in DeliveryWork. */
    @NonNull @Override public Result doWork() {
        try {
            Context context = getApplicationContext();
            CheckinSettings.State state = new CheckinSettings(context).load();
            if (!state.isActive()) return Result.success();
            SlotScheduler.ensureArmed(context);
            new QueueStore(context).prune();
            reportDeviceState(context, state);
            return Result.success();
        } catch (Exception error) {
            Log.w(TAG, "safety net failed: " + error.getClass().getSimpleName());
            return Result.retry();
        }
    }

    static void reportDeviceState(Context context, CheckinSettings.State state) throws Exception {
        String recordedAt = CheckinPolicy.formatInstant(state.correctedNow());
        JSONObject event = CheckinPolicy.stateEvent(state.deviceId, recordedAt, DeviceHealth.snapshot(context, state.paused));
        new QueueStore(context).enqueueDeviceState(state, event.getString("id"), event.toString());
        DeliveryWork.schedule(context);
    }
}
