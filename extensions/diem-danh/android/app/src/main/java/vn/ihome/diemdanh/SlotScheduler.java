package vn.ihome.diemdanh;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.time.Instant;

/** Keeps exactly one alarm, for the next slot; with no future slot there is no alarm at all. */
public final class SlotScheduler {
    private static final int REQUEST_CODE = 7001;

    private SlotScheduler() {}

    /** Idempotent: leaves a correct or currently firing alarm alone, otherwise arms the next slot. */
    public static void ensureArmed(Context context) {
        arm(context, 0L);
    }

    /** Called from an alarm: the fired slot is over, so the following one is armed. */
    public static void armAfterFiring(Context context, long firedSlotMs) {
        arm(context, firedSlotMs);
    }

    private static void arm(Context context, long firedSlotMs) {
        Context app = context.getApplicationContext();
        CheckinSettings settings = new CheckinSettings(app);
        CheckinSettings.State state = settings.load();
        long nowMs = state.correctedNow();
        Instant next = state.isActive()
                ? CheckinPolicy.nextSlot(state.schedule, Instant.ofEpochMilli(Math.max(nowMs, firedSlotMs)))
                : null;
        if (next == null) {
            cancel(app);
            return;
        }
        long nextMs = next.toEpochMilli();
        if (firedSlotMs == 0L && CheckinPolicy.keepArmed(state.armedSlotMs, existingAlarm(app) != null, nextMs, nowMs,
                state.armedOffsetMs, state.clockOffsetMs)) {
            return;
        }
        PendingIntent operation = PendingIntent.getBroadcast(app, REQUEST_CODE,
                alarmIntent(app).putExtra(SlotAlarmReceiver.EXTRA_SLOT_MS, nextMs),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager alarms = app.getSystemService(AlarmManager.class);
        boolean exact = setAlarm(alarms, nextMs - state.clockOffsetMs, operation);
        settings.setArmed(nextMs, exact, state.clockOffsetMs);
    }

    private static boolean setAlarm(AlarmManager alarms, long triggerAtMs, PendingIntent operation) {
        boolean permitted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        if (permitted) {
            try {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, operation);
                return true;
            } catch (SecurityException revokedMeanwhile) {
                // Falls through to the inexact alarm below.
            }
        }
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, operation);
        return false;
    }

    public static void cancel(Context context) {
        Context app = context.getApplicationContext();
        PendingIntent operation = existingAlarm(app);
        if (operation != null) {
            app.getSystemService(AlarmManager.class).cancel(operation);
            operation.cancel();
        }
        new CheckinSettings(app).setArmed(0L, DeviceHealth.exactAlarmAllowed(app), 0L);
    }

    static boolean isArmed(Context context) {
        return existingAlarm(context.getApplicationContext()) != null;
    }

    static PendingIntent existingAlarm(Context app) {
        return PendingIntent.getBroadcast(app, REQUEST_CODE, alarmIntent(app),
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
    }

    private static Intent alarmIntent(Context app) {
        return new Intent(app, SlotAlarmReceiver.class).setAction(SlotAlarmReceiver.ACTION_SLOT);
    }
}
