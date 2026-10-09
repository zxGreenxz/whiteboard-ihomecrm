package vn.ihome.smsgateway;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;
import org.json.JSONArray;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

public final class GatewaySettings {
    private static final Object LOCK = new Object();
    private final SharedPreferences preferences;

    public GatewaySettings(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences("gateway_private", Context.MODE_PRIVATE);
    }

    public static final class Settings {
        public final String endpoint;
        public final String token;
        public final boolean enabled;
        public final String deviceId;
        public final boolean smsEnabled;
        public final boolean notificationsEnabled;
        public final Set<String> notificationPackages;
        public final String pairedSourceId;

        private Settings(String endpoint, String token, boolean enabled, String deviceId,
                         boolean smsEnabled, boolean notificationsEnabled, Set<String> notificationPackages,
                         String pairedSourceId) {
            this.endpoint = endpoint;
            this.token = token;
            this.enabled = enabled;
            this.deviceId = deviceId;
            this.smsEnabled = smsEnabled;
            this.notificationsEnabled = notificationsEnabled;
            this.notificationPackages = Collections.unmodifiableSet(new HashSet<>(notificationPackages));
            this.pairedSourceId = pairedSourceId;
        }
    }

    public Settings load() {
        synchronized (LOCK) {
            try {
                String encrypted = preferences.getString("settings", null);
                if (encrypted == null) {
                    Settings initial = new Settings("", "", false, UUID.randomUUID().toString(),
                            true, false, Collections.emptySet(), "");
                    persist(initial);
                    return initial;
                }
                JSONObject json = new JSONObject(SecureStorage.decrypt(encrypted, "settings.v1"));
                Set<String> packages = new HashSet<>();
                JSONArray packageArray = json.optJSONArray("notificationPackages");
                if (packageArray != null) {
                    for (int index = 0; index < packageArray.length(); index++) packages.add(packageArray.getString(index));
                }
                return new Settings(json.getString("endpoint"), json.getString("token"),
                        json.getBoolean("enabled"), json.getString("deviceId"),
                        json.optBoolean("smsEnabled", true), json.optBoolean("notificationsEnabled", false), packages,
                        json.optString("pairedSourceId", ""));
            } catch (Exception error) {
                throw new IllegalStateException("Không đọc được cấu hình bảo mật; việc chuyển SMS đã dừng.", error);
            }
        }
    }

    public void save(String endpoint, String token, boolean enabled) {
        synchronized (LOCK) {
            Settings previous = load();
            saveAll(endpoint, token, enabled, previous.smsEnabled, previous.notificationsEnabled,
                    previous.notificationPackages);
        }
    }

    public void saveSources(boolean smsEnabled, boolean notificationsEnabled, Set<String> packages) {
        synchronized (LOCK) {
            Settings previous = load();
            saveAll(previous.endpoint, previous.token, previous.enabled, smsEnabled, notificationsEnabled, packages);
        }
    }

    public void saveAll(String endpoint, String token, boolean enabled, boolean smsEnabled,
                        boolean notificationsEnabled, Set<String> packages) {
        synchronized (LOCK) {
            String safeEndpoint = endpoint == null ? "" : endpoint.trim();
            String safeToken = token == null ? "" : token.trim();
            if (enabled || !safeEndpoint.isEmpty()) safeEndpoint = GatewayPolicy.validateEndpoint(safeEndpoint);
            if (enabled || !safeToken.isEmpty()) safeToken = GatewayPolicy.validateToken(safeToken);
            Set<String> safePackages = packages == null ? Collections.emptySet() : new HashSet<>(packages);
            for (String packageName : safePackages) {
                if (packageName == null || !packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")) {
                    throw new IllegalArgumentException("Tên gói ứng dụng không hợp lệ.");
                }
                GatewayPolicy.validateShortField(packageName, 255, "Tên gói ứng dụng");
            }
            if (enabled && !smsEnabled && !notificationsEnabled) {
                throw new IllegalArgumentException("Chọn ít nhất một nguồn dữ liệu trước khi bật.");
            }
            if (enabled && notificationsEnabled && safePackages.isEmpty()) {
                throw new IllegalArgumentException("Chọn ứng dụng được phép chuyển thông báo.");
            }
            Settings previous = load();
            try {
                persist(new Settings(safeEndpoint, safeToken, enabled, previous.deviceId,
                        smsEnabled, notificationsEnabled, safePackages,
                        safeEndpoint.equals(previous.endpoint) && safeToken.equals(previous.token)
                                ? previous.pairedSourceId : ""));
            } catch (Exception error) {
                throw new IllegalStateException("Không lưu được cấu hình bảo mật.", error);
            }
        }
    }

    /** Pin a receipt's source only for the credentials that produced it, never a new config. */
    void confirmSource(String endpoint, String token, String sourceId) throws Exception {
        synchronized (LOCK) {
            Settings current = load();
            if (!current.endpoint.equals(endpoint) || !current.token.equals(token)) return;
            if (!current.pairedSourceId.isEmpty() && !current.pairedSourceId.equals(sourceId)) {
                throw new IllegalArgumentException("Máy chủ trả về nguồn khác với kết nối đã xác nhận.");
            }
            if (current.pairedSourceId.isEmpty()) {
                persist(new Settings(current.endpoint, current.token, current.enabled, current.deviceId,
                        current.smsEnabled, current.notificationsEnabled, current.notificationPackages, sourceId));
            }
        }
    }

    private void persist(Settings settings) throws Exception {
        JSONObject json = new JSONObject();
        json.put("endpoint", settings.endpoint);
        json.put("token", settings.token);
        json.put("enabled", settings.enabled);
        json.put("deviceId", settings.deviceId);
        json.put("smsEnabled", settings.smsEnabled);
        json.put("notificationsEnabled", settings.notificationsEnabled);
        json.put("notificationPackages", new JSONArray(settings.notificationPackages));
        json.put("pairedSourceId", settings.pairedSourceId);
        String encrypted = SecureStorage.encrypt(json.toString(), "settings.v1");
        if (!preferences.edit().putString("settings", encrypted).commit()) {
            throw new IllegalStateException("Không ghi được cấu hình.");
        }
    }
}
