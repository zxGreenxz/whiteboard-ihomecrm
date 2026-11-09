package vn.ihome.diemdanh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Alarms do not survive a reboot or app update, so the schedule is rebuilt here. */
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        Context app = context.getApplicationContext();
        try {
            if (new CheckinSettings(app).load().isActive()) {
                SlotScheduler.ensureArmed(app);
                SafetyNetWork.schedule(app);
                DeliveryWork.schedule(app);
            }
        } catch (RuntimeException error) {
            Log.w("DiemDanhBoot", "re-arm failed: " + error.getClass().getSimpleName());
        }
    }
}
