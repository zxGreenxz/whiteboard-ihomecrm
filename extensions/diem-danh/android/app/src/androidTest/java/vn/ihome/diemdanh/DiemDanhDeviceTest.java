package vn.ihome.diemdanh;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.IOException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

/** Runs only on the disposable CI emulator; a fake transport keeps every test off the network. */
@RunWith(AndroidJUnit4.class)
public final class DiemDanhDeviceTest {
    private static final String JSON = "application/json; charset=utf-8";

    private Context context;
    private UiAutomation automation;
    private CheckinSettings settings;
    private QueueStore queue;
    private FakeTransport transport;

    private interface Responder {
        DeliveryWork.HttpResult respond(String id, String payload) throws IOException;
    }

    private static final class FakeTransport implements DeliveryWork.Transport {
        final List<String> ids = Collections.synchronizedList(new ArrayList<>());
        final List<String> tokens = Collections.synchronizedList(new ArrayList<>());
        volatile Responder responder = (id, payload) -> new DeliveryWork.HttpResult(503, "", JSON);

        @Override public DeliveryWork.HttpResult post(String endpoint, String token, String id, String payload) throws IOException {
            ids.add(id);
            tokens.add(token);
            return responder.respond(id, payload);
        }
    }

    @Before public void isolate() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        transport = new FakeTransport();
        DeliveryWork.transport = transport;
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        settings = new CheckinSettings(context);
        queue = new QueueStore(context);
        SlotScheduler.cancel(context);
        settings.clearForTest();
        queue.clearAll();
    }

    @After public void removeFixture() throws Exception {
        WorkManager.getInstance(context).cancelAllWork().getResult().get();
        SlotScheduler.cancel(context);
        settings.clearForTest();
        queue.clearAll();
    }

    // ---- Storage ---------------------------------------------------------------------------

    @Test public void credentialAndOutboxAreEncryptedAndASlotIsStoredOnce() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        assertTrue(CheckinPolicy.validToken(state.token));
        String stored = context.getSharedPreferences("checkin_private", Context.MODE_PRIVATE).getString("state", "");
        assertFalse(stored.isEmpty());
        assertFalse(stored.contains(state.token));
        assertFalse(stored.contains(state.deviceId));
        long slotMs = Instant.parse("2026-01-05T01:30:00Z").toEpochMilli();
        JSONObject first = Fixtures.ping(state, slotMs, Fixtures.freshFix());
        queue.enqueuePing(state, first.getString("id"), first.toString(), slotMs, CheckinPolicy.FIX_FRESH, null);
        JSONObject second = Fixtures.ping(state, slotMs, CheckinPolicy.Fix.none(CheckinPolicy.REASON_TIMEOUT));
        queue.enqueuePing(state, second.getString("id"), second.toString(), slotMs, CheckinPolicy.FIX_NONE, CheckinPolicy.REASON_TIMEOUT);
        List<QueueStore.Pending> rows = queue.pending(10);
        assertEquals(1, rows.size());
        assertFalse(rows.get(0).encryptedPayload.contains("location.ping"));
        assertEquals("The first stored payload is the one that is sent, so a retry cannot hit 409.",
                CheckinPolicy.FIX_FRESH, new JSONObject(rows.get(0).payload()).getJSONObject("fix").getString("status"));
    }

    @Test public void aNewCodeNeverReusesTheCredentialOfAnEarlierCode() {
        String first = settings.beginPairing("ABCDEFGH23");
        assertEquals("A lost receipt replays the same credential", first, settings.beginPairing("ABCDEFGH23"));
        assertNotEquals(first, settings.beginPairing("HGFEDCBA23"));
    }

    // ---- Delivery --------------------------------------------------------------------------

    private String enqueuePing(CheckinSettings.State state, long slotMs) throws Exception {
        JSONObject event = Fixtures.ping(state, slotMs, Fixtures.freshFix());
        queue.enqueuePing(state, event.getString("id"), event.toString(), slotMs, CheckinPolicy.FIX_FRESH, null);
        return event.getString("id");
    }

    private DeliveryWork.Outcome drain() {
        return DeliveryWork.drain(context, () -> false);
    }

    @Test public void onlyAPinnedReceiptMarksARecordSentAndNewSettingsReschedule() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        String id = enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        JSONObject next = Fixtures.settings(9, true, true, Fixtures.windows("00:00", "23:55"), new JSONArray());
        String valid = Fixtures.receipt(id, "accepted", next);

        transport.responder = (requestId, payload) -> { throw new IOException("offline"); };
        assertEquals(DeliveryWork.Outcome.RETRY, drain());
        assertEquals("Offline records stay queued", 1, queue.stats().pending);

        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(503, "", JSON);
        assertEquals(DeliveryWork.Outcome.RETRY, drain());
        assertEquals(1, queue.stats().pending);

        String[] notProof = {
                Fixtures.receipt("d".repeat(64), "accepted", next), Fixtures.receipt(id, "weird", next), "<html>OK</html>", ""};
        for (String body : notProof) {
            transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(200, body, JSON);
            assertEquals(DeliveryWork.Outcome.DONE, drain());
            assertEquals(body, 0, queue.stats().sent);
            assertEquals(body, 1, queue.stats().failed);
            queue.retryFailed();
        }
        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(200, valid, "text/html");
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertEquals("A receipt must be JSON", 0, queue.stats().sent);
        queue.retryFailed();

        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(201, valid, JSON);
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertEquals(1, queue.stats().sent);
        assertEquals(0, queue.stats().pending);
        assertEquals(state.token, transport.tokens.get(transport.tokens.size() - 1));
        assertEquals(id, transport.ids.get(transport.ids.size() - 1));
        assertEquals("Receipt settings are stored", 9, settings.load().schedule.version);
        assertTrue("Changed settings arm the schedule", SlotScheduler.isArmed(context));
    }

    @Test public void aRevokedDeviceStopsAndKeepsItsRecords() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(401, "{\"error\":\"unauthorized\"}", JSON);
        assertEquals(DeliveryWork.Outcome.REVOKED, drain());
        CheckinSettings.State after = settings.load();
        assertTrue(after.revoked);
        assertFalse(after.isActive());
        assertEquals(0L, after.armedSlotMs);
        assertFalse(SlotScheduler.isArmed(context));
        assertFalse("The alarm is gone from AlarmManager", armedInDumpsys());
        assertEquals(1, queue.stats().pending);
        int calls = transport.ids.size();
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertEquals("Nothing is sent after revocation", calls, transport.ids.size());
    }

    @Test public void aRefusedAccountStopsCapturingAndRecoversOnItsOwn() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        String id = enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(403, "{\"error\":\"forbidden\"}", JSON);
        assertEquals(DeliveryWork.Outcome.SUSPENDED, drain());
        CheckinSettings.State after = settings.load();
        assertTrue(after.suspended);
        assertFalse("A 403 never needs a new pairing", after.revoked);
        assertFalse("No capture while refused", after.canCapture());
        assertFalse(SlotScheduler.isArmed(context));
        assertFalse(armedInDumpsys());
        assertEquals("Records wait for the account", 1, queue.stats().pending);

        String accepted = Fixtures.receipt(id, "accepted", Fixtures.quietSettings(3));
        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(201, accepted, JSON);
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertTrue(settings.load().canCapture());
        assertEquals(1, queue.stats().sent);
        assertTrue("A valid receipt brings the alarm back", SlotScheduler.isArmed(context));
    }

    @Test public void aRefusalFromAGatewayOnlyRetries() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        transport.responder = (requestId, payload) -> new DeliveryWork.HttpResult(401, "{\"code\":401,\"message\":\"Invalid JWT\"}", JSON);
        assertEquals(DeliveryWork.Outcome.RETRY, drain());
        assertFalse(settings.load().revoked);
        assertTrue(SlotScheduler.isArmed(context));
        assertEquals(1, queue.stats().pending);
    }

    @Test public void aRefusalOfTheOldCredentialDoesNotUndoANewPairing() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        transport.responder = (requestId, payload) -> {
            // The person pairs again while the old credential's request is on its way.
            long now = System.currentTimeMillis();
            try {
                settings.completePairing(settings.beginPairing("HGFEDCBA23"), Fixtures.quietSettings(4), now, now, "Người khác");
            } catch (Exception error) {
                throw new IOException(error);
            }
            return new DeliveryWork.HttpResult(401, "{\"error\":\"unauthorized\"}", JSON);
        };
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertFalse(settings.load().revoked);
        assertEquals("The old record stays with the old pairing", 1, queue.stats().failed);
    }

    @Test public void recordsOfAnEarlierPairingAreNeverSentWithANewCredential() throws Exception {
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        enqueuePing(state, Instant.parse("2026-01-05T01:30:00Z").toEpochMilli());
        long now = System.currentTimeMillis();
        settings.completePairing(settings.beginPairing("HGFEDCBA23"), Fixtures.quietSettings(4), now, now, "Người khác");
        assertEquals(DeliveryWork.Outcome.DONE, drain());
        assertTrue(transport.ids.isEmpty());
        assertEquals(1, queue.stats().failed);
    }

    // ---- Alarms ----------------------------------------------------------------------------

    private LocalDate vietnamToday() {
        return Instant.now().atZone(CheckinPolicy.VIETNAM).toLocalDate();
    }

    /** Reads only the live part of the dump, since removed alarms stay in its history; window=0 is exact. */
    private boolean armedInDumpsys() throws IOException {
        String dump = shell("dumpsys alarm");
        int history = dump.indexOf("Removal history");
        String live = history >= 0 ? dump.substring(0, history) : dump;
        int tag = live.indexOf("tag=*walarm*:" + SlotAlarmReceiver.ACTION_SLOT);
        return tag >= 0 && live.substring(tag, Math.min(live.length(), tag + 400)).contains("window=0");
    }

    @Test public void theAlarmIsOnlyEverForASlotInsideTheWindow() throws Exception {
        ZonedDateTime now = Instant.now().atZone(CheckinPolicy.VIETNAM);
        boolean morning = now.getHour() < 12;
        int from = morning ? 13 * 60 : 8 * 60;
        int to = from + 30;
        String[] window = morning ? new String[]{"13:00", "13:30"} : new String[]{"08:00", "08:30"};
        Fixtures.pair(settings, Fixtures.settings(5, true, true, Fixtures.windows(window[0], window[1]), new JSONArray()));
        SlotScheduler.ensureArmed(context);
        CheckinSettings.State state = settings.load();
        assertTrue(SlotScheduler.isArmed(context));
        assertTrue(state.armedSlotMs > System.currentTimeMillis());
        ZonedDateTime armed = Instant.ofEpochMilli(state.armedSlotMs).atZone(CheckinPolicy.VIETNAM);
        int minute = armed.getHour() * 60 + armed.getMinute();
        assertTrue(armed.toString(), minute >= from && minute <= to);
        assertTrue("The alarm exists in AlarmManager", armedInDumpsys());
    }

    @Test public void noAlarmIsSetForAnOffDay() throws Exception {
        LocalDate today = vietnamToday();
        JSONArray twoWeeksOff = new JSONArray();
        for (int day = 0; day < 14; day++) twoWeeksOff.put(today.plusDays(day).toString());
        Fixtures.pair(settings, Fixtures.settings(5, true, true, Fixtures.windows("00:00", "23:55"), twoWeeksOff));
        SlotScheduler.ensureArmed(context);
        LocalDate armed = Instant.ofEpochMilli(settings.load().armedSlotMs).atZone(CheckinPolicy.VIETNAM).toLocalDate();
        assertFalse(armed.toString(), armed.isBefore(today.plusDays(14)));

        JSONArray everyDay = new JSONArray();
        for (int day = 0; day < 40; day++) everyDay.put(today.plusDays(day).toString());
        settings.applyServerSettings(Fixtures.settings(6, true, true, Fixtures.windows("00:00", "23:55"), everyDay),
                System.currentTimeMillis(), System.currentTimeMillis());
        SlotScheduler.ensureArmed(context);
        assertEquals("With no working day ahead there is no alarm", 0L, settings.load().armedSlotMs);
        assertFalse(SlotScheduler.isArmed(context));
    }

    @Test public void aDisabledOrUnappliedScheduleHasNoAlarm() throws Exception {
        Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        assertTrue(SlotScheduler.isArmed(context));
        assertTrue(armedInDumpsys());
        settings.applyServerSettings(Fixtures.settings(4, false, true, Fixtures.windows("00:00", "23:55"), new JSONArray()),
                System.currentTimeMillis(), System.currentTimeMillis());
        SlotScheduler.ensureArmed(context);
        assertFalse(SlotScheduler.isArmed(context));
        assertFalse(armedInDumpsys());
        settings.applyServerSettings(Fixtures.settings(5, true, false, Fixtures.windows("00:00", "23:55"), new JSONArray()),
                System.currentTimeMillis(), System.currentTimeMillis());
        SlotScheduler.ensureArmed(context);
        assertFalse(SlotScheduler.isArmed(context));
    }

    @Test public void aCorrectedPhoneClockRearmsTheSameSlot() throws Exception {
        JSONObject quiet = Fixtures.quietSettings(3);
        CheckinSettings.State state = Fixtures.pair(settings, quiet);
        SlotScheduler.ensureArmed(context);
        long armed = settings.load().armedSlotMs;
        assertEquals(state.clockOffsetMs, settings.load().armedOffsetMs);
        long startedMs = System.currentTimeMillis() - 720_000L;
        // serverNow is "now" while the phone believed it to be 12 minutes earlier.
        assertTrue(settings.applyServerSettings(quiet, startedMs, startedMs));
        SlotScheduler.ensureArmed(context);
        CheckinSettings.State after = settings.load();
        assertEquals("Still the same slot, so only the corrected clock can have moved the alarm", armed, after.armedSlotMs);
        assertEquals(after.clockOffsetMs, after.armedOffsetMs);
        assertTrue("The offset moved by about 12 minutes", Math.abs(after.armedOffsetMs - state.clockOffsetMs) > 700_000L);
    }

    @Test public void bootRearmsALostAlarmButNotForAnUnpairedPhone() throws Exception {
        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        assertFalse("An unpaired phone arms nothing", SlotScheduler.isArmed(context));

        Fixtures.pair(settings, Fixtures.quietSettings(3));
        SlotScheduler.ensureArmed(context);
        long armed = settings.load().armedSlotMs;
        PendingIntent lost = SlotScheduler.existingAlarm(context);
        context.getSystemService(AlarmManager.class).cancel(lost);
        lost.cancel();
        assertFalse(SlotScheduler.isArmed(context));

        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        assertTrue(SlotScheduler.isArmed(context));
        assertEquals(armed, settings.load().armedSlotMs);
        assertTrue(armedInDumpsys());

        // Installing a new version over the old one is handled like a reboot.
        PendingIntent lostToUpdate = SlotScheduler.existingAlarm(context);
        context.getSystemService(AlarmManager.class).cancel(lostToUpdate);
        lostToUpdate.cancel();
        assertFalse(SlotScheduler.isArmed(context));
        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
        assertTrue(SlotScheduler.isArmed(context));
        assertEquals(armed, settings.load().armedSlotMs);
    }

    // ---- Capture ---------------------------------------------------------------------------

    private void grantLocation() throws IOException {
        String app = context.getPackageName();
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_FINE_LOCATION);
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_COARSE_LOCATION);
        automation.grantRuntimePermission(app, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) automation.grantRuntimePermission(app, Manifest.permission.POST_NOTIFICATIONS);
        shell("dumpsys deviceidle whitelist +" + app);
        setLocationEnabled(true);
    }

    private void setLocationEnabled(boolean enabled) throws IOException {
        if (Build.VERSION.SDK_INT >= 31) shell("cmd location set-location-enabled " + enabled);
        else shell("settings put secure location_mode " + (enabled ? "3" : "0"));
    }

    private void fireSlot(long slotMs) {
        new SlotAlarmReceiver().onReceive(context,
                new Intent(SlotAlarmReceiver.ACTION_SLOT).putExtra(SlotAlarmReceiver.EXTRA_SLOT_MS, slotMs));
    }

    private JSONObject awaitPing(String id, long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            for (QueueStore.Pending row : queue.pending(50)) {
                if (id.equals(row.id)) return new JSONObject(row.payload());
            }
            SystemClock.sleep(100L);
        }
        throw new AssertionError("No ping was queued for the slot");
    }

    private Location mockLocation(String provider) {
        Location location = new Location(provider);
        location.setLatitude(10d);
        location.setLongitude(106d);
        location.setAccuracy(5f);
        location.setTime(System.currentTimeMillis());
        location.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
        return location;
    }

    @Test public void aFiredSlotQueuesAPingFromAMockLocationAndReportsTheMock() throws Exception {
        grantLocation();
        shell("appops set " + context.getPackageName() + " android:mock_location allow");
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(7));
        LocationManager manager = context.getSystemService(LocationManager.class);
        String[] providers = {"fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};
        for (String provider : providers) {
            manager.addTestProvider(provider, false, false, false, false, true, true, true, Criteria.POWER_LOW, Criteria.ACCURACY_FINE);
            manager.setTestProviderEnabled(provider, true);
        }
        AtomicBoolean feeding = new AtomicBoolean(true);
        AtomicReference<Throwable> feedError = new AtomicReference<>();
        Thread feeder = new Thread(() -> {
            try {
                while (feeding.get()) {
                    for (String provider : providers) manager.setTestProviderLocation(provider, mockLocation(provider));
                    SystemClock.sleep(200L);
                }
            } catch (RuntimeException error) {
                feedError.set(error);
            }
        });
        feeder.start();
        try {
            long slotMs = Instant.now().plusSeconds(60L).toEpochMilli();
            fireSlot(slotMs);
            JSONObject ping = awaitPing(CheckinPolicy.slotId(state.deviceId, CheckinPolicy.formatInstant(slotMs)), 40_000L);
            assertNull(feedError.get());
            assertEquals(CheckinPolicy.EVENT_PING, ping.getString("event"));
            JSONObject fix = ping.getJSONObject("fix");
            assertEquals(CheckinPolicy.FIX_FRESH, fix.getString("status"));
            assertEquals(10d, fix.getDouble("lat"), 0.0001d);
            assertEquals(106d, fix.getDouble("lng"), 0.0001d);
            assertTrue(fix.getBoolean("mock"));
            assertEquals(JSONObject.NULL, ping.get("reason"));
            assertEquals(7, ping.getInt("settingsVersion"));
            JSONObject device = ping.getJSONObject("device");
            assertEquals(CheckinPolicy.LOCATION_ALWAYS, device.getString("locationPermission"));
            assertTrue(device.getBoolean("locationEnabled"));
            assertFalse(device.getBoolean("paused"));
            CheckinPolicy.validateEvent(ping);
            // The ping also tells how the capture went: through the service, ended by this precise fix.
            JSONObject diag = ping.getJSONObject("diag");
            assertEquals(CheckinPolicy.DIAG_PATH_SERVICE, diag.getString("path"));
            assertEquals(CheckinPolicy.END_GOOD, diag.getString("end"));
            assertTrue(diag.getBoolean("foreground"));
            JSONArray keys = ping.names();
            assertEquals("diag is written last", "diag", keys.getString(keys.length() - 1));
            JSONObject sources = diag.getJSONObject("sources");
            assertTrue(sources.has(CheckinPolicy.SOURCE_PASSIVE));
            assertTrue(sources.has(CheckinPolicy.SOURCE_FUSED));
            int heard = 0;
            for (String name : new String[]{CheckinPolicy.SOURCE_FUSED, CheckinPolicy.SOURCE_GPS,
                    CheckinPolicy.SOURCE_NETWORK, CheckinPolicy.SOURCE_PASSIVE}) {
                JSONObject source = sources.optJSONObject(name);
                if (source != null) heard += source.getInt("n");
            }
            assertTrue("The fix came from one of the reported sources", heard >= 1);
        } finally {
            feeding.set(false);
            feeder.join(2_000L);
            for (String provider : providers) manager.removeTestProvider(provider);
        }
    }

    @Test public void aPausedSlotIsReportedAndTakesNoLocation() throws Exception {
        grantLocation();
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        settings.setPaused(true);
        SlotScheduler.ensureArmed(context);
        long slotMs = settings.load().armedSlotMs;
        assertTrue(slotMs > 0L);
        // Sends the real alarm PendingIntent, so the manifest receiver and the slot extra are exercised.
        SlotScheduler.existingAlarm(context).send();
        JSONObject ping = awaitPing(CheckinPolicy.slotId(state.deviceId, CheckinPolicy.formatInstant(slotMs)), 40_000L);
        assertEquals(1, ping.getJSONObject("fix").length());
        assertEquals(CheckinPolicy.FIX_NONE, ping.getJSONObject("fix").getString("status"));
        assertEquals(CheckinPolicy.REASON_PAUSED, ping.getString("reason"));
        assertTrue(ping.getJSONObject("device").getBoolean("paused"));
        JSONObject diag = ping.getJSONObject("diag");
        assertEquals(CheckinPolicy.END_PRE, diag.getString("end"));
        assertEquals("No source is even asked while paused", 0, diag.getJSONObject("sources").length());
        assertTrue("Each firing arms the following slot", settings.load().armedSlotMs > slotMs);
    }

    @Test public void aSlotWithLocationSwitchedOffReportsLocationOff() throws Exception {
        grantLocation();
        setLocationEnabled(false);
        try {
            long waitUntil = SystemClock.uptimeMillis() + 5_000L;
            while (DeviceHealth.locationEnabled(context) && SystemClock.uptimeMillis() < waitUntil) SystemClock.sleep(50L);
            assertFalse(DeviceHealth.locationEnabled(context));
            CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
            long slotMs = Instant.now().plusSeconds(180L).toEpochMilli();
            fireSlot(slotMs);
            JSONObject ping = awaitPing(CheckinPolicy.slotId(state.deviceId, CheckinPolicy.formatInstant(slotMs)), 40_000L);
            assertEquals(CheckinPolicy.FIX_NONE, ping.getJSONObject("fix").getString("status"));
            assertEquals(CheckinPolicy.REASON_LOCATION_OFF, ping.getString("reason"));
        } finally {
            setLocationEnabled(true);
        }
    }

    // ---- Screens ---------------------------------------------------------------------------

    @Test public void aPairLinkFillsTheCodeButTheManagerMustConfirm() throws Exception {
        Intent link = new Intent(context, PairActivity.class).setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("ihomediemdanh://pair?c=" + Fixtures.PAIR_CODE));
        try (ActivityScenario<PairActivity> scenario = ActivityScenario.launch(link)) {
            Fixtures.waitForText(scenario, "Đã nhận mã từ liên kết");
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                assertTrue(Fixtures.containsText(root, "Ghép máy với"));
                assertEquals(Fixtures.PAIR_CODE, findEditText(root).getText().toString());
            });
            assertTrue("A link alone must not pair the phone", transport.ids.isEmpty());
            assertFalse(settings.load().isActive());
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            Fixtures.screenshot(automation, "setup");
        }
    }

    @Test public void theStatusScreenShowsTheDeviceRowsAndThePauseButton() throws Exception {
        grantLocation();
        CheckinSettings.State state = Fixtures.pair(settings, Fixtures.quietSettings(3));
        long slotMs = Instant.parse("2026-01-05T01:30:00Z").toEpochMilli();
        enqueuePing(state, slotMs);
        SlotScheduler.ensureArmed(context);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            Fixtures.waitForText(scenario, "Máy đang tự ghi vị trí");
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                for (String label : new String[]{"Máy của bạn", "App điểm danh", "Quyền vị trí", "Chạy nền", "Pin",
                        "Dấu gần nhất", "Mốc kế tiếp", "Các mốc gần đây", "Tạm dừng",
                        "Phiên bản " + BuildConfig.VERSION_NAME}) {
                    assertTrue(label, Fixtures.containsText(root, label));
                }
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            Fixtures.screenshot(automation, "status");
        }
    }

    // ---- Helpers ---------------------------------------------------------------------------

    private String shell(String command) throws IOException {
        return Fixtures.shell(automation, command);
    }

    private static EditText findEditText(View view) {
        if (view instanceof EditText) return (EditText) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                EditText found = findEditText(group.getChildAt(index));
                if (found != null) return found;
            }
        }
        return null;
    }
}
