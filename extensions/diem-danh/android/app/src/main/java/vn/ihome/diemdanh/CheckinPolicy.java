package vn.ihome.diemdanh;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.DateTimeException;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * Pure rules shared by the app and its JVM tests; no Android imports.
 * The wire format mirrors {@code supabase/functions/gps-checkin-ingest/index.ts}.
 */
public final class CheckinPolicy {
    public static final String EVENT_PAIR = "device.pair";
    public static final String EVENT_PING = "location.ping";
    public static final String EVENT_STATE = "device.state";

    public static final String FIX_FRESH = "fresh";
    public static final String FIX_STALE = "stale";
    public static final String FIX_NONE = "none";

    public static final String REASON_PERMISSION_DENIED = "permission_denied";
    public static final String REASON_LOCATION_OFF = "location_off";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_PAUSED = "paused";

    public static final String LOCATION_ALWAYS = "always";
    public static final String LOCATION_WHILE_IN_USE = "while_in_use";
    public static final String LOCATION_DENIED = "denied";

    public static final ZoneId VIETNAM = ZoneId.of("Asia/Ho_Chi_Minh");
    /** A location reported at most this long before listening began still counts as obtained by the capture. */
    public static final long LIVE_SLACK_MS = 5_000L;
    /** A time-up check that runs this much after it was due may have fixes queued behind it. */
    public static final long TIME_UP_OVERDUE_MS = 500L;
    /** The server counts an older cached fix as missing, so it stays on the phone. */
    public static final long LAST_KNOWN_MAX_AGE_MS = 60L * 60L * 1000L;
    /** A fresh fix this precise ends the capture at once. */
    public static final double GOOD_ACCURACY_M = 25d;
    /** A fresh fix this precise ends the capture soon; a coarser one keeps waiting for GPS. */
    public static final double ACCEPTABLE_ACCURACY_M = 100d;
    /** A correction of the server clock bigger than this moves the alarm. */
    public static final long OFFSET_RESCHEDULE_MS = 30_000L;
    /** An alarm past due by less than this is treated as still being delivered. */
    public static final long ALARM_IN_FLIGHT_MS = 120_000L;
    public static final int MAX_WIRE_BYTES = 16 * 1024;

    /** Location sources a capture listens to; the names are the platform's provider names. */
    public static final String SOURCE_FUSED = "fused";
    public static final String SOURCE_GPS = "gps";
    public static final String SOURCE_NETWORK = "network";
    public static final String SOURCE_PASSIVE = "passive";

    public static final String DIAG_PATH_SERVICE = "service";
    public static final String DIAG_PATH_DIRECT = "direct";
    public static final String END_GOOD = "good";
    public static final String END_SETTLED = "settled";
    public static final String END_BEST = "best";
    public static final String END_LAST_KNOWN = "last_known";
    public static final String END_NONE = "none";
    public static final String END_PRE = "pre";

    private static final List<String> DIAG_KEYS = Arrays.asList("v", "path", "end", "alarmLateMs", "startMs",
            "captureMs", "awakeMs", "procAgeMs", "screenOn", "bucket", "foreground", "lastKnownAgeMs", "sources");
    private static final List<String> DIAG_PATHS = Arrays.asList(DIAG_PATH_SERVICE, DIAG_PATH_DIRECT);
    private static final List<String> DIAG_ENDS = Arrays.asList(
            END_GOOD, END_SETTLED, END_BEST, END_LAST_KNOWN, END_NONE, END_PRE);
    /** Also the order in which the sources are written. */
    private static final List<String> DIAG_SOURCES = Arrays.asList(
            SOURCE_FUSED, SOURCE_GPS, SOURCE_NETWORK, SOURCE_PASSIVE);
    private static final List<String> DIAG_SOURCE_KEYS = Arrays.asList("on", "n", "firstMs", "bestM");
    private static final long DIAG_DAY_MS = 86_400_000L;
    /** 1000 days: far below 2^53-1, the largest integer the server takes. */
    private static final long DIAG_MAX_AGE_MS = 86_400_000_000L;
    private static final long DIAG_MAX_COUNT = 100_000L;
    private static final double DIAG_MAX_ACCURACY_M = 10_000_000d;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    private static final int HORIZON_DAYS = 31;
    private static final String TOKEN_REGEX = "[a-f0-9]{64}";
    private static final String PAIR_CODE_REGEX = "[A-HJ-NP-Z2-9]{10}";
    private static final String UUID_REGEX =
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final String TIMESTAMP_REGEX = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z";
    private static final String TIME_REGEX = "([01][0-9]|2[0-3]):[0-5][0-9]";
    private static final Set<String> REASONS = new HashSet<>(Arrays.asList(
            REASON_PERMISSION_DENIED, REASON_LOCATION_OFF, REASON_TIMEOUT, REASON_PAUSED));
    private static final Set<String> LOCATION_PERMISSIONS = new HashSet<>(Arrays.asList(
            LOCATION_ALWAYS, LOCATION_WHILE_IN_USE, LOCATION_DENIED));
    private static final List<String> COMMON_KEYS = Arrays.asList(
            "schemaVersion", "event", "id", "deviceId", "recordedAt");

    private CheckinPolicy() {}

    // ---- Settings sent by the server -------------------------------------------------------

    public static final class Window {
        public final int fromMinute;
        public final int toMinute;

        Window(int fromMinute, int toMinute) {
            this.fromMinute = fromMinute;
            this.toMinute = toMinute;
        }
    }

    public static final class Schedule {
        public final int version;
        public final boolean enabled;
        public final boolean applies;
        public final int intervalMin;
        public final int toleranceMin;
        public final List<Window> windows;
        public final boolean skipSunday;
        public final Set<LocalDate> offDates;
        public final ZoneId zone;
        public final Instant serverNow;

        Schedule(int version, boolean enabled, boolean applies, int intervalMin, int toleranceMin,
                 List<Window> windows, boolean skipSunday, Set<LocalDate> offDates, ZoneId zone,
                 Instant serverNow) {
            this.version = version;
            this.enabled = enabled;
            this.applies = applies;
            this.intervalMin = intervalMin;
            this.toleranceMin = toleranceMin;
            this.windows = Collections.unmodifiableList(windows);
            this.skipSunday = skipSunday;
            this.offDates = Collections.unmodifiableSet(offDates);
            this.zone = zone;
            this.serverNow = serverNow;
        }

        /** Everything except the server clock, so a new receipt alone never counts as a change. */
        public String fingerprint() {
            StringBuilder out = new StringBuilder();
            out.append(version).append('|').append(enabled).append('|').append(applies).append('|')
                    .append(intervalMin).append('|').append(toleranceMin).append('|')
                    .append(skipSunday).append('|').append(zone.getId()).append('|');
            for (Window window : windows) out.append(window.fromMinute).append('-').append(window.toMinute).append(',');
            out.append('|');
            for (LocalDate date : new TreeSet<>(offDates)) out.append(date).append(',');
            return out.toString();
        }
    }

    /** Strict: any shape the server contract does not allow is rejected and the old schedule stays. */
    public static Schedule parseSchedule(JSONObject json) {
        if (json == null) throw invalid("settings");
        int version = requireInt(json, "version");
        int interval = requireInt(json, "intervalMin");
        if (version < 0 || (interval != 15 && interval != 30 && interval != 60)) throw invalid("settings");
        int tolerance = requireInt(json, "toleranceMin");
        if (tolerance < 0) throw invalid("toleranceMin");
        List<Window> windows = new ArrayList<>();
        JSONArray rawWindows = requireArray(json, "windows");
        for (int index = 0; index < rawWindows.length(); index++) {
            Object item = rawWindows.opt(index);
            if (!(item instanceof JSONArray) || ((JSONArray) item).length() != 2) throw invalid("windows");
            int from = minuteOfDay(((JSONArray) item).opt(0));
            int to = minuteOfDay(((JSONArray) item).opt(1));
            if (from >= to) throw invalid("windows");
            windows.add(new Window(from, to));
        }
        windows.sort(Comparator.comparingInt(window -> window.fromMinute));
        Set<LocalDate> offDates = new HashSet<>();
        JSONArray rawOff = requireArray(json, "offDates");
        for (int index = 0; index < rawOff.length(); index++) {
            Object item = rawOff.opt(index);
            if (!(item instanceof String)) throw invalid("offDates");
            try {
                offDates.add(LocalDate.parse((String) item));
            } catch (DateTimeException error) {
                throw invalid("offDates");
            }
        }
        ZoneId zone;
        Instant serverNow;
        try {
            zone = ZoneId.of(requireText(json, "tz"));
            serverNow = Instant.parse(requireText(json, "serverNow"));
        } catch (DateTimeException error) {
            throw invalid("settings");
        }
        return new Schedule(version, requireBool(json, "enabled"), requireBool(json, "applies"), interval, tolerance,
                windows, requireBool(json, "skipSunday"), offDates, zone, serverNow);
    }

    private static int minuteOfDay(Object value) {
        if (!(value instanceof String) || !((String) value).matches(TIME_REGEX)) throw invalid("windows");
        String text = (String) value;
        return Integer.parseInt(text.substring(0, 2)) * 60 + Integer.parseInt(text.substring(3));
    }

    // ---- Slot arithmetic -------------------------------------------------------------------

    /** Next slot strictly after {@code after}, or null when the schedule produces none. */
    public static Instant nextSlot(Schedule schedule, Instant after) {
        if (schedule == null || !schedule.enabled || !schedule.applies || schedule.windows.isEmpty()) return null;
        LocalDate date = after.atZone(schedule.zone).toLocalDate();
        for (int day = 0; day <= HORIZON_DAYS; day++) {
            LocalDate candidateDate = date.plusDays(day);
            if (isOffDay(schedule, candidateDate)) continue;
            Instant best = null;
            for (Window window : schedule.windows) {
                Instant slot = firstSlotInWindow(schedule, candidateDate, window, after);
                if (slot != null && (best == null || slot.isBefore(best))) best = slot;
            }
            if (best != null) return best;
        }
        return null;
    }

    /** Slots are from + k*interval and the end of the window is inclusive, as on the server. */
    private static Instant firstSlotInWindow(Schedule schedule, LocalDate date, Window window, Instant after) {
        ZonedDateTime midnight = date.atStartOfDay(schedule.zone);
        for (int minute = window.fromMinute; minute <= window.toMinute; minute += schedule.intervalMin) {
            Instant slot = midnight.plusMinutes(minute).toInstant();
            if (slot.isAfter(after)) return slot;
        }
        return null;
    }

    public static boolean isOffDay(Schedule schedule, LocalDate date) {
        return schedule.offDates.contains(date) || (schedule.skipSunday && date.getDayOfWeek() == DayOfWeek.SUNDAY);
    }

    /**
     * Whether a live alarm should be left alone instead of being replaced. The trigger time was
     * computed with the offset known when it was armed, so a corrected clock needs a new alarm.
     */
    public static boolean keepArmed(long armedSlotMs, boolean alarmExists, long nextSlotMs, long nowMs,
                                    long armedOffsetMs, long offsetMs) {
        if (!alarmExists || armedSlotMs <= 0L || Math.abs(armedOffsetMs - offsetMs) > OFFSET_RESCHEDULE_MS) return false;
        return armedSlotMs == nextSlotMs || (armedSlotMs <= nowMs && nowMs - armedSlotMs < ALARM_IN_FLIGHT_MS);
    }

    /** The reason this slot cannot take a location, or null when a capture should run. */
    public static String preCaptureReason(boolean paused, String locationPermission, int sdkInt, boolean locationEnabled) {
        if (paused) return REASON_PAUSED;
        if (LOCATION_DENIED.equals(locationPermission)) return REASON_PERMISSION_DENIED;
        // Android 11+ gives a background-started service no location without "Luôn cho phép".
        if (LOCATION_WHILE_IN_USE.equals(locationPermission) && sdkInt >= 30) return REASON_PERMISSION_DENIED;
        return locationEnabled ? null : REASON_LOCATION_OFF;
    }

    /**
     * Whether a location was obtained during this capture, on the elapsed-realtime clock. A source may
     * replay a location it cached earlier as its first callback: that one is not this slot's position,
     * while one obtained in time stays the slot's position however late it is processed.
     */
    public static boolean obtainedDuringCapture(long fixElapsedMs, long captureStartElapsedMs) {
        return fixElapsedMs >= captureStartElapsedMs - LIVE_SLACK_MS;
    }

    /**
     * Whether gps and network start together with fused instead of after a delay. Before Android 12
     * fused can only be asked for low-power quality, so GPS must not wait for it; and when fused
     * could not be registered there is nothing to wait for.
     */
    public static boolean fallbackSourcesAtOnce(int sdkInt, boolean fusedRegistered) {
        return sdkInt < 31 || !fusedRegistered;
    }

    /**
     * Whether the time-up check waits a moment before concluding without a live fix. Only a check that
     * ran late, behind a frozen process or a blocked thread, can have fixes queued behind it; on time,
     * everything that arrived was already handled and waiting would only make the record later.
     * {@code lateMs} is measured on the uptime clock the check was scheduled on.
     */
    public static boolean graceForQueuedFixes(boolean liveFix, long lateMs) {
        return !liveFix && lateMs > TIME_UP_OVERDUE_MS;
    }

    /** How a capture that listened ended; {@code atTimeLimit} = stopped by the clock, not by a fix. */
    public static String captureEnd(Fix fix, boolean atTimeLimit) {
        if (fix == null || FIX_NONE.equals(fix.status)) return END_NONE;
        if (FIX_STALE.equals(fix.status)) return END_LAST_KNOWN;
        if (atTimeLimit) return END_BEST;
        return goodEnough(fix) ? END_GOOD : END_SETTLED;
    }

    public static boolean usableLastKnown(long ageMs) {
        return ageMs <= LAST_KNOWN_MAX_AGE_MS;
    }

    public static boolean goodEnough(Fix fix) {
        return isFreshWithin(fix, GOOD_ACCURACY_M);
    }

    public static boolean acceptable(Fix fix) {
        return isFreshWithin(fix, ACCEPTABLE_ACCURACY_M);
    }

    private static boolean isFreshWithin(Fix fix, double accuracyM) {
        return fix != null && FIX_FRESH.equals(fix.status) && fix.accuracyM != null && fix.accuracyM <= accuracyM;
    }

    // ---- Identifiers and credentials -------------------------------------------------------

    public static String slotId(String deviceId, String slotAt) {
        return sha256(deviceId + "|" + slotAt);
    }

    public static String pairId(String deviceId, String code) {
        return sha256(deviceId + "|pair|" + code);
    }

    public static String stateId(String deviceId, String recordedAt) {
        return sha256(deviceId + "|state|" + recordedAt);
    }

    public static String formatInstant(long epochMs) {
        return Instant.ofEpochMilli(epochMs).toString();
    }

    public static String newToken(SecureRandom random) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return hex(bytes);
    }

    public static boolean validToken(String value) {
        return value != null && value.matches(TOKEN_REGEX);
    }

    /** Keeps a queued record from ever being sent with the credential of a later pairing. */
    public static String destinationBinding(String endpoint, String token) {
        return sha256(endpoint + "\n" + token);
    }

    public static String normalizePairCode(String raw) {
        String code = (raw == null ? "" : raw).replaceAll("[\\s-]", "").toUpperCase(Locale.ROOT);
        if (!code.matches(PAIR_CODE_REGEX)) {
            throw new IllegalArgumentException("Mã ghép nối gồm 10 ký tự, không có chữ I, O và số 0, 1.");
        }
        return code;
    }

    /** The pairing code carried by ihomediemdanh://pair?c=CODE, or null for anything else. */
    public static String codeFromLink(String link) {
        if (link == null) return null;
        try {
            URI uri = new URI(link);
            if (!"ihomediemdanh".equalsIgnoreCase(uri.getScheme()) || !"pair".equalsIgnoreCase(uri.getHost())) return null;
            String query = uri.getRawQuery();
            if (query == null) return null;
            for (String part : query.split("&")) {
                if (part.startsWith("c=")) return normalizePairCode(part.substring(2));
            }
            return null;
        } catch (URISyntaxException | IllegalArgumentException error) {
            return null;
        }
    }

    public static String sha256(String input) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 không khả dụng.", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            out.append(Character.forDigit((value >>> 4) & 15, 16));
            out.append(Character.forDigit(value & 15, 16));
        }
        return out.toString();
    }

    /** Truncates to a UTF-8 byte limit without leaving half of a surrogate pair. */
    public static String boundedUtf8(String value, int maxBytes) {
        String text = value == null ? "" : value;
        while (text.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            int end = text.length() - 1;
            if (end > 0 && Character.isHighSurrogate(text.charAt(end - 1))) end--;
            text = text.substring(0, end);
        }
        return text;
    }

    // ---- Location results ------------------------------------------------------------------

    public static final class Fix {
        public final String status;
        public final double lat;
        public final double lng;
        public final Double accuracyM;
        public final String provider;
        public final long ageMs;
        public final boolean mock;
        public final String reason;

        private Fix(String status, double lat, double lng, Double accuracyM, String provider, long ageMs,
                    boolean mock, String reason) {
            this.status = status;
            this.lat = lat;
            this.lng = lng;
            this.accuracyM = accuracyM;
            this.provider = provider;
            this.ageMs = ageMs;
            this.mock = mock;
            this.reason = reason;
        }

        public static Fix none(String reason) {
            return new Fix(FIX_NONE, 0d, 0d, null, null, 0L, false, reason);
        }

        public static Fix located(String status, double lat, double lng, Double accuracyM, String provider,
                                  long ageMs, boolean mock) {
            return new Fix(status, lat, lng, accuracyM, provider == null ? null : boundedUtf8(provider, 32),
                    ageMs, mock, null);
        }
    }

    /**
     * A fresh fix beats a cached one; then best accuracy wins, and an unknown accuracy only
     * beats another unknown when it is newer.
     */
    public static Fix better(Fix current, Fix candidate) {
        if (candidate == null) return current;
        if (current == null) return candidate;
        boolean currentStale = FIX_STALE.equals(current.status);
        if (currentStale != FIX_STALE.equals(candidate.status)) return currentStale ? candidate : current;
        if (candidate.accuracyM == null) {
            return current.accuracyM == null && candidate.ageMs < current.ageMs ? candidate : current;
        }
        if (current.accuracyM == null) return candidate;
        return candidate.accuracyM < current.accuracyM ? candidate : current;
    }

    // ---- Capture diagnostics: the optional "diag" block of a ping --------------------------

    /** What one location source did during a capture. */
    public static final class DiagSource {
        final String name;
        final boolean on;
        final long count;
        final long firstMs;
        final double bestM;

        /** A negative {@code firstMs} and a non-finite {@code bestM} mean that nothing was heard. */
        public DiagSource(String name, boolean on, long count, long firstMs, double bestM) {
            this.name = name;
            this.on = on;
            this.count = count;
            this.firstMs = firstMs;
            this.bestM = bestM;
        }
    }

    /**
     * Builds the block with every value forced into the range the server accepts, because a single
     * value out of range would cost the whole ping. Never throws: null means the ping goes without
     * it. A negative {@code procAgeMs}, {@code bucket} or {@code lastKnownAgeMs} stands for unknown.
     */
    public static JSONObject captureDiag(String path, String end, long alarmLateMs, long startMs, long captureMs,
                                         long awakeMs, long procAgeMs, boolean screenOn, int bucket,
                                         boolean foreground, long lastKnownAgeMs, List<DiagSource> sources) {
        if (!DIAG_PATHS.contains(path) || !DIAG_ENDS.contains(end)) return null;
        try {
            JSONObject diag = new JSONObject();
            diag.put("v", 1);
            diag.put("path", path);
            diag.put("end", end);
            diag.put("alarmLateMs", clamp(alarmLateMs, -DIAG_DAY_MS, DIAG_DAY_MS));
            diag.put("startMs", clamp(startMs, 0L, DIAG_DAY_MS));
            diag.put("captureMs", clamp(captureMs, 0L, DIAG_DAY_MS));
            diag.put("awakeMs", clamp(awakeMs, 0L, DIAG_DAY_MS));
            putKnown(diag, "procAgeMs", procAgeMs, DIAG_MAX_AGE_MS);
            diag.put("screenOn", screenOn);
            putKnown(diag, "bucket", bucket, 100L);
            diag.put("foreground", foreground);
            putKnown(diag, "lastKnownAgeMs", lastKnownAgeMs, DIAG_MAX_AGE_MS);
            JSONObject bySource = new JSONObject();
            for (String name : DIAG_SOURCES) {
                DiagSource source = sourceNamed(sources, name);
                if (source == null) continue;
                JSONObject item = new JSONObject();
                item.put("on", source.on);
                item.put("n", clamp(source.count, 0L, DIAG_MAX_COUNT));
                putKnown(item, "firstMs", source.firstMs, DIAG_DAY_MS);
                if (Double.isNaN(source.bestM) || Double.isInfinite(source.bestM)) {
                    item.put("bestM", JSONObject.NULL);
                } else {
                    double bounded = Math.max(0d, Math.min(source.bestM, DIAG_MAX_ACCURACY_M));
                    item.put("bestM", Math.round(bounded * 10d) / 10d);
                }
                bySource.put(name, item);
            }
            diag.put("sources", bySource);
            validateDiag(diag);
            return diag;
        } catch (JSONException error) {
            return null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static DiagSource sourceNamed(List<DiagSource> sources, String name) {
        if (sources == null) return null;
        for (DiagSource source : sources) {
            if (source != null && name.equals(source.name)) return source;
        }
        return null;
    }

    private static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(value, max));
    }

    /** Integers only, so the value is never written as a decimal; negative = an explicit null. */
    private static void putKnown(JSONObject json, String key, long value, long max) throws JSONException {
        if (value < 0L) json.put(key, JSONObject.NULL);
        else json.put(key, Math.min(value, max));
    }

    // ---- Events sent to the server ---------------------------------------------------------

    public static JSONObject pairEvent(String deviceId, String code, String recordedAt, JSONObject device)
            throws JSONException {
        JSONObject event = envelope(EVENT_PAIR, pairId(deviceId, code), deviceId, recordedAt);
        event.put("pairCode", code);
        event.put("device", device);
        validateEvent(event);
        return event;
    }

    public static JSONObject pingEvent(String deviceId, String slotAt, String recordedAt, int settingsVersion,
                                       Fix fix, JSONObject device) throws JSONException {
        return pingEvent(deviceId, slotAt, recordedAt, settingsVersion, fix, device, null);
    }

    /** {@code diag} is optional and goes last; a block that breaks its contract is left out, never sent. */
    public static JSONObject pingEvent(String deviceId, String slotAt, String recordedAt, int settingsVersion,
                                       Fix fix, JSONObject device, JSONObject diag) throws JSONException {
        JSONObject event = envelope(EVENT_PING, slotId(deviceId, slotAt), deviceId, recordedAt);
        event.put("slotAt", slotAt);
        event.put("settingsVersion", settingsVersion);
        event.put("fix", fixJson(fix));
        event.put("reason", fix.reason == null ? JSONObject.NULL : fix.reason);
        event.put("device", device);
        if (diag != null && validDiag(diag)) event.put("diag", diag);
        validateEvent(event);
        return event;
    }

    public static JSONObject stateEvent(String deviceId, String recordedAt, JSONObject device) throws JSONException {
        JSONObject event = envelope(EVENT_STATE, stateId(deviceId, recordedAt), deviceId, recordedAt);
        event.put("device", device);
        validateEvent(event);
        return event;
    }

    private static JSONObject envelope(String type, String id, String deviceId, String recordedAt) throws JSONException {
        JSONObject event = new JSONObject();
        event.put("schemaVersion", 1);
        event.put("event", type);
        event.put("id", id);
        event.put("deviceId", deviceId);
        event.put("recordedAt", recordedAt);
        return event;
    }

    private static JSONObject fixJson(Fix fix) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("status", fix.status);
        if (FIX_NONE.equals(fix.status)) return json;
        json.put("lat", fix.lat);
        json.put("lng", fix.lng);
        json.put("accuracyM", fix.accuracyM == null ? JSONObject.NULL : fix.accuracyM);
        json.put("provider", fix.provider == null ? JSONObject.NULL : fix.provider);
        json.put("ageMs", fix.ageMs);
        json.put("mock", fix.mock);
        return json;
    }

    /** Same rules as validateEvent on the server, so a local bug cannot queue a permanent 400. */
    public static void validateEvent(JSONObject event) {
        List<String> keys = new ArrayList<>(COMMON_KEYS);
        Object type = event.opt("event");
        if (EVENT_PAIR.equals(type)) keys.addAll(Arrays.asList("pairCode", "device"));
        else if (EVENT_PING.equals(type)) {
            keys.addAll(Arrays.asList("slotAt", "settingsVersion", "fix", "reason", "device"));
            // Optional, and only a ping may carry it: on the other events it is an unknown key.
            if (event.has("diag")) keys.add("diag");
        } else if (EVENT_STATE.equals(type)) keys.add("device");
        else throw invalid("event");
        if (!exactKeys(event, keys)
                || !Integer.valueOf(1).equals(event.opt("schemaVersion"))
                || !matches(event.opt("id"), TOKEN_REGEX)
                || !matches(event.opt("deviceId"), UUID_REGEX)
                || !validTimestamp(event.opt("recordedAt"))) {
            throw invalid("envelope");
        }
        validateDevice(event.opt("device"));
        if (EVENT_PAIR.equals(type) && !matches(event.opt("pairCode"), PAIR_CODE_REGEX)) throw invalid("pairCode");
        if (EVENT_PING.equals(type)) {
            Object version = event.opt("settingsVersion");
            if (!validTimestamp(event.opt("slotAt")) || !(version instanceof Integer)
                    || (Integer) version < 0 || (Integer) version > 1_000_000) {
                throw invalid("ping");
            }
            validateFix(event.opt("fix"), event.opt("reason"));
            if (event.has("diag")) validateDiag(event.opt("diag"));
        }
        byte[] wire = event.toString().getBytes(StandardCharsets.UTF_8);
        if (wire.length > MAX_WIRE_BYTES) throw invalid("size");
    }

    private static boolean validDiag(JSONObject diag) {
        try {
            validateDiag(diag);
            return true;
        } catch (IllegalArgumentException malformed) {
            return false;
        }
    }

    /** Same rules as {@code diag()} on the server: exactly these keys, fixed labels, bounded integers. */
    private static void validateDiag(Object value) {
        if (!(value instanceof JSONObject)) throw invalid("diag");
        JSONObject diag = (JSONObject) value;
        Object procAge = diag.opt("procAgeMs");
        Object lastKnownAge = diag.opt("lastKnownAgeMs");
        Object bucket = diag.opt("bucket");
        Object sources = diag.opt("sources");
        if (!exactKeys(diag, DIAG_KEYS)
                || !Integer.valueOf(1).equals(diag.opt("v"))
                || !DIAG_PATHS.contains(diag.opt("path"))
                || !DIAG_ENDS.contains(diag.opt("end"))
                || !integerBetween(diag.opt("alarmLateMs"), -DIAG_DAY_MS, DIAG_DAY_MS)
                || !integerBetween(diag.opt("startMs"), 0L, DIAG_DAY_MS)
                || !integerBetween(diag.opt("captureMs"), 0L, DIAG_DAY_MS)
                || !integerBetween(diag.opt("awakeMs"), 0L, DIAG_DAY_MS)
                || !(procAge == JSONObject.NULL || integerBetween(procAge, 0L, MAX_SAFE_INTEGER))
                || !(lastKnownAge == JSONObject.NULL || integerBetween(lastKnownAge, 0L, MAX_SAFE_INTEGER))
                || !(bucket == JSONObject.NULL || integerBetween(bucket, 0L, 100L))
                || !(diag.opt("screenOn") instanceof Boolean)
                || !(diag.opt("foreground") instanceof Boolean)
                || !(sources instanceof JSONObject)) {
            throw invalid("diag");
        }
        JSONObject bySource = (JSONObject) sources;
        Iterator<String> names = bySource.keys();
        while (names.hasNext()) {
            String name = names.next();
            Object item = bySource.opt(name);
            if (!DIAG_SOURCES.contains(name) || !(item instanceof JSONObject)) throw invalid("diag.sources");
            JSONObject source = (JSONObject) item;
            Object firstMs = source.opt("firstMs");
            Object bestM = source.opt("bestM");
            if (!exactKeys(source, DIAG_SOURCE_KEYS)
                    || !(source.opt("on") instanceof Boolean)
                    || !integerBetween(source.opt("n"), 0L, DIAG_MAX_COUNT)
                    || !(firstMs == JSONObject.NULL || integerBetween(firstMs, 0L, DIAG_DAY_MS))
                    || !(bestM == JSONObject.NULL || finiteBetween(bestM, 0d, DIAG_MAX_ACCURACY_M))) {
                throw invalid("diag.sources");
            }
        }
    }

    private static void validateFix(Object value, Object reason) {
        if (!(value instanceof JSONObject)) throw invalid("fix");
        JSONObject fix = (JSONObject) value;
        Object status = fix.opt("status");
        if (FIX_NONE.equals(status)) {
            if (fix.length() != 1 || !(reason instanceof String) || !REASONS.contains(reason)) throw invalid("fix");
            return;
        }
        if (!FIX_FRESH.equals(status) && !FIX_STALE.equals(status)) throw invalid("fix");
        if (reason != JSONObject.NULL) throw invalid("reason");
        if (!exactKeys(fix, Arrays.asList("status", "lat", "lng", "accuracyM", "provider", "ageMs", "mock"))) throw invalid("fix");
        Object lat = fix.opt("lat");
        Object lng = fix.opt("lng");
        Object accuracy = fix.opt("accuracyM");
        Object provider = fix.opt("provider");
        Object age = fix.opt("ageMs");
        if (!finiteBetween(lat, -90d, 90d) || !finiteBetween(lng, -180d, 180d)
                || !(accuracy == JSONObject.NULL || finiteBetween(accuracy, 0d, Double.MAX_VALUE))
                || !(provider == JSONObject.NULL || (provider instanceof String && boundedText(provider, 32)))
                || !integerAtLeast(age, 0L)
                || !(fix.opt("mock") instanceof Boolean)) {
            throw invalid("fix");
        }
    }

    private static void validateDevice(Object value) {
        if (!(value instanceof JSONObject)) throw invalid("device");
        JSONObject device = (JSONObject) value;
        Iterator<String> keys = device.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object item = device.opt(key);
            boolean ok;
            switch (key) {
                case "manufacturer": ok = boundedText(item, 64); break;
                case "model": ok = boundedText(item, 120); break;
                case "appVersion": ok = boundedText(item, 64); break;
                case "sdkInt": ok = item instanceof Integer && (Integer) item >= 1 && (Integer) item <= 100; break;
                case "batteryPct":
                    ok = item == JSONObject.NULL || (item instanceof Integer && (Integer) item >= 0 && (Integer) item <= 100);
                    break;
                case "charging":
                case "idle":
                case "powerSave":
                case "locationEnabled":
                case "batteryOptimizationIgnored":
                case "exactAlarmAllowed":
                case "paused":
                    ok = item instanceof Boolean;
                    break;
                case "locationPermission": ok = LOCATION_PERMISSIONS.contains(item); break;
                default: ok = false; break;
            }
            if (!ok) throw invalid("device." + key);
        }
    }

    private static boolean exactKeys(JSONObject json, List<String> keys) {
        if (json.length() != keys.size()) return false;
        for (String key : keys) {
            if (!json.has(key)) return false;
        }
        return true;
    }

    private static boolean matches(Object value, String regex) {
        return value instanceof String && ((String) value).matches(regex);
    }

    private static boolean validTimestamp(Object value) {
        if (!matches(value, TIMESTAMP_REGEX)) return false;
        try {
            Instant.parse((String) value);
            return true;
        } catch (DateTimeException error) {
            return false;
        }
    }

    private static boolean boundedText(Object value, int bytes) {
        return value instanceof String && ((String) value).getBytes(StandardCharsets.UTF_8).length <= bytes;
    }

    private static boolean finiteBetween(Object value, double min, double max) {
        if (!(value instanceof Number)) return false;
        double number = ((Number) value).doubleValue();
        return !Double.isNaN(number) && !Double.isInfinite(number) && number >= min && number <= max;
    }

    private static boolean integerAtLeast(Object value, long min) {
        return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() >= min;
    }

    private static boolean integerBetween(Object value, long min, long max) {
        return integerAtLeast(value, min) && ((Number) value).longValue() <= max;
    }

    // ---- Receipts --------------------------------------------------------------------------

    public static final class InvalidReceiptException extends Exception {
        public InvalidReceiptException(String message) {
            super(message);
        }
    }

    public static final class Receipt {
        public final String status;
        public final String externalId;
        public final Instant acceptedAt;
        public final JSONObject settings;
        public final String userName;

        Receipt(String status, String externalId, Instant acceptedAt, JSONObject settings, String userName) {
            this.status = status;
            this.externalId = externalId;
            this.acceptedAt = acceptedAt;
            this.settings = settings;
            this.userName = userName;
        }
    }

    /** A record counts as delivered only when this returns: right id, right status for the event. */
    public static Receipt parseReceipt(String body, String expectedId, String event) throws InvalidReceiptException {
        try {
            JSONObject root = new JSONObject(body);
            if (!Integer.valueOf(1).equals(root.opt("schemaVersion")) || !Boolean.TRUE.equals(root.opt("ok"))) {
                throw new InvalidReceiptException("envelope");
            }
            Object rawData = root.opt("data");
            if (!(rawData instanceof JSONObject)) throw new InvalidReceiptException("data");
            JSONObject data = (JSONObject) rawData;
            if (expectedId == null || !expectedId.equals(data.opt("externalId"))) {
                throw new InvalidReceiptException("externalId");
            }
            Object status = data.opt("status");
            if (!(status instanceof String) || !statusAllowed(event, (String) status)) {
                throw new InvalidReceiptException("status");
            }
            Object acceptedAt = data.opt("acceptedAt");
            if (!(acceptedAt instanceof String)) throw new InvalidReceiptException("acceptedAt");
            Instant accepted;
            try {
                accepted = Instant.parse((String) acceptedAt);
            } catch (DateTimeException error) {
                throw new InvalidReceiptException("acceptedAt");
            }
            Object settings = data.opt("settings");
            if (!(settings instanceof JSONObject)) throw new InvalidReceiptException("settings");
            String userName = "";
            Object user = data.opt("user");
            if (user instanceof JSONObject && ((JSONObject) user).opt("name") instanceof String) {
                userName = ((JSONObject) user).optString("name", "");
            }
            return new Receipt((String) status, expectedId, accepted, (JSONObject) settings, userName);
        } catch (JSONException error) {
            throw new InvalidReceiptException("json");
        }
    }

    private static boolean statusAllowed(String event, String status) {
        switch (event) {
            case EVENT_PAIR:
                return "paired".equals(status);
            case EVENT_STATE:
                return "state".equals(status);
            case EVENT_PING:
                return "accepted".equals(status) || "duplicate".equals(status)
                        || "ignored_out_of_window".equals(status) || "ignored_off_day".equals(status);
            default:
                return false;
        }
    }

    /** Offset to add to the phone clock; the midpoint cancels the symmetric part of network delay. */
    public static long clockOffsetMs(Instant serverNow, long requestStartMs, long responseEndMs) {
        return serverNow.toEpochMilli() - (requestStartMs + responseEndMs) / 2L;
    }

    public static boolean shouldRetry(int status) {
        return status == 408 || status == 429 || (status >= 500 && status <= 599);
    }

    /** The ingest function's own answer that this credential is dead; a gateway's 401 says nothing. */
    public static boolean deviceRevoked(int status, String body) {
        return status == 401 && errorCode(body).equals("unauthorized");
    }

    /**
     * The ingest function's 403. It means the account is not active, but also any lost database
     * permission on the server, so the app only stops capturing and recovers on its own.
     */
    public static boolean accountRefused(int status, String body) {
        return status == 403 && errorCode(body).equals("forbidden");
    }

    private static String errorCode(String body) {
        if (body == null) return "";
        try {
            Object code = new JSONObject(body).opt("error");
            return code instanceof String ? (String) code : "";
        } catch (JSONException error) {
            return "";
        }
    }

    // ---- Text for the status screen --------------------------------------------------------

    public static String timeLabel(long epochMs, ZoneId zone) {
        ZonedDateTime time = Instant.ofEpochMilli(epochMs).atZone(zone);
        return String.format(Locale.ROOT, "%02d:%02d", time.getHour(), time.getMinute());
    }

    public static String slotLabel(long slotMs, long nowMs, ZoneId zone) {
        LocalDate slotDate = Instant.ofEpochMilli(slotMs).atZone(zone).toLocalDate();
        LocalDate today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate();
        String time = timeLabel(slotMs, zone);
        if (slotDate.equals(today)) return "Hôm nay " + time;
        if (slotDate.equals(today.plusDays(1))) return "Ngày mai " + time;
        return String.format(Locale.ROOT, "%02d/%02d %s", slotDate.getDayOfMonth(), slotDate.getMonthValue(), time);
    }

    public static String windowsLabel(Schedule schedule) {
        if (schedule == null || schedule.windows.isEmpty()) return "";
        List<String> labels = new ArrayList<>();
        for (Window window : schedule.windows) {
            labels.add(hhmm(window.fromMinute) + "–" + hhmm(window.toMinute));
        }
        return String.join(" và ", labels);
    }

    private static String hhmm(int minuteOfDay) {
        return String.format(Locale.ROOT, "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60);
    }

    public static String outcomeLabel(String fixStatus, String reason) {
        if (FIX_FRESH.equals(fixStatus)) return "Đã ghi vị trí";
        if (FIX_STALE.equals(fixStatus)) return "Vị trí gần nhất trong máy";
        if (REASON_PAUSED.equals(reason)) return "Đã tạm dừng";
        if (REASON_PERMISSION_DENIED.equals(reason)) return "Thiếu quyền vị trí";
        if (REASON_LOCATION_OFF.equals(reason)) return "Định vị đang tắt";
        if (REASON_TIMEOUT.equals(reason)) return "Không lấy được vị trí";
        return "Không rõ";
    }

    // ---- Helpers ---------------------------------------------------------------------------

    private static int requireInt(JSONObject json, String key) {
        Object value = json.opt(key);
        if (!(value instanceof Integer)) throw invalid(key);
        return (Integer) value;
    }

    private static boolean requireBool(JSONObject json, String key) {
        Object value = json.opt(key);
        if (!(value instanceof Boolean)) throw invalid(key);
        return (Boolean) value;
    }

    private static String requireText(JSONObject json, String key) {
        Object value = json.opt(key);
        if (!(value instanceof String)) throw invalid(key);
        return (String) value;
    }

    private static JSONArray requireArray(JSONObject json, String key) {
        Object value = json.opt(key);
        if (!(value instanceof JSONArray)) throw invalid(key);
        return (JSONArray) value;
    }

    private static IllegalArgumentException invalid(String field) {
        return new IllegalArgumentException("Không hợp lệ: " + field);
    }
}
