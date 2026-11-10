package vn.ihome.diemdanh;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.Assert.*;

public final class CheckinPolicyTest {
    private static final String DEVICE = "30000000-0000-4000-8000-000000000001";
    private static final String[] NO_OFF_DATES = {};
    private static final String[] MORNING = {"08:00", "11:30"};
    private static final String[] AFTERNOON = {"13:30", "17:30"};

    private static JSONObject settings(int interval, boolean skipSunday, String[] offDates, String[]... windows) throws Exception {
        JSONArray windowArray = new JSONArray();
        for (String[] window : windows) windowArray.put(new JSONArray().put(window[0]).put(window[1]));
        JSONArray offArray = new JSONArray();
        for (String date : offDates) offArray.put(date);
        return new JSONObject().put("version", 3).put("enabled", true).put("applies", true)
                .put("intervalMin", interval).put("toleranceMin", 10).put("windows", windowArray)
                .put("skipSunday", skipSunday).put("offDates", offArray)
                .put("tz", "Asia/Ho_Chi_Minh").put("serverNow", "2026-01-05T01:30:09.000Z");
    }

    private static CheckinPolicy.Schedule schedule(int interval, boolean skipSunday, String[] offDates, String[]... windows) throws Exception {
        return CheckinPolicy.parseSchedule(settings(interval, skipSunday, offDates, windows));
    }

    private static void assertNext(String expected, CheckinPolicy.Schedule schedule, String after) {
        assertEquals(Instant.parse(expected), CheckinPolicy.nextSlot(schedule, Instant.parse(after)));
    }

    // Slot arithmetic. 2026-01-05 is a Monday; 08:00 in Vietnam is 01:00 UTC.

    @Test public void opensAtTheStartOfTheWindow() throws Exception {
        assertNext("2026-01-05T01:00:00Z", schedule(30, true, NO_OFF_DATES, MORNING, AFTERNOON), "2026-01-05T00:59:00Z");
    }

    @Test public void nextSlotIsStrictlyAfterTheGivenInstant() throws Exception {
        CheckinPolicy.Schedule s = schedule(30, true, NO_OFF_DATES, MORNING);
        assertNext("2026-01-05T01:30:00Z", s, "2026-01-05T01:00:00Z");
        assertNext("2026-01-05T01:30:00Z", s, "2026-01-05T01:29:59Z");
    }

    @Test public void endOfTheWindowIsAnInclusiveSlotAndThenTheNextWindowOpens() throws Exception {
        CheckinPolicy.Schedule s = schedule(30, true, NO_OFF_DATES, MORNING, AFTERNOON);
        assertNext("2026-01-05T04:30:00Z", s, "2026-01-05T04:00:00Z");
        assertNext("2026-01-05T06:30:00Z", s, "2026-01-05T04:30:00Z");
    }

    @Test public void slotsStepFromTheWindowStartNotFromTheHour() throws Exception {
        CheckinPolicy.Schedule s = schedule(15, true, NO_OFF_DATES, new String[]{"08:10", "08:55"});
        assertNext("2026-01-05T01:25:00Z", s, "2026-01-05T01:10:00Z");
        assertNext("2026-01-05T01:55:00Z", s, "2026-01-05T01:40:00Z");
        assertNext("2026-01-06T01:10:00Z", s, "2026-01-05T01:55:00Z");
    }

    @Test public void aSlotPastTheWindowEndDoesNotExist() throws Exception {
        CheckinPolicy.Schedule s = schedule(60, true, NO_OFF_DATES, new String[]{"08:00", "10:30"});
        assertNext("2026-01-05T03:00:00Z", s, "2026-01-05T02:30:00Z");
        assertNext("2026-01-06T01:00:00Z", s, "2026-01-05T03:00:00Z");
    }

    @Test public void afterTheLastWindowMovesToTheNextDay() throws Exception {
        assertNext("2026-01-06T01:00:00Z", schedule(30, true, NO_OFF_DATES, MORNING, AFTERNOON), "2026-01-05T10:30:00Z");
    }

    @Test public void sundayIsSkippedOnlyWhenConfigured() throws Exception {
        String saturdayEvening = "2026-01-03T12:00:00Z";
        assertNext("2026-01-05T01:00:00Z", schedule(30, true, NO_OFF_DATES, MORNING), saturdayEvening);
        assertNext("2026-01-04T01:00:00Z", schedule(30, false, NO_OFF_DATES, MORNING), saturdayEvening);
    }

    @Test public void offDatesAreSkippedEvenInARow() throws Exception {
        assertNext("2026-01-08T01:00:00Z", schedule(30, true, new String[]{"2026-01-06", "2026-01-07"}, MORNING),
                "2026-01-05T12:00:00Z");
    }

    @Test public void theCalendarDayIsVietnamsNotUtcs() throws Exception {
        // 17:30 UTC on Saturday is already 00:30 on Sunday in Vietnam.
        assertNext("2026-01-05T01:00:00Z", schedule(30, true, NO_OFF_DATES, MORNING), "2026-01-03T17:30:00Z");
        // 18:00 UTC on Monday the 5th is 01:00 on the 6th, which is the off date.
        assertNext("2026-01-07T01:00:00Z", schedule(30, true, new String[]{"2026-01-06"}, MORNING), "2026-01-05T18:00:00Z");
    }

    @Test public void vietnamHasNoDaylightSavingAroundWesternClockChanges() throws Exception {
        CheckinPolicy.Schedule s = schedule(30, false, NO_OFF_DATES, MORNING);
        for (String day : new String[]{"2026-03-08", "2026-03-29", "2026-10-25", "2026-11-01"}) {
            assertNext(day + "T01:00:00Z", s, day + "T00:00:00Z");
        }
    }

    @Test public void disabledUnappliedAndEmptySchedulesProduceNoSlot() throws Exception {
        Instant any = Instant.parse("2026-01-05T00:00:00Z");
        assertNull(CheckinPolicy.nextSlot(CheckinPolicy.parseSchedule(settings(30, true, NO_OFF_DATES, MORNING).put("enabled", false)), any));
        assertNull(CheckinPolicy.nextSlot(CheckinPolicy.parseSchedule(settings(30, true, NO_OFF_DATES, MORNING).put("applies", false)), any));
        assertNull(CheckinPolicy.nextSlot(schedule(30, true, NO_OFF_DATES), any));
        assertNull(CheckinPolicy.nextSlot(null, any));
    }

    @Test public void offDatesCoveringTheWholeHorizonProduceNoSlot() throws Exception {
        String[] everyDay = new String[40];
        for (int day = 0; day < everyDay.length; day++) everyDay[day] = LocalDate.parse("2026-01-05").plusDays(day).toString();
        assertNull(CheckinPolicy.nextSlot(schedule(30, false, everyDay, MORNING), Instant.parse("2026-01-05T00:00:00Z")));
    }

    @Test public void everySlotForTwoWeeksIsInsideAWindowOnAWorkingDay() throws Exception {
        LocalDate offDate = LocalDate.parse("2026-01-07");
        CheckinPolicy.Schedule s = schedule(15, true, new String[]{offDate.toString()}, MORNING, AFTERNOON);
        Instant start = Instant.parse("2026-01-03T17:00:00Z");
        for (int minute = 0; minute < 14 * 24 * 60; minute += 7) {
            Instant after = start.plusSeconds(minute * 60L);
            Instant slot = CheckinPolicy.nextSlot(s, after);
            assertTrue(slot.isAfter(after));
            ZonedDateTime local = slot.atZone(CheckinPolicy.VIETNAM);
            assertNotEquals(DayOfWeek.SUNDAY, local.getDayOfWeek());
            assertNotEquals(offDate, local.toLocalDate());
            int ofDay = local.getHour() * 60 + local.getMinute();
            boolean morning = ofDay >= 480 && ofDay <= 690 && (ofDay - 480) % 15 == 0;
            boolean afternoon = ofDay >= 810 && ofDay <= 1050 && (ofDay - 810) % 15 == 0;
            assertTrue(local.toString(), morning || afternoon);
        }
    }

    // What the server sends.

    @Test public void settingsWithAnUnknownIntervalOrBadShapeAreRejected() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.parseSchedule(null));
        for (JSONObject bad : new JSONObject[]{
                settings(45, true, NO_OFF_DATES, MORNING),
                settings(30, true, NO_OFF_DATES, new String[]{"11:30", "08:00"}),
                settings(30, true, NO_OFF_DATES, new String[]{"8:00", "11:30"}),
                settings(30, true, new String[]{"not-a-date"}, MORNING),
                settings(30, true, NO_OFF_DATES, MORNING).put("tz", "Not/AZone"),
                settings(30, true, NO_OFF_DATES, MORNING).put("serverNow", "yesterday"),
                settings(30, true, NO_OFF_DATES, MORNING).put("enabled", "yes")}) {
            assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.parseSchedule(bad));
        }
    }

    @Test public void aNewServerClockAloneIsNotASettingsChange() throws Exception {
        CheckinPolicy.Schedule first = schedule(30, true, NO_OFF_DATES, MORNING);
        CheckinPolicy.Schedule sameClockLater = CheckinPolicy.parseSchedule(
                settings(30, true, NO_OFF_DATES, MORNING).put("serverNow", "2026-02-01T00:00:00Z"));
        assertEquals(first.fingerprint(), sameClockLater.fingerprint());
        assertNotEquals(first.fingerprint(), schedule(15, true, NO_OFF_DATES, MORNING).fingerprint());
        assertNotEquals(first.fingerprint(), schedule(30, true, new String[]{"2026-01-06"}, MORNING).fingerprint());
    }

    @Test public void clockOffsetIsMeasuredFromTheRequestMidpoint() {
        Instant server = Instant.ofEpochMilli(1_000_000L);
        assertEquals(5_000L, CheckinPolicy.clockOffsetMs(server, 994_000L, 996_000L));
        assertEquals(-20_000L, CheckinPolicy.clockOffsetMs(server, 1_019_000L, 1_021_000L));
    }

    // Identifiers and credentials.

    @Test public void idsFollowTheContractAndAreStable() throws Exception {
        String slotAt = "2026-01-05T01:30:00Z";
        assertEquals(sha256Hex(DEVICE + "|" + slotAt), CheckinPolicy.slotId(DEVICE, slotAt));
        assertEquals(CheckinPolicy.slotId(DEVICE, slotAt), CheckinPolicy.slotId(DEVICE, slotAt));
        assertNotEquals(CheckinPolicy.slotId(DEVICE, slotAt), CheckinPolicy.slotId(DEVICE, "2026-01-05T02:00:00Z"));
        assertEquals(sha256Hex(DEVICE + "|pair|ABCDEFGH23"), CheckinPolicy.pairId(DEVICE, "ABCDEFGH23"));
    }

    @Test public void slotInstantsFormatWithSeconds() {
        assertEquals("2026-01-05T01:30:00Z", CheckinPolicy.formatInstant(Instant.parse("2026-01-05T01:30:00Z").toEpochMilli()));
    }

    @Test public void tokensAre64LowercaseHexCharacters() {
        String token = CheckinPolicy.newToken(new SecureRandom());
        assertTrue(CheckinPolicy.validToken(token));
        assertNotEquals(token, CheckinPolicy.newToken(new SecureRandom()));
        assertFalse(CheckinPolicy.validToken("A".repeat(64)));
        assertFalse(CheckinPolicy.validToken("a".repeat(63)));
        assertFalse(CheckinPolicy.validToken(null));
    }

    @Test public void pairCodesAreNormalizedAndAmbiguousCharactersRejected() {
        assertEquals("ABCDEFGH23", CheckinPolicy.normalizePairCode(" abcd-efgh 23 "));
        for (String bad : new String[]{"abc", "IOIOIOIOIO", "0123456789", "ABCDEFGH234", "", null}) {
            assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.normalizePairCode(bad));
        }
    }

    @Test public void onlyTheAppsOwnPairLinkYieldsACode() {
        assertEquals("ABCDEFGH23", CheckinPolicy.codeFromLink("ihomediemdanh://pair?c=ABCDEFGH23"));
        assertEquals("ABCDEFGH23", CheckinPolicy.codeFromLink("ihomediemdanh://pair?x=1&c=abcdefgh23"));
        for (String bad : new String[]{"https://pair?c=ABCDEFGH23", "ihomediemdanh://evil?c=ABCDEFGH23",
                "ihomediemdanh://pair", "ihomediemdanh://pair?c=IOIOIOIOIO", "not a uri", null}) {
            assertNull(CheckinPolicy.codeFromLink(bad));
        }
    }

    @Test public void queuedRecordsAreBoundToTheCredentialThatCreatedThem() {
        String first = CheckinPolicy.destinationBinding("https://example.test/a", "a".repeat(64));
        assertEquals(first, CheckinPolicy.destinationBinding("https://example.test/a", "a".repeat(64)));
        assertNotEquals(first, CheckinPolicy.destinationBinding("https://example.test/a", "b".repeat(64)));
    }

    // Capture decisions.

    @Test public void reasonsBeforeTakingALocation() {
        assertEquals("paused", CheckinPolicy.preCaptureReason(true, "denied", 34, false));
        assertEquals("permission_denied", CheckinPolicy.preCaptureReason(false, "denied", 34, true));
        assertEquals("permission_denied", CheckinPolicy.preCaptureReason(false, "while_in_use", 30, true));
        assertEquals("location_off", CheckinPolicy.preCaptureReason(false, "always", 34, false));
        assertNull(CheckinPolicy.preCaptureReason(false, "always", 34, true));
        // Android 10 still lets a foreground service use a while-in-use grant.
        assertNull(CheckinPolicy.preCaptureReason(false, "while_in_use", 29, true));
    }

    @Test public void bestAccuracyWins() {
        CheckinPolicy.Fix coarse = CheckinPolicy.Fix.located("fresh", 10d, 106d, 80d, "network", 500L, false);
        CheckinPolicy.Fix fine = CheckinPolicy.Fix.located("fresh", 10.1d, 106.1d, 6d, "gps", 900L, false);
        CheckinPolicy.Fix unknown = CheckinPolicy.Fix.located("fresh", 10.2d, 106.2d, null, "network", 100L, false);
        assertSame(fine, CheckinPolicy.better(coarse, fine));
        assertSame(fine, CheckinPolicy.better(fine, coarse));
        assertSame(fine, CheckinPolicy.better(fine, unknown));
        assertSame(coarse, CheckinPolicy.better(unknown, coarse));
        assertSame(coarse, CheckinPolicy.better(null, coarse));
        assertSame(coarse, CheckinPolicy.better(coarse, null));
    }

    @Test public void aFreshFixBeatsACachedOneEvenIfLessPrecise() {
        CheckinPolicy.Fix cached = CheckinPolicy.Fix.located("stale", 10d, 106d, 5d, "fused", 600_000L, false);
        CheckinPolicy.Fix fresh = CheckinPolicy.Fix.located("fresh", 10.1d, 106.1d, 40d, "fused", 500L, false);
        assertSame(fresh, CheckinPolicy.better(cached, fresh));
        assertSame(fresh, CheckinPolicy.better(fresh, cached));
    }

    @Test public void onlyAFreshPreciseFixEndsTheCaptureEarly() {
        assertTrue(CheckinPolicy.goodEnough(CheckinPolicy.Fix.located("fresh", 10d, 106d, 25d, "gps", 1L, false)));
        assertFalse("fairly coarse", CheckinPolicy.goodEnough(CheckinPolicy.Fix.located("fresh", 10d, 106d, 26d, "gps", 1L, false)));
        assertFalse("cached", CheckinPolicy.goodEnough(CheckinPolicy.Fix.located("stale", 10d, 106d, 5d, "gps", 1L, false)));
        assertTrue(CheckinPolicy.acceptable(CheckinPolicy.Fix.located("fresh", 10d, 106d, 100d, "network", 1L, false)));
        assertFalse("A 900 m network fix keeps waiting for GPS",
                CheckinPolicy.acceptable(CheckinPolicy.Fix.located("fresh", 10d, 106d, 900d, "network", 1L, false)));
        assertFalse("unknown accuracy", CheckinPolicy.acceptable(CheckinPolicy.Fix.located("fresh", 10d, 106d, null, "gps", 1L, false)));
        assertFalse(CheckinPolicy.acceptable(null));
    }

    @Test public void onlyALocationObtainedDuringTheCaptureIsLive() {
        long start = 1_000_000L;
        assertTrue(CheckinPolicy.obtainedDuringCapture(start + 20_000L, start));
        assertTrue(CheckinPolicy.obtainedDuringCapture(start, start));
        assertTrue("just before listening began",
                CheckinPolicy.obtainedDuringCapture(start - CheckinPolicy.LIVE_SLACK_MS, start));
        assertFalse("replayed from a cache",
                CheckinPolicy.obtainedDuringCapture(start - CheckinPolicy.LIVE_SLACK_MS - 1L, start));
        assertFalse(CheckinPolicy.obtainedDuringCapture(start - 282_000L, start));
    }

    @Test public void gpsAndNetworkStartAtOnceBeforeAndroid12OrWithoutFused() {
        assertTrue(CheckinPolicy.fallbackSourcesAtOnce(29, true));
        assertTrue(CheckinPolicy.fallbackSourcesAtOnce(30, true));
        assertTrue(CheckinPolicy.fallbackSourcesAtOnce(30, false));
        assertFalse("Android 12 asks fused for high accuracy first", CheckinPolicy.fallbackSourcesAtOnce(31, true));
        assertFalse(CheckinPolicy.fallbackSourcesAtOnce(35, true));
        assertTrue("no fused provider to wait for", CheckinPolicy.fallbackSourcesAtOnce(35, false));
    }

    @Test public void onlyALateTimeUpWaitsForFixesQueuedBehindIt() {
        assertFalse("on time, a capture without a fix records at once", CheckinPolicy.graceForQueuedFixes(false, 0L));
        assertFalse(CheckinPolicy.graceForQueuedFixes(false, CheckinPolicy.TIME_UP_OVERDUE_MS));
        assertTrue(CheckinPolicy.graceForQueuedFixes(false, CheckinPolicy.TIME_UP_OVERDUE_MS + 1L));
        assertTrue("thawed after minutes of freeze", CheckinPolicy.graceForQueuedFixes(false, 185_000L));
        assertFalse("a live fix is already there", CheckinPolicy.graceForQueuedFixes(true, 185_000L));
        assertFalse("the hard stop of a capture that only just began",
                CheckinPolicy.graceForQueuedFixes(false, -30_000L));
    }

    @Test public void theEndLabelSaysHowTheCaptureFinished() {
        CheckinPolicy.Fix precise = CheckinPolicy.Fix.located("fresh", 10d, 106d, 12d, "gps", 1L, false);
        CheckinPolicy.Fix fair = CheckinPolicy.Fix.located("fresh", 10d, 106d, 60d, "network", 1L, false);
        CheckinPolicy.Fix coarse = CheckinPolicy.Fix.located("fresh", 10d, 106d, 900d, "network", 1L, false);
        CheckinPolicy.Fix cached = CheckinPolicy.Fix.located("stale", 10d, 106d, 5d, "fused", 282_000L, false);
        assertEquals("good", CheckinPolicy.captureEnd(precise, false));
        assertEquals("settled", CheckinPolicy.captureEnd(fair, false));
        assertEquals("best", CheckinPolicy.captureEnd(coarse, true));
        assertEquals("still settling when the time ran out", "best", CheckinPolicy.captureEnd(fair, true));
        assertEquals("last_known", CheckinPolicy.captureEnd(cached, true));
        assertEquals("none", CheckinPolicy.captureEnd(CheckinPolicy.Fix.none("timeout"), true));
        assertEquals("none", CheckinPolicy.captureEnd(null, true));
    }

    @Test public void cachedLocationsOlderThanAnHourStayOnThePhone() {
        assertTrue(CheckinPolicy.usableLastKnown(60L * 60L * 1000L));
        assertFalse(CheckinPolicy.usableLastKnown(60L * 60L * 1000L + 1L));
    }

    @Test public void aFiringAlarmIsNotReplacedButALostOneIs() {
        long now = 10_000_000L;
        assertTrue(CheckinPolicy.keepArmed(now + 60_000L, true, now + 60_000L, now, 0L, 0L));
        assertTrue("just came due", CheckinPolicy.keepArmed(now - 1_000L, true, now + 900_000L, now, 0L, 0L));
        assertTrue("held back by a sleeping phone", CheckinPolicy.keepArmed(now - 240_000L, true, now + 660_000L, now, 0L, 0L));
        assertFalse("long past due", CheckinPolicy.keepArmed(now - CheckinPolicy.ALARM_IN_FLIGHT_MS, true, now + 900_000L, now, 0L, 0L));
        assertTrue("a lost alarm must leave time to arm the following slot",
                CheckinPolicy.ALARM_IN_FLIGHT_MS < 15L * 60L * 1000L);
        assertFalse("settings moved the slot", CheckinPolicy.keepArmed(now + 60_000L, true, now + 120_000L, now, 0L, 0L));
        assertFalse("alarm gone", CheckinPolicy.keepArmed(now + 60_000L, false, now + 60_000L, now, 0L, 0L));
        assertFalse("nothing armed", CheckinPolicy.keepArmed(0L, true, now + 60_000L, now, 0L, 0L));
    }

    @Test public void aCorrectedPhoneClockMovesAnAlarmForTheSameSlot() {
        long now = 10_000_000L;
        long next = now + 60_000L;
        assertTrue(CheckinPolicy.keepArmed(next, true, next, now, 1_000L, 1_000L + CheckinPolicy.OFFSET_RESCHEDULE_MS));
        assertFalse(CheckinPolicy.keepArmed(next, true, next, now, 1_000L, 1_000L + CheckinPolicy.OFFSET_RESCHEDULE_MS + 1L));
        assertFalse("An alarm computed on the old clock is not about to fire",
                CheckinPolicy.keepArmed(now - 1_000L, true, next, now, 0L, CheckinPolicy.OFFSET_RESCHEDULE_MS + 1L));
    }

    @Test public void onlyTheIngestFunctionsOwnRefusalChangesTheAppsState() {
        assertTrue(CheckinPolicy.deviceRevoked(401, "{\"error\":\"unauthorized\"}"));
        assertTrue(CheckinPolicy.accountRefused(403, "{\"error\":\"forbidden\"}"));
        assertFalse("Supabase gateway", CheckinPolicy.deviceRevoked(401, "{\"code\":401,\"message\":\"Invalid JWT\"}"));
        assertFalse("proxy page", CheckinPolicy.accountRefused(403, "<html>Forbidden</html>"));
        assertFalse("empty", CheckinPolicy.deviceRevoked(401, ""));
        assertFalse("mixed up", CheckinPolicy.deviceRevoked(401, "{\"error\":\"forbidden\"}"));
        assertFalse("mixed up", CheckinPolicy.accountRefused(403, "{\"error\":\"unauthorized\"}"));
        assertFalse("A 403 never revokes", CheckinPolicy.deviceRevoked(403, "{\"error\":\"unauthorized\"}"));
        assertFalse("other status", CheckinPolicy.deviceRevoked(400, "{\"error\":\"unauthorized\"}"));
        assertFalse(CheckinPolicy.deviceRevoked(401, null));
        assertFalse(CheckinPolicy.accountRefused(403, null));
    }

    @Test public void retriesOnlyTransientHttpStatuses() {
        for (int status : new int[]{408, 429, 500, 503, 599}) assertTrue(CheckinPolicy.shouldRetry(status));
        for (int status : new int[]{200, 201, 400, 401, 403, 404, 409, 413, 415}) assertFalse(CheckinPolicy.shouldRetry(status));
    }

    @Test public void utf8LimitNeverSplitsACharacter() {
        assertEquals("abc", CheckinPolicy.boundedUtf8("abc", 3));
        assertEquals("ab", CheckinPolicy.boundedUtf8("abc", 2));
        assertEquals("đ", CheckinPolicy.boundedUtf8("đđ", 3));
        assertEquals("a", CheckinPolicy.boundedUtf8("a😀", 3));
        assertEquals("", CheckinPolicy.boundedUtf8(null, 3));
    }

    // Events: the same rules the edge function enforces.

    private static JSONObject device() throws Exception {
        return new JSONObject().put("batteryPct", 64).put("charging", false).put("idle", false).put("powerSave", false)
                .put("appVersion", "1.0.0").put("sdkInt", 34).put("locationPermission", "always")
                .put("batteryOptimizationIgnored", true);
    }

    private static CheckinPolicy.Fix freshFix() {
        return CheckinPolicy.Fix.located("fresh", 10d, 106d, 12d, "fused", 800L, false);
    }

    private static JSONObject ping(CheckinPolicy.Fix fix) throws Exception {
        return CheckinPolicy.pingEvent(DEVICE, "2026-01-05T01:30:00Z", "2026-01-05T01:30:07Z", 1, fix, device());
    }

    private static Set<String> keysOf(JSONObject json) {
        Set<String> keys = new TreeSet<>();
        Iterator<String> iterator = json.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }

    private static Set<String> setOf(String... values) {
        return new TreeSet<>(Arrays.asList(values));
    }

    @Test public void locationPingCarriesExactlyTheServerKeys() throws Exception {
        JSONObject event = ping(freshFix());
        assertEquals(setOf("schemaVersion", "event", "id", "deviceId", "recordedAt", "slotAt", "settingsVersion", "fix", "reason", "device"), keysOf(event));
        assertEquals(setOf("status", "lat", "lng", "accuracyM", "provider", "ageMs", "mock"), keysOf(event.getJSONObject("fix")));
        assertEquals(JSONObject.NULL, event.get("reason"));
        assertEquals(CheckinPolicy.slotId(DEVICE, "2026-01-05T01:30:00Z"), event.getString("id"));
    }

    @Test public void aSlotWithoutLocationCarriesOnlyStatusAndAReason() throws Exception {
        JSONObject event = ping(CheckinPolicy.Fix.none("location_off"));
        assertEquals(setOf("status"), keysOf(event.getJSONObject("fix")));
        assertEquals("location_off", event.getString("reason"));
    }

    @Test public void missingAccuracyIsSentAsNull() throws Exception {
        JSONObject fix = ping(CheckinPolicy.Fix.located("fresh", 10d, 106d, null, null, 1L, false)).getJSONObject("fix");
        assertEquals(JSONObject.NULL, fix.get("accuracyM"));
        assertEquals(JSONObject.NULL, fix.get("provider"));
    }

    @Test public void pairAndStateEventsMatchTheContract() throws Exception {
        JSONObject pair = CheckinPolicy.pairEvent(DEVICE, "ABCDEFGH23", "2026-01-05T01:00:00Z",
                new JSONObject().put("model", "Thu").put("sdkInt", 34).put("appVersion", "1.0.0"));
        assertEquals(setOf("schemaVersion", "event", "id", "deviceId", "recordedAt", "pairCode", "device"), keysOf(pair));
        JSONObject state = CheckinPolicy.stateEvent(DEVICE, "2026-01-05T01:00:00Z", device());
        assertEquals(setOf("schemaVersion", "event", "id", "deviceId", "recordedAt", "device"), keysOf(state));
        assertTrue(CheckinPolicy.validToken(state.getString("id")));
    }

    @Test public void whatTheServerRejectsIsRejectedBeforeQueueing() throws Exception {
        List<JSONObject> bad = Arrays.asList(
                ping(freshFix()).put("organizationId", "forged"),
                ping(freshFix()).put("recordedAt", "2026-02-30T01:02:03Z"),
                ping(freshFix()).put("recordedAt", "2026-01-05T01:30:07"),
                ping(freshFix()).put("schemaVersion", 2),
                ping(freshFix()).put("id", "short"),
                ping(freshFix()).put("deviceId", "not-a-uuid"),
                ping(freshFix()).put("settingsVersion", -1),
                ping(freshFix()).put("reason", "timeout"),
                ping(freshFix()).put("fix", new JSONObject().put("status", "lost")),
                ping(CheckinPolicy.Fix.none("timeout")).put("reason", "because"),
                ping(CheckinPolicy.Fix.none("timeout")).put("reason", JSONObject.NULL),
                ping(freshFix()).put("device", device().put("secret", "x")),
                ping(freshFix()).put("device", device().put("batteryPct", 101)),
                ping(freshFix()).put("device", device().put("locationPermission", "sometimes")));
        for (JSONObject event : bad) {
            assertThrows(event.toString(), IllegalArgumentException.class, () -> CheckinPolicy.validateEvent(event));
        }
        JSONObject outOfRange = ping(freshFix());
        outOfRange.getJSONObject("fix").put("lat", 91);
        assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.validateEvent(outOfRange));
        JSONObject textLongitude = ping(freshFix());
        textLongitude.getJSONObject("fix").put("lng", "106");
        assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.validateEvent(textLongitude));
        assertThrows(IllegalArgumentException.class, () -> CheckinPolicy.pairEvent(DEVICE, "abc", "2026-01-05T01:00:00Z", new JSONObject()));
    }

    // Capture diagnostics: the optional "diag" block of a ping, checked as strictly as the server does.

    // Copied verbatim from DIAG_SAMPLE in supabase/functions/gps-checkin-ingest/index.test.ts: one
    // vector for both sides, in the key order the app writes.
    private static final String DIAG_SAMPLE = "{\"v\":1,\"path\":\"service\",\"end\":\"settled\",\"alarmLateMs\":1250,\"startMs\":310,\"captureMs\":8420,\"awakeMs\":9100,\"procAgeMs\":5400000,\"screenOn\":false,\"bucket\":10,\"foreground\":true,\"lastKnownAgeMs\":282000,\"sources\":{\"fused\":{\"on\":true,\"n\":3,\"firstMs\":2100,\"bestM\":18.5},\"gps\":{\"on\":true,\"n\":0,\"firstMs\":null,\"bestM\":null},\"network\":{\"on\":false,\"n\":0,\"firstMs\":null,\"bestM\":null}}}";

    private static List<CheckinPolicy.DiagSource> sampleSources() {
        return Arrays.asList(
                new CheckinPolicy.DiagSource("fused", true, 3L, 2_100L, 18.5d),
                new CheckinPolicy.DiagSource("gps", true, 0L, -1L, Double.NaN),
                new CheckinPolicy.DiagSource("network", false, 0L, -1L, Double.NaN));
    }

    /** The capture that DIAG_SAMPLE describes. */
    private static JSONObject sampleDiag() {
        return CheckinPolicy.captureDiag("service", "settled", 1_250L, 310L, 8_420L, 9_100L, 5_400_000L, false, 10,
                true, 282_000L, sampleSources());
    }

    private static JSONObject diagWith(long alarmLateMs, long startMs, long captureMs, long awakeMs, long procAgeMs,
                                       int bucket, long lastKnownAgeMs, CheckinPolicy.DiagSource... sources) {
        return CheckinPolicy.captureDiag("service", "best", alarmLateMs, startMs, captureMs, awakeMs, procAgeMs, true,
                bucket, true, lastKnownAgeMs, Arrays.asList(sources));
    }

    private static JSONObject pingWith(JSONObject diag) throws Exception {
        return CheckinPolicy.pingEvent(DEVICE, "2026-01-05T01:30:00Z", "2026-01-05T01:30:07Z", 1, freshFix(), device(), diag);
    }

    private static JSONObject sampleWith(String key, Object value) throws Exception {
        return sampleDiag().put(key, value);
    }

    private static JSONObject sampleWithFused(String key, Object value) throws Exception {
        JSONObject diag = sampleDiag();
        diag.getJSONObject("sources").getJSONObject("fused").put(key, value);
        return diag;
    }

    private static boolean wholeNumber(Object value) {
        return value instanceof Integer || value instanceof Long;
    }

    private static double bestM(double heard) throws Exception {
        return diagWith(0L, 0L, 0L, 0L, 0L, 0, 0L, new CheckinPolicy.DiagSource("gps", true, 1L, 0L, heard))
                .getJSONObject("sources").getJSONObject("gps").getDouble("bestM");
    }

    /** Deep equality that depends neither on key order nor on how a JSON library types its numbers. */
    private static void assertSameJson(String at, Object expected, Object actual) throws Exception {
        if (expected instanceof JSONObject) {
            assertTrue(at, actual instanceof JSONObject);
            JSONObject want = (JSONObject) expected;
            JSONObject got = (JSONObject) actual;
            assertEquals(at, keysOf(want), keysOf(got));
            for (String key : keysOf(want)) assertSameJson(at + "." + key, want.get(key), got.get(key));
        } else if (expected instanceof Number) {
            assertTrue(at, actual instanceof Number);
            assertEquals(at, ((Number) expected).doubleValue(), ((Number) actual).doubleValue(), 0d);
        } else {
            assertEquals(at, expected, actual);
        }
    }

    @Test public void diagCarriesExactlyTheServerKeys() throws Exception {
        JSONObject diag = sampleDiag();
        assertEquals(setOf("v", "path", "end", "alarmLateMs", "startMs", "captureMs", "awakeMs", "procAgeMs", "screenOn",
                "bucket", "foreground", "lastKnownAgeMs", "sources"), keysOf(diag));
        assertEquals(13, diag.length());
        JSONObject sources = diag.getJSONObject("sources");
        assertEquals(setOf("fused", "gps", "network"), keysOf(sources));
        for (String name : keysOf(sources)) {
            assertEquals(name, setOf("on", "n", "firstMs", "bestM"), keysOf(sources.getJSONObject(name)));
        }
        JSONObject all = diagWith(0L, 0L, 0L, 0L, 0L, 0, 0L,
                new CheckinPolicy.DiagSource("passive", true, 1L, 0L, 5d),
                new CheckinPolicy.DiagSource("network", true, 1L, 0L, 5d),
                new CheckinPolicy.DiagSource("gps", true, 1L, 0L, 5d),
                new CheckinPolicy.DiagSource("fused", true, 1L, 0L, 5d));
        assertEquals(setOf("fused", "gps", "network", "passive"), keysOf(all.getJSONObject("sources")));
        assertTrue(pingWith(all).has("diag"));
    }

    @Test public void theBuilderProducesTheVectorSharedWithTheServerTest() throws Exception {
        JSONObject shared = new JSONObject(DIAG_SAMPLE);
        assertSameJson("diag", shared, sampleDiag());
        assertSameJson("wire", shared, new JSONObject(sampleDiag().toString()));
        // The app's own copy of the server rules accepts the very text the server test accepts.
        assertTrue(pingWith(shared).has("diag"));
    }

    @Test public void diagIntegersAreNeverWrittenAsDecimals() throws Exception {
        JSONObject diag = sampleDiag();
        for (String key : new String[]{"v", "alarmLateMs", "startMs", "captureMs", "awakeMs", "procAgeMs", "bucket", "lastKnownAgeMs"}) {
            assertTrue(key, wholeNumber(diag.get(key)));
        }
        JSONObject fused = diag.getJSONObject("sources").getJSONObject("fused");
        assertTrue(wholeNumber(fused.get("n")));
        assertTrue(wholeNumber(fused.get("firstMs")));
        String wire = diag.toString();
        assertTrue(wire, wire.contains("\"bestM\":18.5"));
        assertFalse("bestM is the only decimal: " + wire, wire.replace("\"bestM\":18.5", "").contains("."));
    }

    @Test public void everyDiagNumberIsForcedIntoTheRangeTheServerAccepts() throws Exception {
        JSONObject low = diagWith(Long.MIN_VALUE, -1L, Long.MIN_VALUE, -5L, 0L, 0, 0L,
                new CheckinPolicy.DiagSource("fused", true, -7L, 0L, -3d));
        assertEquals(-86_400_000L, low.getLong("alarmLateMs"));
        assertEquals(0L, low.getLong("startMs"));
        assertEquals(0L, low.getLong("captureMs"));
        assertEquals(0L, low.getLong("awakeMs"));
        assertEquals("zero is a value, not unknown", 0L, low.getLong("procAgeMs"));
        assertEquals(0L, low.getLong("bucket"));
        assertEquals(0L, low.getLong("lastKnownAgeMs"));
        JSONObject lowSource = low.getJSONObject("sources").getJSONObject("fused");
        assertEquals(0L, lowSource.getLong("n"));
        assertEquals(0L, lowSource.getLong("firstMs"));
        assertEquals(0d, lowSource.getDouble("bestM"), 0d);
        assertTrue(pingWith(low).has("diag"));

        JSONObject high = diagWith(Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE,
                Integer.MAX_VALUE, Long.MAX_VALUE,
                new CheckinPolicy.DiagSource("gps", false, Long.MAX_VALUE, Long.MAX_VALUE, Double.MAX_VALUE));
        assertEquals(86_400_000L, high.getLong("alarmLateMs"));
        assertEquals(86_400_000L, high.getLong("startMs"));
        assertEquals(86_400_000L, high.getLong("captureMs"));
        assertEquals(86_400_000L, high.getLong("awakeMs"));
        assertEquals(86_400_000_000L, high.getLong("procAgeMs"));
        assertEquals(100L, high.getLong("bucket"));
        assertEquals(86_400_000_000L, high.getLong("lastKnownAgeMs"));
        JSONObject highSource = high.getJSONObject("sources").getJSONObject("gps");
        assertEquals(100_000L, highSource.getLong("n"));
        assertEquals(86_400_000L, highSource.getLong("firstMs"));
        assertEquals(10_000_000d, highSource.getDouble("bestM"), 0d);
        assertTrue(pingWith(high).has("diag"));
        assertTrue("still valid after the wire", pingWith(new JSONObject(high.toString())).has("diag"));
    }

    @Test public void unknownDiagValuesAreExplicitNullsNotMissingKeys() throws Exception {
        JSONObject built = CheckinPolicy.captureDiag("direct", "none", 0L, 0L, 0L, 0L, -1L, false, -1, false, -1L,
                Arrays.asList(
                        new CheckinPolicy.DiagSource("passive", true, 0L, -1L, Double.NaN),
                        new CheckinPolicy.DiagSource("gps", false, 0L, -1L, Double.POSITIVE_INFINITY),
                        new CheckinPolicy.DiagSource("network", false, 0L, Long.MIN_VALUE, Double.NEGATIVE_INFINITY)));
        // Once as built and once as the text that is sent: unknown must stay a key that holds null.
        for (JSONObject diag : Arrays.asList(built, new JSONObject(built.toString()))) {
            assertEquals(13, diag.length());
            for (String key : new String[]{"procAgeMs", "bucket", "lastKnownAgeMs"}) {
                assertTrue(key, diag.has(key));
                assertTrue(key, diag.isNull(key));
                assertEquals(key, JSONObject.NULL, diag.get(key));
            }
            JSONObject sources = diag.getJSONObject("sources");
            assertEquals(setOf("gps", "network", "passive"), keysOf(sources));
            for (String name : keysOf(sources)) {
                JSONObject source = sources.getJSONObject(name);
                for (String key : new String[]{"firstMs", "bestM"}) {
                    assertTrue(name + "." + key, source.has(key));
                    assertTrue(name + "." + key, source.isNull(key));
                }
            }
            assertTrue(pingWith(diag).has("diag"));
        }
    }

    @Test public void bestAccuracyIsRoundedToOneDecimal() throws Exception {
        assertEquals(18.5d, bestM(18.46d), 0d);
        assertEquals(18.4d, bestM(18.44d), 0d);
        // Location accuracy is a float: widened, 3.9f is 3.9000000953..., and it goes out as 3.9.
        assertEquals(3.9d, bestM(3.9f), 0d);
        assertEquals(18d, bestM(18.04d), 0d);
        // A whole number of metres is written without a fraction and still passes when read back.
        JSONObject whole = diagWith(0L, 0L, 0L, 0L, 0L, 0, 0L, new CheckinPolicy.DiagSource("gps", true, 1L, 0L, 18.04d));
        assertTrue(pingWith(new JSONObject(whole.toString())).has("diag"));
    }

    @Test public void anUnknownLabelGivesNoDiagAtAll() throws Exception {
        assertNull(CheckinPolicy.captureDiag("worker", "good", 0L, 0L, 0L, 0L, 0L, true, 10, true, 0L, sampleSources()));
        assertNull(CheckinPolicy.captureDiag("service", "fine", 0L, 0L, 0L, 0L, 0L, true, 10, true, 0L, sampleSources()));
        assertNull(CheckinPolicy.captureDiag(null, "good", 0L, 0L, 0L, 0L, 0L, true, 10, true, 0L, sampleSources()));
        assertNull(CheckinPolicy.captureDiag("service", null, 0L, 0L, 0L, 0L, 0L, true, 10, true, 0L, sampleSources()));
        // The labels are wire values the server lists one by one, so their spelling is pinned here.
        String[] paths = {CheckinPolicy.DIAG_PATH_SERVICE, CheckinPolicy.DIAG_PATH_DIRECT};
        String[] ends = {CheckinPolicy.END_GOOD, CheckinPolicy.END_SETTLED, CheckinPolicy.END_BEST,
                CheckinPolicy.END_LAST_KNOWN, CheckinPolicy.END_NONE, CheckinPolicy.END_PRE};
        assertEquals(Arrays.asList("service", "direct"), Arrays.asList(paths));
        assertEquals(Arrays.asList("good", "settled", "best", "last_known", "none", "pre"), Arrays.asList(ends));
        for (String path : paths) {
            for (String end : ends) {
                JSONObject diag = CheckinPolicy.captureDiag(path, end, 0L, 0L, 0L, 0L, 0L, true, 10, true, 0L, sampleSources());
                assertNotNull(path + "/" + end, diag);
                assertEquals(path, diag.getString("path"));
                assertEquals(end, diag.getString("end"));
                assertTrue(pingWith(diag).has("diag"));
            }
        }
    }

    @Test public void onlyKnownSourcesAreReportedAndAFailedOneIsShownOff() throws Exception {
        JSONObject none = CheckinPolicy.captureDiag("direct", "last_known", 0L, 0L, 0L, 0L, 0L, true, 10, false, 0L, null);
        assertEquals(0, none.getJSONObject("sources").length());
        assertTrue(pingWith(none).has("diag"));

        JSONObject diag = diagWith(0L, 0L, 0L, 0L, 0L, 0, 0L,
                new CheckinPolicy.DiagSource("oem_special", true, 4L, 10L, 3d),
                null,
                new CheckinPolicy.DiagSource(null, true, 4L, 10L, 3d),
                new CheckinPolicy.DiagSource("network", false, 0L, -1L, Double.NaN),
                new CheckinPolicy.DiagSource("network", true, 9L, 1L, 1d));
        JSONObject sources = diag.getJSONObject("sources");
        assertEquals(setOf("network"), keysOf(sources));
        // The first entry of a name wins: a source that could not be registered stays visible as off.
        assertFalse(sources.getJSONObject("network").getBoolean("on"));
        assertEquals(0L, sources.getJSONObject("network").getLong("n"));
        assertTrue(pingWith(diag).has("diag"));
    }

    @Test public void aPingCarriesDiagOnlyWhenItIsGiven() throws Exception {
        JSONObject plain = ping(freshFix());
        assertFalse(plain.has("diag"));
        assertFalse(pingWith(null).has("diag"));
        assertSameJson("no diag", plain, pingWith(null));

        JSONObject withDiag = pingWith(sampleDiag());
        Set<String> keys = keysOf(plain);
        keys.add("diag");
        assertEquals(keys, keysOf(withDiag));
        assertSameJson("diag", new JSONObject(DIAG_SAMPLE), withDiag.getJSONObject("diag"));
        CheckinPolicy.validateEvent(withDiag);
        // The queue keeps the text, so the text read back must pass as well.
        CheckinPolicy.validateEvent(new JSONObject(withDiag.toString()));
        // Apart from the new key, the ping is the one 1.0.0 sends.
        withDiag.remove("diag");
        assertSameJson("ping", plain, withDiag);
    }

    @Test public void aSlotWithoutLocationStillCarriesItsDiag() throws Exception {
        JSONObject missed = CheckinPolicy.pingEvent(DEVICE, "2026-01-05T01:30:00Z", "2026-01-05T01:30:07Z", 1,
                CheckinPolicy.Fix.none("timeout"), device(), sampleDiag());
        assertEquals(setOf("status"), keysOf(missed.getJSONObject("fix")));
        assertTrue(missed.has("diag"));
    }

    @Test public void aDiagThatBreaksTheContractIsLeftOutAndThePingStillGoes() throws Exception {
        JSONObject missingKey = sampleDiag();
        missingKey.remove("bucket");
        JSONObject unknownSource = sampleDiag();
        unknownSource.getJSONObject("sources").put("wifi", new JSONObject().put("on", true).put("n", 0)
                .put("firstMs", JSONObject.NULL).put("bestM", JSONObject.NULL));
        List<JSONObject> bad = Arrays.asList(
                new JSONObject(),
                missingKey,
                unknownSource,
                sampleWith("extra", 1),
                sampleWith("v", 2),
                sampleWith("v", "1"),
                sampleWith("path", "worker"),
                sampleWith("end", "fine"),
                sampleWith("alarmLateMs", "1250"),
                sampleWith("alarmLateMs", -86_400_001L),
                sampleWith("startMs", -1),
                sampleWith("captureMs", 86_400_001L),
                sampleWith("awakeMs", 12.5d),
                sampleWith("procAgeMs", -1),
                sampleWith("screenOn", "no"),
                sampleWith("bucket", 101),
                sampleWith("foreground", JSONObject.NULL),
                sampleWith("lastKnownAgeMs", 1.5d),
                sampleWith("sources", "none"),
                sampleWithFused("on", "yes"),
                sampleWithFused("n", 100_001),
                sampleWithFused("n", 2.5d),
                sampleWithFused("firstMs", -1),
                sampleWithFused("bestM", -1d),
                sampleWithFused("bestM", "18.5"),
                sampleWithFused("extra", true));
        for (JSONObject diag : bad) {
            JSONObject sent = pingWith(diag);
            assertFalse(diag.toString(), sent.has("diag"));
            CheckinPolicy.validateEvent(sent);
            // Put in by force, it is refused before queueing, as the server would refuse it.
            JSONObject forced = ping(freshFix()).put("diag", diag);
            assertThrows(diag.toString(), IllegalArgumentException.class, () -> CheckinPolicy.validateEvent(forced));
        }
    }

    @Test public void onlyAPingMayCarryDiag() throws Exception {
        JSONObject state = CheckinPolicy.stateEvent(DEVICE, "2026-01-05T01:00:00Z", device());
        JSONObject pair = CheckinPolicy.pairEvent(DEVICE, "ABCDEFGH23", "2026-01-05T01:00:00Z",
                new JSONObject().put("model", "Thu").put("sdkInt", 34).put("appVersion", "1.0.0"));
        for (JSONObject event : Arrays.asList(state, pair)) {
            assertFalse(event.has("diag"));
            event.put("diag", sampleDiag());
            assertThrows(event.toString(), IllegalArgumentException.class, () -> CheckinPolicy.validateEvent(event));
        }
    }

    @Test public void aLiveFixProcessedMinutesLateIsStillAValidFreshFix() throws Exception {
        // A callback that waited out a frozen process is still this capture's own fix. The server puts
        // no limit on the age of a fresh fix, and neither does the local copy of its rules.
        JSONObject fix = ping(CheckinPolicy.Fix.located("fresh", 10d, 106d, 12d, "fused", 240_000L, false)).getJSONObject("fix");
        assertEquals("fresh", fix.getString("status"));
        assertEquals(240_000L, fix.getLong("ageMs"));
    }

    @Test public void aProviderNameOfAnyKindNeverCostsThePing() throws Exception {
        // The server takes any text of at most 32 bytes, so a name the app does not know is kept and
        // a long one is cut, not dropped.
        String oem = "oem.location.provider.with.a.very.long.name.v2";
        assertTrue(oem.length() > 32);
        JSONObject cut = ping(CheckinPolicy.Fix.located("fresh", 10d, 106d, 12d, oem, 800L, false)).getJSONObject("fix");
        assertEquals(oem.substring(0, 32), cut.getString("provider"));
        JSONObject empty = ping(CheckinPolicy.Fix.located("fresh", 10d, 106d, 12d, "", 800L, false)).getJSONObject("fix");
        assertEquals("", empty.getString("provider"));
    }

    // Receipts: a record is delivered only when the server names exactly that record.

    private static final String ID = "c".repeat(64);

    private static JSONObject receiptData(String status) throws Exception {
        return new JSONObject().put("status", status).put("externalId", ID)
                .put("acceptedAt", "2026-01-05T01:30:09.000Z").put("settings", settings(30, true, NO_OFF_DATES, MORNING));
    }

    private static String receipt(JSONObject data) throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("ok", true).put("data", data).toString();
    }

    @Test public void aValidReceiptIsAcceptedForEachEventStatus() throws Exception {
        for (String status : new String[]{"accepted", "duplicate", "ignored_out_of_window", "ignored_off_day"}) {
            CheckinPolicy.Receipt parsed = CheckinPolicy.parseReceipt(receipt(receiptData(status)), ID, CheckinPolicy.EVENT_PING);
            assertEquals(status, parsed.status);
            assertEquals(30, CheckinPolicy.parseSchedule(parsed.settings).intervalMin);
        }
        assertEquals("state", CheckinPolicy.parseReceipt(receipt(receiptData("state")), ID, CheckinPolicy.EVENT_STATE).status);
        CheckinPolicy.Receipt paired = CheckinPolicy.parseReceipt(
                receipt(receiptData("paired").put("user", new JSONObject().put("name", "Thử nghiệm"))), ID, CheckinPolicy.EVENT_PAIR);
        assertEquals("Thử nghiệm", paired.userName);
    }

    @Test public void receiptsThatDoNotPinTheRecordNeverAcknowledgeIt() throws Exception {
        for (String body : new String[]{
                "", "<html>OK</html>", "{}", "[]",
                new JSONObject().put("schemaVersion", 2).put("ok", true).put("data", receiptData("accepted")).toString(),
                new JSONObject().put("schemaVersion", 1).put("ok", false).put("data", receiptData("accepted")).toString(),
                new JSONObject().put("schemaVersion", 1).put("ok", true).toString(),
                receipt(receiptData("accepted").put("externalId", "d".repeat(64))),
                receipt(receiptData("weird")),
                receipt(receiptData("paired")),
                receipt(receiptData("accepted").put("acceptedAt", "soon")),
                receipt(receiptData("accepted").put("settings", JSONObject.NULL))}) {
            assertThrows(body, CheckinPolicy.InvalidReceiptException.class,
                    () -> CheckinPolicy.parseReceipt(body, ID, CheckinPolicy.EVENT_PING));
        }
        assertThrows(CheckinPolicy.InvalidReceiptException.class,
                () -> CheckinPolicy.parseReceipt(receipt(receiptData("accepted")), ID, CheckinPolicy.EVENT_PAIR));
    }

    private static String sha256Hex(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (byte item : digest) out.append(String.format("%02x", item));
        return out.toString();
    }
}
