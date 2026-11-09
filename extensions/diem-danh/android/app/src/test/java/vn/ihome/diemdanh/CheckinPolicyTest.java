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

    @Test public void freshnessFollowsTheAgeOfTheLocation() {
        assertEquals("fresh", CheckinPolicy.statusForAge(CheckinPolicy.FRESH_MAX_AGE_MS));
        assertEquals("stale", CheckinPolicy.statusForAge(CheckinPolicy.FRESH_MAX_AGE_MS + 1));
    }

    @Test public void aFiringAlarmIsNotReplacedButALostOneIs() {
        long now = 10_000_000L;
        assertTrue(CheckinPolicy.keepArmed(now + 60_000L, true, now + 60_000L, now));
        assertTrue("just came due", CheckinPolicy.keepArmed(now - 1_000L, true, now + 900_000L, now));
        assertFalse("long past due", CheckinPolicy.keepArmed(now - CheckinPolicy.ALARM_IN_FLIGHT_MS, true, now + 900_000L, now));
        assertFalse("settings moved the slot", CheckinPolicy.keepArmed(now + 60_000L, true, now + 120_000L, now));
        assertFalse("alarm gone", CheckinPolicy.keepArmed(now + 60_000L, false, now + 60_000L, now));
        assertFalse("nothing armed", CheckinPolicy.keepArmed(0L, true, now + 60_000L, now));
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
