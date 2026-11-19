package vn.ihome.diemdanh;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.Instrumentation;
import android.app.PendingIntent;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.TextView;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.IOException;
import java.util.Collections;
import java.util.List;

import vn.ihome.smsgateway.BuildConfig;
import vn.ihome.smsgateway.GatewayFixtures;
import vn.ihome.smsgateway.GatewaySettings;
import vn.ihome.smsgateway.GatewayWork;
import vn.ihome.smsgateway.HeartbeatWork;
import vn.ihome.smsgateway.HomeActivity;

import static org.junit.Assert.*;

/**
 * The first screen of the merged app, on the disposable CI emulator. A stub transport keeps check-in
 * off the network; the one test that enables the gateway points it at the reserved example.test.
 */
@RunWith(AndroidJUnit4.class)
public final class HomeDeviceTest {
    static final String NOT_PAIRED = "Chưa ghép máy. Mở trang Điểm danh trên CRM rồi bấm “Mở app để ghép”.";
    static final String RECORDING = "Đã ghép máy — tự ghi vị trí theo mốc.";
    static final String NEEDS_SETUP = "Đã ghép máy — còn thiếu quyền, bấm để xử lý.";
    static final String GATEWAY_NOT_CONFIGURED = "Chưa cấu hình.";
    static final String GATEWAY_PAUSED = "Đang tạm dừng.";
    static final String GATEWAY_ON = "Đã bật chuyển tiếp.";
    private static final String CHECKIN_CARD = "Điểm danh";
    private static final String GATEWAY_CARD = "Biến động số dư";
    /** Passes the gateway's own validation; .test is reserved, so no server can ever answer it. */
    private static final String ENDPOINT = "https://example.test/webhook";
    private static final String TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String SOURCE = "00000000-0000-4000-8000-000000000001";
    private static final String BANK_APP = "fixture.bank";
    private static final String[] GATEWAY_WORK = {"sms-outbox-recovery", "sms-outbox"};
    private static final String[] HEARTBEAT_WORK = {"gateway-heartbeat-periodic", "gateway-heartbeat-immediate"};
    private static final String[] CHECKIN_WORK = {"diemdanh-outbox", "diemdanh-safety-net"};

    private Instrumentation instrumentation;
    private Context context;
    private UiAutomation automation;
    private CheckinSettings settings;
    private QueueStore queue;
    private GatewaySettings gateway;

    @Before public void isolate() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        context = ApplicationProvider.getApplicationContext();
        automation = instrumentation.getUiAutomation();
        DeliveryWork.transport = (endpoint, token, id, payload) -> new DeliveryWork.HttpResult(503, "", "application/json");
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        settings = new CheckinSettings(context);
        queue = new QueueStore(context);
        SlotScheduler.cancel(context);
        settings.clearForTest();
        queue.clearAll();
        gateway = new GatewaySettings(context);
        // Never enabled here: an enabled gateway schedules real deliveries. The one test that enables it
        // uses a host that cannot resolve and pauses it again before it ends.
        gateway.saveAll("", "", false, true, false, Collections.emptySet());
    }

    @After public void removeFixture() throws Exception {
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        SlotScheduler.cancel(context);
        settings.clearForTest();
        queue.clearAll();
        gateway.saveAll("", "", false, true, false, Collections.emptySet());
    }

    // ---- Manifest --------------------------------------------------------------------------

    @Test public void theOnlyLauncherEntryIsTheHomeScreen() {
        String app = context.getPackageName();
        PackageManager packages = context.getPackageManager();
        Intent launch = packages.getLaunchIntentForPackage(app);
        assertNotNull(launch);
        assertNotNull(launch.getComponent());
        assertEquals(app, launch.getComponent().getPackageName());
        assertEquals(HomeActivity.class.getName(), launch.getComponent().getClassName());
        List<ResolveInfo> entries = packages.queryIntentActivities(
                new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(app), 0);
        assertEquals("One icon in the app drawer", 1, entries.size());
        assertEquals(HomeActivity.class.getName(), entries.get(0).activityInfo.name);
    }

    @Test public void aPairLinkResolvesToThePairingScreenOfThisApp() {
        String app = context.getPackageName();
        PackageManager packages = context.getPackageManager();
        Intent link = new Intent(Intent.ACTION_VIEW, Uri.parse("ihomediemdanh://pair?c=" + Fixtures.PAIR_CODE))
                .addCategory(Intent.CATEGORY_BROWSABLE);
        List<ResolveInfo> own = packages.queryIntentActivities(new Intent(link).setPackage(app),
                PackageManager.MATCH_DEFAULT_ONLY);
        assertEquals(1, own.size());
        assertEquals(app, own.get(0).activityInfo.packageName);
        assertEquals(PairActivity.class.getName(), own.get(0).activityInfo.name);
        // What a browser does: no package is named, the system picks the handler.
        ResolveInfo chosen = packages.resolveActivity(link, PackageManager.MATCH_DEFAULT_ONLY);
        assertNotNull(chosen);
        assertEquals(app, chosen.activityInfo.packageName);
        assertEquals(PairActivity.class.getName(), chosen.activityInfo.name);
    }

    // ---- Status lines ----------------------------------------------------------------------

    @Test public void anUnpairedUnconfiguredPhoneSeesBothCardsAndNothingIsArmed() throws Exception {
        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            Fixtures.waitForText(scenario, NOT_PAIRED);
            Fixtures.waitForText(scenario, GATEWAY_NOT_CONFIGURED);
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                for (String text : new String[]{"iHome Gateway", "Phiên bản " + BuildConfig.VERSION_NAME,
                        CHECKIN_CARD, NOT_PAIRED, GATEWAY_CARD, "Chỉ dành cho máy được giao nhận tin ngân hàng.",
                        GATEWAY_NOT_CONFIGURED}) {
                    assertNotNull(text, findExact(root, text));
                }
            });
            instrumentation.waitForIdleSync();
            assertFalse("An unpaired phone arms nothing", SlotScheduler.isArmed(context));
            assertFalse(slotAlarmPending(automation));
            assertTrue("Home asks for nothing, so nothing may cover it", inFront(scenario));
        }
    }

    @Test public void aConfiguredButPausedGatewayIsShownAsPaused() throws Exception {
        gateway.saveAll(ENDPOINT, TOKEN, false, true, false, Collections.emptySet());
        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            Fixtures.waitForText(scenario, GATEWAY_PAUSED);
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                assertNotNull(findExact(root, GATEWAY_PAUSED));
                assertNotNull(findExact(root, NOT_PAIRED));
            });
        }
    }

    /** The phone that already forwards bank messages when the update arrives: Home is the first screen it opens. */
    @Test public void anEnabledGatewayIsShownAsOnKeepsItsConfigurationAndIsScheduledAgain() throws Exception {
        WorkManager works = WorkManager.getInstance(context);
        // Drops the cancelled records of earlier tests, so every record found below was enqueued by this visit.
        works.pruneWork().getResult().get();
        for (String[] names : new String[][]{GATEWAY_WORK, HEARTBEAT_WORK, CHECKIN_WORK, {"gateway-heartbeat-delivery"}}) {
            for (String name : names) assertTrue(name, works.getWorkInfosForUniqueWork(name).get().isEmpty());
        }

        gateway.saveAll(ENDPOINT, TOKEN, true, true, true, Collections.singleton(BANK_APP));
        GatewayFixtures.pinSource(gateway, ENDPOINT, TOKEN, SOURCE);
        GatewaySettings.Settings saved = gateway.load();
        assertEquals(ENDPOINT, saved.endpoint);
        assertEquals(TOKEN, saved.token);
        assertTrue(saved.enabled);
        assertFalse(saved.deviceId.isEmpty());
        assertTrue(saved.smsEnabled);
        assertTrue(saved.notificationsEnabled);
        assertEquals(Collections.singleton(BANK_APP), saved.notificationPackages);
        assertEquals(SOURCE, saved.pairedSourceId);
        String stored = storedGatewaySettings();
        assertFalse(stored.isEmpty());

        // Counts every permission request of this process, also one the system would answer without a dialog.
        Instrumentation.ActivityMonitor permissionRequests = instrumentation.addMonitor(
                new IntentFilter("android.content.pm.action.REQUEST_PERMISSIONS"), null, false);
        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            // Home sets both lines in one step, after its scheduling and the check-in repair have returned.
            Fixtures.waitForText(scenario, GATEWAY_ON);
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                assertNotNull(findExact(root, GATEWAY_ON));
                assertNotNull(findExact(root, NOT_PAIRED));
            });

            // The unique works the gateway screen schedules when it starts, under the same names.
            for (String name : GATEWAY_WORK) assertScheduled(name, GatewayWork.class);
            for (String name : HEARTBEAT_WORK) assertScheduled(name, HeartbeatWork.class);

            assertFalse("An unpaired phone arms nothing", SlotScheduler.isArmed(context));
            assertFalse(slotAlarmPending(automation));
            for (String name : CHECKIN_WORK) assertTrue(name, works.getWorkInfosForUniqueWork(name).get().isEmpty());

            instrumentation.waitForIdleSync();
            // A permission prompt is a separate screen on top; leave it time to arrive before looking.
            SystemClock.sleep(1_500L);
            assertTrue("Home asks for nothing, so nothing may cover it", inFront(scenario));
            assertEquals("Home must not request a permission", 0, permissionRequests.getHits());

            GatewaySettings.Settings reloaded = new GatewaySettings(context).load();
            assertEquals(saved.endpoint, reloaded.endpoint);
            assertEquals(saved.token, reloaded.token);
            assertEquals(saved.enabled, reloaded.enabled);
            assertEquals(saved.deviceId, reloaded.deviceId);
            assertEquals(saved.smsEnabled, reloaded.smsEnabled);
            assertEquals(saved.notificationsEnabled, reloaded.notificationsEnabled);
            assertEquals(saved.notificationPackages, reloaded.notificationPackages);
            assertEquals(saved.pairedSourceId, reloaded.pairedSourceId);
            // Every write encrypts under a fresh IV, so the same stored text means nothing was written at all.
            assertEquals("Home must not write the gateway configuration", stored, storedGatewaySettings());
        } finally {
            instrumentation.removeMonitor(permissionRequests);
            // Paused first, so a worker that is still running neither sends nor schedules more.
            gateway.saveAll("", "", false, true, false, Collections.emptySet());
            works.cancelAllWork().getResult().get();
            new vn.ihome.smsgateway.QueueStore(context).clearAll();
        }
    }

    @Test public void openingHomeRearmsALostAlarmOnAPairedPhone() throws Exception {
        makeCheckinHealthy();
        Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        long armed = settings.load().armedSlotMs;
        assertTrue(armed > 0L);
        // What a vendor battery manager does: the alarm is gone while the app still believes it is set.
        PendingIntent lost = SlotScheduler.existingAlarm(context);
        context.getSystemService(AlarmManager.class).cancel(lost);
        lost.cancel();
        assertFalse(SlotScheduler.isArmed(context));
        assertFalse("A cancelled alarm must not count as pending", slotAlarmPending(automation));

        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            Fixtures.waitForText(scenario, RECORDING);
            assertTrue(SlotScheduler.isArmed(context));
            assertEquals(armed, settings.load().armedSlotMs);
            assertTrue("The alarm exists in AlarmManager", slotAlarmPending(automation));
            scenario.onActivity(activity -> assertNotNull(findExact(activity.getWindow().getDecorView(), RECORDING)));
            instrumentation.waitForIdleSync();
            Fixtures.screenshot(automation, "home");
        }
    }

    @Test public void aPairedPhoneWithLocationSwitchedOffIsToldToFinishSetup() throws Exception {
        makeCheckinHealthy();
        Fixtures.pair(settings, Fixtures.quietSettings(3));
        switchLocation(false);
        try {
            assertFalse(DeviceHealth.locationEnabled(context));
            try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
                Fixtures.waitForText(scenario, NEEDS_SETUP);
                scenario.onActivity(activity ->
                        assertNotNull(findExact(activity.getWindow().getDecorView(), NEEDS_SETUP)));
            }
        } finally {
            switchLocation(true);
        }
    }

    // ---- Cards -----------------------------------------------------------------------------

    @Test public void eachCardOpensItsOwnScreenAndBackReturnsHome() throws Exception {
        // Paired, so the check-in screen stays open instead of forwarding to the pairing screen.
        Fixtures.pair(settings, Fixtures.quietSettings(3));
        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            Fixtures.waitForText(scenario, "Đã ghép máy");
            openThenGoBack(scenario, CHECKIN_CARD, MainActivity.class.getName());
            openThenGoBack(scenario, GATEWAY_CARD, vn.ihome.smsgateway.MainActivity.class.getName());
        }
    }

    private void openThenGoBack(ActivityScenario<HomeActivity> scenario, String title, String screen) {
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(screen, null, false);
        try {
            scenario.onActivity(activity -> {
                TextView heading = findExact(activity.getWindow().getDecorView(), title);
                assertNotNull(title, heading);
                View card = clickableAncestor(heading);
                assertNotNull("The whole card is the touch target", card);
                assertTrue("At least 48dp tall", card.getHeight() >= Ui.dp(activity, 48));
                assertTrue(card.performClick());
            });
            Activity opened = instrumentation.waitForMonitorWithTimeout(monitor, 10_000L);
            assertNotNull(title + " must open " + screen, opened);
            assertEquals(screen, opened.getClass().getName());
            // The handler the Back key reaches; calling it keeps the keyboard and window focus out of the test.
            instrumentation.runOnMainSync(opened::onBackPressed);
            long deadline = SystemClock.uptimeMillis() + 10_000L;
            while (!inFront(scenario) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100L);
            assertTrue("Back from " + title + " must return to Home", inFront(scenario));
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    // ---- Helpers ---------------------------------------------------------------------------

    /** True while AlarmManager holds a slot alarm of this app; cancelled alarms only remain in the removal history. */
    static boolean slotAlarmPending(UiAutomation automation) throws IOException {
        String dump = Fixtures.shell(automation, "dumpsys alarm");
        int history = dump.indexOf("Removal history");
        String live = history >= 0 ? dump.substring(0, history) : dump;
        return live.contains("tag=*walarm*:" + SlotAlarmReceiver.ACTION_SLOT);
    }

    /** A permission prompt or any other screen on top takes the scenario's activity out of RESUMED. */
    static boolean inFront(ActivityScenario<?> scenario) {
        try {
            return scenario.getState() == Lifecycle.State.RESUMED;
        } catch (RuntimeException betweenStates) {
            return false;
        }
    }

    /** The gateway configuration exactly as it lies on disk, encrypted. */
    private String storedGatewaySettings() {
        return context.getSharedPreferences("gateway_private", Context.MODE_PRIVATE).getString("settings", "");
    }

    /** Waits for a record of this unique work that was not cancelled; the enqueue runs on WorkManager's own thread. */
    private void assertScheduled(String name, Class<?> worker) throws Exception {
        WorkManager works = WorkManager.getInstance(context);
        long deadline = SystemClock.uptimeMillis() + 10_000L;
        WorkInfo found = null;
        while (found == null) {
            for (WorkInfo info : works.getWorkInfosForUniqueWork(name).get()) {
                if (info.getState() != WorkInfo.State.CANCELLED) found = info;
            }
            if (found == null) {
                assertTrue(name + " must be enqueued", SystemClock.uptimeMillis() < deadline);
                SystemClock.sleep(100L);
            }
        }
        assertTrue(name + " must run " + worker.getSimpleName(), found.getTags().contains(worker.getName()));
    }

    /** Everything the check-in screen counts as set up, as the check-in device tests grant it. */
    private void makeCheckinHealthy() throws IOException {
        String app = context.getPackageName();
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_FINE_LOCATION);
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_COARSE_LOCATION);
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) automation.grantRuntimePermission(app, Manifest.permission.POST_NOTIFICATIONS);
        Fixtures.shell(automation, "dumpsys deviceidle whitelist +" + app);
        switchLocation(true);
        assertTrue(DeviceHealth.locationEnabled(context));
    }

    /** Home reads the switch once per resume, so the change must have landed before Home is opened. */
    private void switchLocation(boolean enabled) throws IOException {
        if (Build.VERSION.SDK_INT >= 31) Fixtures.shell(automation, "cmd location set-location-enabled " + enabled);
        else Fixtures.shell(automation, "settings put secure location_mode " + (enabled ? "3" : "0"));
        long deadline = SystemClock.uptimeMillis() + 5_000L;
        while (DeviceHealth.locationEnabled(context) != enabled && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(50L);
        }
    }

    private static TextView findExact(View view, String text) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(text)) return (TextView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                TextView found = findExact(group.getChildAt(index), text);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static View clickableAncestor(View view) {
        ViewParent parent = view.getParent();
        while (parent instanceof View) {
            View candidate = (View) parent;
            if (candidate.isClickable()) return candidate;
            parent = candidate.getParent();
        }
        return null;
    }
}
