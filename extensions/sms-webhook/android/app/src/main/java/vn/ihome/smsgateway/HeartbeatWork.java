package vn.ihome.smsgateway;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Android may defer periodic work; a quiet inbox is never evidence that a phone is offline. */
public final class HeartbeatWork extends Worker {
    private static final String PERIODIC = "gateway-heartbeat-periodic";
    private static final String IMMEDIATE = "gateway-heartbeat-immediate";

    public HeartbeatWork(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context, boolean sendNow) {
        WorkManager manager = WorkManager.getInstance(context.getApplicationContext());
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(HeartbeatWork.class, 15, TimeUnit.MINUTES)
                        .setInitialDelay(15, TimeUnit.MINUTES).setConstraints(constraints).build());
        if (sendNow) manager.enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.KEEP,
                new OneTimeWorkRequest.Builder(HeartbeatWork.class).setConstraints(constraints).build());
    }

    public static void cancel(Context context) {
        WorkManager manager = WorkManager.getInstance(context.getApplicationContext());
        manager.cancelUniqueWork(PERIODIC);
        manager.cancelUniqueWork(IMMEDIATE);
    }

    public static boolean hasNotificationAccess(Context context) {
        String granted = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (granted == null) return false;
        ComponentName ours = new ComponentName(context, BankNotificationListenerService.class);
        for (String component : granted.split(":")) {
            if (ours.equals(ComponentName.unflattenFromString(component))) return true;
        }
        return false;
    }

    @NonNull @Override public Result doWork() {
        try {
            Context context = getApplicationContext();
            GatewaySettings.Settings settings = new GatewaySettings(context).load();
            if (!settings.enabled) return Result.success();
            String version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            new QueueStore(context).enqueueHeartbeat(settings, hasNotificationAccess(context),
                    context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED,
                    version == null ? "unknown" : version);
            GatewayWork.scheduleHeartbeatDelivery(context);
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        }
    }
}
