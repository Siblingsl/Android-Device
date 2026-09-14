package dev.rdc.devicecloak;

import android.util.Log;

import java.io.File;
import java.io.FileInputStream;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Redroid guests expose x86_64 through /proc/cpuinfo, /proc/mounts and /sys.
 * When a locally-pushed spoof file exists, redirect Java-level reads of these
 * paths so common fingerprinting code sees the crafted content instead.
 *
 * Covered: java.io.File#canRead/isFile, FileInputStream constructor and
 * Runtime#exec for the /proc//sys prefixes.
 * Limits: direct syscalls (open/read) or native code bypass this.
 */
final class ProcMaskHooks {
    private static final String TAG = "DeviceCloak.Proc";
    private static final String CPUINFO = "/proc/cpuinfo";
    private static final String CPUINFO_SPOOF = "/data/local/tmp/rdc-cloak-cpuinfo";

    static void install(LoadPackageParam lpparam) {
        try {
            XposedHelpers.findAndHookMethod(
                    File.class,
                    "canRead",
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            String path = ((File) param.thisObject).getAbsolutePath();
                            if (CPUINFO.equals(path) && hasSpoof()) {
                                param.setResult(Boolean.TRUE);
                            }
                        }
                    });

            XposedHelpers.findAndHookMethod(
                    File.class,
                    "isFile",
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            String path = ((File) param.thisObject).getAbsolutePath();
                            if (CPUINFO.equals(path) && hasSpoof()) {
                                param.setResult(Boolean.TRUE);
                            }
                        }
                    });

            XposedHelpers.findAndHookConstructor(
                    FileInputStream.class,
                    String.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            String path = (String) param.args[0];
                            if (CPUINFO.equals(path) && hasSpoof()) {
                                param.args[0] = CPUINFO_SPOOF;
                            }
                        }
                    });

            // Runtime.exec (and ProcessBuilder via Runtime) commands like
            // `cat /proc/cpuinfo` — rewrite the argument string when present.
            XposedHelpers.findAndHookMethod(
                    Runtime.class,
                    "exec",
                    String[].class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            String[] cmd = (String[]) param.args[0];
                            if (cmd == null || !hasSpoof()) {
                                return;
                            }
                            for (int i = 0; i < cmd.length; i++) {
                                if (cmd[i] != null && cmd[i].contains(CPUINFO)) {
                                    cmd[i] = cmd[i].replace(CPUINFO, CPUINFO_SPOOF);
                                }
                            }
                            param.args[0] = cmd;
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "proc mask hooks failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }

    private static boolean hasSpoof() {
        return new File(CPUINFO_SPOOF).isFile();
    }
}
