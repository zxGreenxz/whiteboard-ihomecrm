package vn.ihome.diemdanh;

import android.Manifest;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;

import org.junit.Test;
import org.junit.runner.RunWith;

import vn.ihome.smsgateway.HomeActivity;

import static org.junit.Assert.*;

/**
 * What a new user gets on first open. ci-device.sh runs this once, as the first step on a freshly
 * installed app: nothing has been granted and nothing has been written yet, so a permission prompt,
 * an alarm or a queued job found here was caused by opening Home.
 */
@RunWith(AndroidJUnit4.class)
public final class HomeCleanInstallProbe {
    @Test public void aFreshInstallOpensToHomeWithoutPromptsAlarmsOrWork() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = ApplicationProvider.getApplicationContext();
        UiAutomation automation = instrumentation.getUiAutomation();
        // Nothing should be delivered here; if something were, it must not reach the network.
        DeliveryWork.transport = (endpoint, token, id, payload) -> new DeliveryWork.HttpResult(503, "", "application/json");
        try (ActivityScenario<HomeActivity> scenario = ActivityScenario.launch(HomeActivity.class)) {
            Fixtures.waitForText(scenario, HomeDeviceTest.NOT_PAIRED);
            Fixtures.waitForText(scenario, HomeDeviceTest.GATEWAY_NOT_CONFIGURED);
            instrumentation.waitForIdleSync();
            // A permission prompt is a separate screen on top; leave it time to arrive before looking.
            SystemClock.sleep(1_500L);
            assertTrue("No prompt may cover Home on a fresh install", HomeDeviceTest.inFront(scenario));

            // The premise of the line above: had these been granted already, no prompt would prove nothing.
            for (String permission : new String[]{Manifest.permission.RECEIVE_SMS,
                    Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_BACKGROUND_LOCATION}) {
                assertEquals(permission, PackageManager.PERMISSION_DENIED, context.checkSelfPermission(permission));
            }
            if (Build.VERSION.SDK_INT >= 33) {
                assertEquals(PackageManager.PERMISSION_DENIED,
                        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS));
            }

            assertFalse("An unpaired phone arms nothing", SlotScheduler.isArmed(context));
            assertFalse(HomeDeviceTest.slotAlarmPending(automation));
            for (String work : new String[]{"diemdanh-outbox", "diemdanh-safety-net", "sms-outbox",
                    "sms-outbox-recovery", "gateway-heartbeat-periodic", "gateway-heartbeat-immediate",
                    "gateway-heartbeat-delivery"}) {
                assertTrue(work, WorkManager.getInstance(context).getWorkInfosForUniqueWork(work).get().isEmpty());
            }
            Fixtures.screenshot(automation, "home-clean");
        }
    }
}
