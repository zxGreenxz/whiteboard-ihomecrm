package vn.ihome.diemdanh;

import android.Manifest;
import android.content.Context;
import android.os.Build;

/** What the home screen may ask of the check-in feature without opening its screens. */
public final class CheckinFeature {
    /** One line for the home screen; the check-in screen itself shows the details. */
    public enum Status { NOT_PAIRED, REVOKED, NEEDS_SETUP, SUSPENDED, PAUSED, SCHEDULE_OFF, RECORDING }

    private CheckinFeature() {}

    /** Opening the app repairs anything a vendor battery manager may have cleared; an unpaired phone is left alone. */
    public static void heal(Context context) {
        if (new CheckinSettings(context).load().isActive()) {
            SlotScheduler.ensureArmed(context);
            SafetyNetWork.schedule(context);
            DeliveryWork.schedule(context);
        }
    }

    /**
     * Only reads: no permission is requested and nothing is scheduled. NEEDS_SETUP uses the same
     * checks as the setup steps of the check-in screen; notifications are left out there as well,
     * because a capture works without them.
     */
    public static Status status(Context context) {
        CheckinSettings.State state = new CheckinSettings(context).load();
        if (!state.paired) return Status.NOT_PAIRED;
        if (state.revoked) return Status.REVOKED;
        boolean ready = DeviceHealth.granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
                && (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                        || DeviceHealth.granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION))
                && DeviceHealth.locationEnabled(context)
                && DeviceHealth.batteryOptimizationIgnored(context)
                && DeviceHealth.exactAlarmAllowed(context);
        if (!ready) return Status.NEEDS_SETUP;
        if (state.suspended) return Status.SUSPENDED;
        if (state.paused) return Status.PAUSED;
        CheckinPolicy.Schedule schedule = state.schedule;
        if (schedule == null || !schedule.enabled || !schedule.applies) return Status.SCHEDULE_OFF;
        return Status.RECORDING;
    }
}
