package dev.rdc.devicecloak;

import android.media.MediaDrm;
import android.util.Log;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Hooks the MediaDrm property read path so Widevine fingerprints look device-
 * like instead of container-like.
 *
 * Real API note: the property getters take NO session id —
 * {@code getPropertyByteArray(String)} / {@code getPropertyString(String)}.
 * Session-scoped methods (getKeyRequest etc.) are left untouched.
 *
 * - "device_unique_id" / "widevine_id": stable 32 bytes derived from the
 *   device serial (two chained 64-bit hashes), the same deterministic pattern
 *   as IdHooks.
 * - "security_level": comes from rdc-cloak.json (widevine.security_level,
 *   default "L3"). "L1" can be configured but is a risk: redroid on x86 has no
 *   TEE, so an L1 claim without matching hardware attestation is itself a
 *   detection signal. Keep L3 unless you know the target only gates on it.
 * - "algorithms" and every other property pass through untouched.
 *
 * Limits: only the Java API is covered. Native code that dlopens libwvhidl /
 * talks to the drm HAL directly bypasses this. Constructor overloads of
 * MediaDrm are not hooked — instance methods are hooked at class level so
 * every MediaDrm instance (any constructor) is covered.
 */
final class WidevineHooks {
    private static final String TAG = "DeviceCloak.Widevine";

    static void install(LoadPackageParam lpparam, CloakConfig config, String serial) {
        final byte[] deviceId = stableDeviceId(serial);
        final String securityLevel = config.widevineSecurityLevel;

        try {
            XposedHelpers.findAndHookMethod(
                    MediaDrm.class,
                    "getPropertyByteArray",
                    String.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            String name = (String) param.args[0];
                            if ("device_unique_id".equals(name) || "widevine_id".equals(name)) {
                                param.setResult(deviceId);
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "getPropertyByteArray hook failed", t);
        }

        try {
            XposedHelpers.findAndHookMethod(
                    MediaDrm.class,
                    "getPropertyString",
                    String.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            String name = (String) param.args[0];
                            if ("security_level".equals(name)) {
                                param.setResult(securityLevel);
                            }
                            // "algorithms" and everything else passes through.
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "getPropertyString hook failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName
                + " security_level=" + securityLevel);
    }

    /** 32 stable bytes: four independent 64-bit hashes of the serial. */
    private static byte[] stableDeviceId(String serial) {
        String input = serial == null || serial.isEmpty() ? "rdc" : serial;
        long a = hash(input, 0x9e3779b97f4a7c15L);
        long b = hash(input + "#wv1", 0xbf58476d1ce4e5b9L);
        long c = hash(input + "#wv2", 0x94d049bb133111ebL);
        long d = hash(input + "#wv3", 0x2545f4914f6cdd1dL);
        byte[] out = new byte[32];
        putLong(out, 0, a);
        putLong(out, 8, b);
        putLong(out, 16, c);
        putLong(out, 24, d);
        return out;
    }

    private static void putLong(byte[] target, int offset, long value) {
        for (int i = 0; i < 8; i++) {
            target[offset + i] = (byte) (value >>> (56 - i * 8));
        }
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
