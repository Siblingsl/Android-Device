package dev.rdc.devicecloak;

import android.util.Log;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Entry point listed in assets/xposed_init. Registers each hook family for the
 * target app process only (LSPosed enforces the scope; this module hooks in
 * every loaded package and the runtime decides).
 */
public class MainHook implements IXposedHookLoadPackage {
    private static final String TAG = "DeviceCloak";

    @Override
    public void handleLoadPackage(final LoadPackageParam lpparam) throws Throwable {
        try {
            final CloakConfig config = CloakConfig.load();
            final String serial = readSerial();

            GlHooks.install(lpparam, config);
            SensorHooks.install(lpparam, config);
            ProcMaskHooks.install(lpparam);
            TelephonyHooks.install(lpparam, config, serial);
            IdHooks.install(lpparam, serial);
            WidevineHooks.install(lpparam, config, serial);
            GaidHooks.install(lpparam, config, serial);
            GsfHooks.install(lpparam, config, serial);
            UsagestatsHooks.install(lpparam, config, serial);
        } catch (Throwable t) {
            Log.w(TAG, "handleLoadPackage failed", t);
        }
    }

    private static String readSerial() {
        try {
            // android.os.Build.getSerial is deprecated but stable enough as a
            // per-device seed; it may return "unknown" on hardened builds, in
            // which case the module still derives a stable value from the
            // fallback seed below.
            String serial = android.os.Build.getSerial();
            if (serial != null && !serial.trim().isEmpty()
                    && !"unknown".equalsIgnoreCase(serial.trim())) {
                return serial.trim();
            }
        } catch (Throwable ignored) {
            // ignore
        }
        return "rdc";
    }
}
