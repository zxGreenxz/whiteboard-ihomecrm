package vn.ihome.smsgateway;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.ScrollView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

/** Runs only in the disposable CI emulator. Uses reserved example.test and synthetic content. */
@RunWith(AndroidJUnit4.class)
public final class GatewayDeviceTest {
    private Context context;
    private QueueStore queue;
    private GatewaySettings settings;

    @Before public void prepareIsolatedFixture() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        queue = new QueueStore(context);
        queue.clearAll();
        settings = new GatewaySettings(context);
        settings.saveAll("https://example.test/webhook", "a".repeat(32), false,
                true, false, Collections.emptySet());
    }

    @After public void removeFixture() throws Exception {
        GatewaySettings.Settings current = settings.load();
        settings.save(current.endpoint, current.token, false);
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        queue.clearAll();
    }

    @Test public void settingsAndOutboxUseAndroidKeystoreAndDeduplicateSms() throws Exception {
        GatewaySettings.Settings current = settings.load();
        String persistedSettings = context.getSharedPreferences("gateway_private", Context.MODE_PRIVATE)
                .getString("settings", "");
        assertFalse(persistedSettings.contains(current.token));
        assertFalse(persistedSettings.contains(current.endpoint));
        assertEquals(current.deviceId, new GatewaySettings(context).load().deviceId);
        queue.enqueueSms(current, "FIXTURE", "OTP 123456 fixture", 1_700_000_000_000L, 1);
        queue.enqueueSms(current, "FIXTURE", "OTP 123456 fixture", 1_700_000_000_000L, 1);
        List<QueueStore.Pending> rows = queue.pending(20);
        assertEquals(1, rows.size());
        assertFalse(rows.get(0).encryptedPayload.contains("123456"));
        JSONObject payload = new JSONObject(rows.get(0).payload());
        assertEquals("OTP 123456 fixture", payload.getString("body"));
        assertEquals("2023-11-14T22:13:20Z", payload.getString("receivedAt"));
        queue.markSent(rows.get(0).id);
        assertEquals(0, queue.stats().pending);
        assertEquals(1, queue.stats().sent);
        queue.enqueueSms(current, "FIXTURE", "OTP 123456 fixture", 1_700_000_000_000L, 1);
        assertTrue(queue.pending(20).isEmpty());
    }

    @Test public void heartbeatIsDurablePrioritizedAndOnlyAcknowledgedAfterMarkSent() throws Exception {
        GatewaySettings.Settings current = settings.load();
        queue.enqueueSms(current, "FIXTURE", "Synthetic balance +1", 1_700_000_000_000L, null);
        queue.enqueueHeartbeat(current, true, false, "0.2.0-test");
        QueueStore restored = new QueueStore(context);
        assertEquals(0, restored.stats().lastHeartbeatAt);
        assertEquals(1, restored.stats().heartbeatPending);
        List<QueueStore.Pending> heartbeatRows = restored.pending(20, true);
        assertEquals(1, heartbeatRows.size());
        JSONObject payload = new JSONObject(heartbeatRows.get(0).payload());
        assertEquals("gateway.heartbeat", payload.getString("event"));
        assertTrue(payload.getBoolean("smsEnabled"));
        assertFalse(payload.getBoolean("notificationsEnabled"));
        assertTrue(payload.getBoolean("notificationAccess"));
        assertFalse(payload.getBoolean("smsPermission"));
        assertEquals("0.2.0-test", payload.getString("appVersion"));
        assertFalse(payload.has("body"));
        assertEquals(heartbeatRows.get(0).id, restored.pending(20).get(0).id);
        restored.markSent(heartbeatRows.get(0).id);
        assertEquals(0, restored.stats().heartbeatPending);
        assertTrue(restored.stats().lastHeartbeatAt > 0);
        assertEquals(1, restored.stats().pending);
        assertEquals(0, restored.stats().sent);
    }

    @Test public void sourceTokenChangeCannotRebindQueuedNotification() throws Exception {
        GatewaySettings.Settings firstSource = settings.load();
        queue.enqueueNotification(firstSource, "fixture.bank", "Fixture Bank", "fixture-key",
                1_700_000_000_000L, "Fixture title", "Synthetic balance +1");
        QueueStore.Pending row = queue.pending(20).get(0);
        settings.save(firstSource.endpoint, "b".repeat(32), false);
        assertNotEquals(row.destinationHash, GatewayPolicy.destinationBinding(
                settings.load().endpoint, settings.load().token));
        assertEquals("notification.received", new JSONObject(row.payload()).getString("event"));
        queue.clearPending();
        assertFalse(queue.isPending(row.id));
    }

    @Test public void onlyStructuredBoundCrmReceiptsCanPinTheSource() throws Exception {
        String id = "a".repeat(64);
        String source = "00000000-0000-4000-8000-000000000001";
        JSONObject data = new JSONObject().put("status", "heartbeat").put("eventId", JSONObject.NULL)
                .put("sourceId", source).put("externalId", id).put("acceptedAt", "2026-10-09T12:00:00Z");
        JSONObject receipt = new JSONObject().put("schemaVersion", 1).put("ok", true).put("data", data);
        assertEquals(source, GatewayWork.parseReceipt(receipt.toString(), id, "", true));
        assertThrows(GatewayWork.InvalidReceiptException.class,
                () -> GatewayWork.parseReceipt("<html>OK</html>", id, "", true));
        assertThrows(GatewayWork.InvalidReceiptException.class,
                () -> GatewayWork.parseReceipt("", id, "", true));
        data.remove("eventId");
        assertThrows(GatewayWork.InvalidReceiptException.class,
                () -> GatewayWork.parseReceipt(receipt.toString(), id, "", true));
        GatewaySettings.Settings current = settings.load();
        settings.confirmSource(current.endpoint, current.token, source);
        assertEquals(source, settings.load().pairedSourceId);
        assertThrows(IllegalArgumentException.class, () -> settings.confirmSource(current.endpoint,
                current.token, "00000000-0000-4000-8000-000000000002"));
        settings.save(current.endpoint, "b".repeat(32), false);
        assertEquals("", settings.load().pairedSourceId);
        assertEquals(0, queue.lastHeartbeatFor(current.endpoint, "b".repeat(32)));
    }

    @Test public void visibleSetupStartsPausedAndOffersSourceAndConnectionControls() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            long deadline = System.currentTimeMillis() + 5000;
            AtomicBoolean ready = new AtomicBoolean();
            while (!ready.get() && System.currentTimeMillis() < deadline) {
                scenario.onActivity(activity -> ready.set(containsText(activity.getWindow().getDecorView(), "○ Đang tạm dừng")));
                if (!ready.get()) Thread.sleep(50);
            }
            assertTrue("Startup must show the saved paused state", ready.get());
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                assertTrue(containsText(root, "1. Kết nối CRM"));
                assertTrue(containsText(root, "Chuyển tất cả SMS mới nhận"));
                assertTrue(containsText(root, "Chuyển thông báo từ app đã chọn"));
                assertTrue(containsText(root, "Kiểm tra kết nối ngay"));
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            capture("setup.png");
            scenario.onActivity(activity -> {
                ViewGroup content = activity.findViewById(android.R.id.content);
                ((ScrollView) content.getChildAt(0)).fullScroll(View.FOCUS_DOWN);
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            capture("status.png");
        }
    }

    private void capture(String filename) throws Exception {
        Bitmap screenshot = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        File evidence = new File(context.getFilesDir(), "evidence");
        assertTrue(evidence.isDirectory() || evidence.mkdirs());
        try (FileOutputStream output = new FileOutputStream(new File(evidence, filename))) {
            assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output));
        }
        screenshot.recycle();
    }

    private static boolean containsText(View view, String text) {
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
