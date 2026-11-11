package vn.ihome.diemdanh;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;

import org.json.JSONException;
import org.json.JSONObject;

import vn.ihome.smsgateway.BuildConfig;

/** Reads the device conditions that decide whether a slot can be captured. */
final class DeviceHealth {
    private DeviceHealth() {}

    static String locationPermission(Context context) {
        if (!granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
                && !granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)) {
            return CheckinPolicy.LOCATION_DENIED;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return CheckinPolicy.LOCATION_ALWAYS;
        return granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                ? CheckinPolicy.LOCATION_ALWAYS : CheckinPolicy.LOCATION_WHILE_IN_USE;
    }

    static boolean granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean locationEnabled(Context context) {
        LocationManager manager = context.getSystemService(LocationManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    static boolean batteryOptimizationIgnored(Context context) {
        PowerManager power = context.getSystemService(PowerManager.class);
        return power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    static boolean exactAlarmAllowed(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        return alarms != null && alarms.canScheduleExactAlarms();
    }

    static Integer batteryPct(Context context) {
        BatteryManager battery = context.getSystemService(BatteryManager.class);
        if (battery == null) return null;
        int value = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        return value < 0 || value > 100 ? null : Integer.valueOf(value);
    }

    /** The "device" block of location.ping and device.state. */
    static JSONObject snapshot(Context context, boolean paused) throws JSONException {
        PowerManager power = context.getSystemService(PowerManager.class);
        BatteryManager battery = context.getSystemService(BatteryManager.class);
        Integer percent = batteryPct(context);
        JSONObject block = pairBlock(context);
        block.put("batteryPct", percent == null ? JSONObject.NULL : percent);
        block.put("charging", battery != null && battery.isCharging());
        block.put("idle", power != null && power.isDeviceIdleMode());
        block.put("powerSave", power != null && power.isPowerSaveMode());
        block.put("locationEnabled", locationEnabled(context));
        block.put("locationPermission", locationPermission(context));
        block.put("batteryOptimizationIgnored", batteryOptimizationIgnored(context));
        block.put("exactAlarmAllowed", exactAlarmAllowed(context));
        block.put("paused", paused);
        return block;
    }

    /** Identity of the phone, also sent when pairing. */
    static JSONObject pairBlock(Context context) throws JSONException {
        JSONObject block = new JSONObject();
        block.put("manufacturer", CheckinPolicy.boundedUtf8(Build.MANUFACTURER, 64));
        block.put("model", CheckinPolicy.boundedUtf8(Build.MODEL, 120));
        block.put("sdkInt", Build.VERSION.SDK_INT);
        block.put("appVersion", CheckinPolicy.boundedUtf8(BuildConfig.VERSION_NAME, 64));
        return block;
    }
}
