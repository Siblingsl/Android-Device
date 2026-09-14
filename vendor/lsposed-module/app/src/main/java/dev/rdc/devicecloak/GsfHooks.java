package dev.rdc.devicecloak;

import android.content.ContentResolver;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Best-effort GSF (Google Services Framework) ID spoofing.
 *
 * Where the GSF id actually lives (researched, not guessed):
 *  - Play services / GSF persist it in com.google.android.gsf's
 *    gservices.db, key "android_id" (a 16-hex-char string).
 *  - The Java-level read path most device-id libraries use is a
 *    ContentResolver query on content://com.google.android.gsf.gservices/
 *    with selectionArgs {"android_id"}, reading the value column.
 *  - Some code paths go through Settings.Secure#getStringForUser(…,
 *    "android_id", userId) instead of getString.
 *
 * This hook covers those two Java paths and is DISABLED by default
 * (rdc-cloak.json → gsf.enabled). It only has any effect when the LSPosed
 * scope includes com.google.android.gsf / com.google.android.gms /
 * com.android.vending — hooking the caller's process does nothing if the
 * value is fetched inside the GSF process.
 *
 * Honest boundary: the GSF id is bound to the signed-in Google account on the
 * server side, and Play services can reconcile it against the account. A local
 * hook alone cannot make a container look like a different physical device to
 * Google. Per-instance accounts are the only reliable separation — see README.
 */
final class GsfHooks {
    private static final String TAG = "DeviceCloak.Gsf";
    private static final String GSERVICES_AUTHORITY = "com.google.android.gsf.gservices";
    private static final String ANDROID_ID = "android_id";

    static void install(LoadPackageParam lpparam, CloakConfig config, String serial) {
        if (!config.gsfEnabled) {
            XposedBridge.log(TAG + " disabled by config for " + lpparam.packageName);
            return;
        }
        final String gsfId = stableHex(serial);

        // Path 1: Settings.Secure#getStringForUser(ContentResolver, String, int)
        try {
            XposedHelpers.findAndHookMethod(
                    Settings.Secure.class,
                    "getStringForUser",
                    ContentResolver.class,
                    String.class,
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            if (ANDROID_ID.equals(param.args[1])) {
                                param.setResult(gsfId);
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "getStringForUser hook failed", t);
        }

        // Path 2: ContentResolver#query on the gservices provider.
        try {
            XposedHelpers.findAndHookMethod(
                    ContentResolver.class,
                    "query",
                    Uri.class,
                    String[].class,
                    String.class,
                    String[].class,
                    String.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            Uri uri = (Uri) param.args[0];
                            if (!isGservicesAndroidId(uri, (String[]) param.args[3])) {
                                return;
                            }
                            MatrixCursor cursor = new MatrixCursor(new String[]{"value"});
                            cursor.addRow(new Object[]{gsfId});
                            param.setResult(cursor);
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "ContentResolver.query hook failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }

    /** True for the gservices android_id read pattern only. */
    private static boolean isGservicesAndroidId(Uri uri, String[] selectionArgs) {
        if (uri == null) {
            return false;
        }
        String authority = uri.getAuthority();
        if (authority == null || !authority.contains(GSERVICES_AUTHORITY)) {
            return false;
        }
        if (selectionArgs == null) {
            // gservices also accepts ?name=… / path segments; only take the
            // unambiguous query-arg form to avoid masking unrelated reads.
            return uri.getQueryParameter("name") != null
                    && ANDROID_ID.equals(uri.getQueryParameter("name"));
        }
        for (String arg : selectionArgs) {
            if (ANDROID_ID.equals(arg)) {
                return true;
            }
        }
        return false;
    }

    /** 16 hex chars (one 64-bit hash), the shape of a real GSF id. */
    private static String stableHex(String serial) {
        String input = serial == null || serial.isEmpty() ? "rdc" : serial;
        long a = hash(input + "#gsf", 0xbf58476d1ce4e5b9L);
        return String.format("%016x", a);
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
