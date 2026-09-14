package dev.rdc.devicecloak;

import android.telephony.TelephonyManager;
import android.util.Log;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Stable pseudo telephony identity derived from the device serial hash, so
 * every call returns the same value within a device. IMEI uses a legal TAC
 * segment plus a Luhn check digit; operator comes from the pushed config.
 *
 * Limits: hooks the deprecated/restricted getters most fingerprinting apps
 * still call; some APIs are dropped or need READ_PRIVILEGED_PHONE_STATE on new
 * Android and will throw before we can intercept.
 */
final class TelephonyHooks {
    private static final String TAG = "DeviceCloak.Telephony";

    static void install(LoadPackageParam lpparam, CloakConfig config, String serial) {
        final long seed = hash(serial);
        final String imei = buildImei(seed);
        final String meid = buildMeid(seed);

        hook(lpparam, "getDeviceId", imei);
        hook(lpparam, "getImei", imei);
        hook(lpparam, "getMeid", meid);
        hook(lpparam, "getSimOperator", config.operator);
        hook(lpparam, "getSimOperatorName", config.operatorName);
        hook(lpparam, "getNetworkOperator", config.operator);
        hook(lpparam, "getLine1Number", "+86" + digits(seed, 11));
        hook(lpparam, "getSimSerialNumber", digits(seed, 19));

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }

    private static void hook(LoadPackageParam lpparam, String method, String value) {
        try {
            XposedHelpers.findAndHookMethod(
                    TelephonyManager.class,
                    method,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            param.setResult(value);
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "hook " + method + " failed", t);
        }
    }

    private static long hash(String seed) {
        long h = 1125899906842597L;
        String input = seed == null || seed.isEmpty() ? "rdc" : seed;
        for (char c : input.toCharArray()) {
            h = 31 * h + c;
        }
        return h & 0x7fffffffffffffffL;
    }

    private static String digits(long seed, int count) {
        StringBuilder sb = new StringBuilder(count);
        long value = seed;
        for (int i = 0; i < count; i++) {
            value = value * 6364136223846793005L + 1442695040888963407L;
            sb.append((char) ('0' + Math.abs(value % 10)));
        }
        return sb.toString();
    }

    // 15 digits: legal TAC (first 8, "86" prefix unused here) + serial + Luhn.
    private static String buildImei(long seed) {
        String body = "35" + digits(seed, 6) + digits(seed + 1, 6);
        return body + luhnCheckDigit(body);
    }

    private static String buildMeid(long seed) {
        String body = "A0" + digits(seed + 2, 11).toUpperCase();
        return body + luhnHexDigit(body);
    }

    private static char luhnCheckDigit(String digitsOnly) {
        int sum = 0;
        boolean alternate = true;
        for (int i = digitsOnly.length() - 1; i >= 0; i--) {
            int n = digitsOnly.charAt(i) - '0';
            if (alternate) {
                n *= 2;
                if (n > 9) {
                    n -= 9;
                }
            }
            sum += n;
            alternate = !alternate;
        }
        return (char) ('0' + ((10 - (sum % 10)) % 10));
    }

    private static char luhnHexDigit(String body) {
        int sum = 0;
        for (int i = 0; i < body.length(); i++) {
            int v = Character.digit(body.charAt(i), 16);
            sum += (i % 2 == 0) ? v * 2 : v;
            if (v * 2 > 15) {
                sum += 1;
            }
        }
        return "0123456789ABCDEF".charAt((16 - (sum % 16)) % 16);
    }
}
