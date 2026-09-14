package dev.rdc.devicecloak;

import android.content.Context;
import android.util.Log;

import java.lang.reflect.Constructor;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Replaces the Google Advertising ID (GAID) with a stable per-device UUID
 * derived from the serial hash, and applies the configured
 * limit-ad-tracking flag.
 *
 * Feasibility note: com.google.android.gms.ads.identifier.AdvertisingIdClient
 * is bundled into each app's APK by the play-services-ads-identifier
 * dependency, so hooking it inside the app process works — the class is
 * resolvable from lpparam.classLoader at package-load time. If a future Play
 * services version moves the class to dynamic code loading, findClass fails
 * here and the hook is skipped (best effort, never crashes the app).
 *
 * The replacement runs in beforeHookedMethod, so the original binder round
 * trip to Play services never happens — also avoids its IOException path.
 *
 * Limits: apps that fetch the advertising id via their own bundled copies of
 * the internal.gms classes or native code bypass this.
 */
final class GaidHooks {
    private static final String TAG = "DeviceCloak.Gaid";
    private static final String CLIENT_CLASS =
            "com.google.android.gms.ads.identifier.AdvertisingIdClient";
    private static final String INFO_CLASS =
            "com.google.android.gms.ads.identifier.AdvertisingIdClient$Info";

    static void install(LoadPackageParam lpparam, CloakConfig config, String serial) {
        final String gaid = stableUuid(serial);
        final boolean limitAdTracking = config.gaidLimitAdTracking;
        try {
            Class<?> infoClass = XposedHelpers.findClass(INFO_CLASS, lpparam.classLoader);
            Constructor<?> infoCtor = infoClass.getConstructor(String.class, boolean.class);
            XposedHelpers.findAndHookMethod(
                    CLIENT_CLASS,
                    lpparam.classLoader,
                    "getAdvertisingIdInfo",
                    Context.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) throws Throwable {
                            param.setResult(infoCtor.newInstance(gaid, limitAdTracking));
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "advertising id hook unavailable (class not bundled in this app?)", t);
            return;
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName
                + " limitAdTracking=" + limitAdTracking);
    }

    /** UUID-style 36 chars: hex of chained hashes, forced to v4 shape. */
    private static String stableUuid(String serial) {
        String input = serial == null || serial.isEmpty() ? "rdc" : serial;
        long a = hash(input, 0x9e3779b97f4a7c15L);
        long b = hash(input + "#gaid1", 0xbf58476d1ce4e5b9L);
        long c = hash(input + "#gaid2", 0x94d049bb133111ebL);
        long d = hash(input + "#gaid3", 0x2545f4914f6cdd1dL);
        String hex = String.format("%016x%016x%016x%016x", a, b, c, d);
        StringBuilder sb = new StringBuilder(36);
        for (int i = 0; i < 32; i++) {
            if (i == 8 || i == 12 || i == 16 || i == 20) {
                sb.append('-');
            }
            sb.append(hex.charAt(i));
        }
        // UUID v4 shape: version nibble '4', variant nibble in [8,9,a,b].
        sb.setCharAt(14, '4');
        sb.setCharAt(19, "89ab".charAt((int) (Math.abs(b) % 4)));
        return sb.toString();
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
