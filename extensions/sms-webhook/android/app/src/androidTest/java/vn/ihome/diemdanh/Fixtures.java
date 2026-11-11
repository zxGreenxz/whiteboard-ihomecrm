package vn.ihome.diemdanh;

import android.app.Activity;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertTrue;

/** Synthetic settings, records and screen helpers for the device tests; no real people or places. */
final class Fixtures {
    static final String PAIR_CODE = "ABCDEFGH23";

    private Fixtures() {}

    static JSONArray windows(String... fromTo) {
        JSONArray result = new JSONArray();
        for (int index = 0; index < fromTo.length; index += 2) {
            result.put(new JSONArray().put(fromTo[index]).put(fromTo[index + 1]));
        }
        return result;
    }

    static JSONObject settings(int version, boolean enabled, boolean applies, JSONArray windows, JSONArray offDates) throws Exception {
        return new JSONObject().put("version", version).put("enabled", enabled).put("applies", applies)
                .put("intervalMin", 15).put("toleranceMin", 10).put("windows", windows)
                .put("skipSunday", false).put("offDates", offDates)
                .put("tz", "Asia/Ho_Chi_Minh").put("serverNow", Instant.now().toString());
    }

    /** A window over an hour away, so no real alarm fires and no slot boundary passes during a test. */
    static JSONObject quietSettings(int version) throws Exception {
        int hour = Instant.now().atZone(CheckinPolicy.VIETNAM).getHour();
        String prefix = hour <= 21 ? String.format(Locale.ROOT, "%02d", hour + 2) : "08";
        return settings(version, true, true, windows(prefix + ":00", prefix + ":30"), new JSONArray());
    }

    static CheckinSettings.State pair(CheckinSettings store, JSONObject settings) {
        long now = System.currentTimeMillis();
        return store.completePairing(store.beginPairing(PAIR_CODE), settings, now, now, "Người thử");
    }

    static JSONObject device() throws Exception {
        return new JSONObject().put("sdkInt", 35).put("appVersion", "test").put("paused", false);
    }

    static JSONObject ping(CheckinSettings.State state, long slotMs, CheckinPolicy.Fix fix) throws Exception {
        return CheckinPolicy.pingEvent(state.deviceId, CheckinPolicy.formatInstant(slotMs),
                CheckinPolicy.formatInstant(slotMs + 7_000L), 3, fix, device());
    }

    static CheckinPolicy.Fix freshFix() {
        return CheckinPolicy.Fix.located(CheckinPolicy.FIX_FRESH, 10d, 106d, 12d, "fused", 800L, false);
    }

    static String receipt(String id, String status, JSONObject settings) throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("ok", true).put("data", new JSONObject()
                .put("status", status).put("externalId", id).put("acceptedAt", Instant.now().toString())
                .put("settings", settings)).toString();
    }

    // ---- Screens ---------------------------------------------------------------------------

    static String shell(UiAutomation automation, String command) throws IOException {
        ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new ParcelFileDescriptor.AutoCloseInputStream(descriptor), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) out.append(line).append('\n');
        }
        return out.toString();
    }

    /**
     * Waits for the first real frame, then captures as the shell user: the view tree can be ready
     * while the screen is still blank, and the app's own files vanish when AGP uninstalls it.
     */
    static void screenshot(UiAutomation automation, String name) throws IOException {
        long deadline = SystemClock.uptimeMillis() + 15_000L;
        boolean drawn = screenHasContent(automation);
        while (!drawn && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200L);
            drawn = screenHasContent(automation);
        }
        assertTrue("Nothing was drawn on screen for " + name, drawn);
        shell(automation, "screencap -p /data/local/tmp/diemdanh-" + name + ".png");
    }

    private static boolean screenHasContent(UiAutomation automation) {
        Bitmap frame = automation.takeScreenshot();
        if (frame == null) return false;
        Bitmap pixels = frame.copy(Bitmap.Config.ARGB_8888, false);
        frame.recycle();
        if (pixels == null) return false;
        try {
            int background = pixels.getPixel(pixels.getWidth() / 10, pixels.getHeight() / 2);
            for (int y = pixels.getHeight() / 8; y < pixels.getHeight() * 7 / 8; y += 7) {
                for (int x = 0; x < pixels.getWidth(); x += 7) {
                    if (pixels.getPixel(x, y) != background) return true;
                }
            }
            return false;
        } finally {
            pixels.recycle();
        }
    }

    static <A extends Activity> void waitForText(ActivityScenario<A> scenario, String text) {
        long deadline = SystemClock.uptimeMillis() + 10_000L;
        AtomicBoolean ready = new AtomicBoolean();
        while (!ready.get() && SystemClock.uptimeMillis() < deadline) {
            scenario.onActivity(activity -> ready.set(containsText(activity.getWindow().getDecorView(), text)));
            if (!ready.get()) SystemClock.sleep(50L);
        }
        assertTrue("Expected on screen: " + text, ready.get());
    }

    static boolean containsText(View view, String text) {
        if (view instanceof TextView && ((TextView) view).getText().toString().contains(text)) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                if (containsText(group.getChildAt(index), text)) return true;
            }
        }
        return false;
    }
}
