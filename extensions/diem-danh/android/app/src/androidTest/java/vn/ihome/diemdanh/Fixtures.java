package vn.ihome.diemdanh;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;

/** Synthetic settings and records for the device tests; no real people, phones or places. */
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

    static JSONObject allDaySettings(int version) throws Exception {
        return settings(version, true, true, windows("00:00", "23:55"), new JSONArray());
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
}
