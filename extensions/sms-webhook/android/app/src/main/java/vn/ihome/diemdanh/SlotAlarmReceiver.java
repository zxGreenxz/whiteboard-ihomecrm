package vn.ihome.diemdanh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Each firing arms the following slot first, then starts the capture for this one. */
public final class SlotAlarmReceiver extends BroadcastReceiver {
    public static final String ACTION_SLOT = "vn.ihome.diemdanh.action.SLOT";
    public static final String EXTRA_SLOT_MS = "slotMs";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION_SLOT.equals(intent.getAction())) return;
        long slotMs = intent.getLongExtra(EXTRA_SLOT_MS, 0L);
        if (slotMs <= 0L) return;
        Context app = context.getApplicationContext();
        CaptureService.holdWake(app);
        // Before anything else takes time: the diagnostics tell a late alarm from a late capture.
        SlotRecorder.Trigger trigger = SlotRecorder.Trigger.measure(app);
        try {
            SlotScheduler.armAfterFiring(app, slotMs);
        } catch (RuntimeException error) {
            // SafetyNetWork re-arms later; this slot must still be captured.
            android.util.Log.w("DiemDanhAlarm", "re-arm failed: " + error.getClass().getSimpleName());
        }
        try {
            app.startForegroundService(CaptureService.intent(app, slotMs, trigger));
        } catch (IllegalStateException | SecurityException denied) {
            // An inexact alarm without battery exemption may not start a foreground service.
            SlotRecorder.recordWithoutForeground(app, slotMs, trigger);
            CaptureService.releaseWake();
        }
    }
}
