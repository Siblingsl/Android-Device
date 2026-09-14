package dev.rdc.devicecloak;

import android.provider.Settings;
import android.util.Log;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Hooks the read path of ANDROID_ID (Settings.Secure.getString with
 * "android_id") and returns a stable 16-char hex derived from the device
 * serial, instead of the guest's possibly-default value.
 *
 * Limits: direct SQLite reads of the settings db or native reads bypass this.
 */
final class IdHooks {
    private static final String TAG = "DeviceCloak.Id";

    static void install(LoadPackageParam lpparam, String serial) {
        final String androidId = stableHex(serial);
        try {
            XposedHelpers.findAndHookMethod(
                    Settings.Secure.class,
                    "getString",
                    android.content.ContentResolver.class,
                    String.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            if (Settings.Secure.ANDROID_ID.equals(param.args[1])) {
                                param.setResult(androidId);
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "ANDROID_ID hook failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }

    private static String stableHex(String serial) {
        String input = serial == null || serial.isEmpty() ? "rdc" : serial;
        // Two independent 64-bit hashes → 16 hex chars, stable per device.
        long a = hash(input, 0x9e3779b97f4a7c15L);
        long b = hash(input + "#android_id", 0xbf58476d1ce4e5b9L);
        return String.format("%016x%016x", a, b);
    }

    private static long hash(String input, long salt) {
        long h = salt ^ (input.length() * 0x9e3779b9L);
        for (int i = 0; i < input.length(); i++) {
            h ^= input.charAt(i);
            h *= 0x100000001b3L;
        }
        return h;
    }
}
