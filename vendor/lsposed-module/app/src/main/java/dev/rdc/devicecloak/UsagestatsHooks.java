package dev.rdc.devicecloak;

import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Synthesizes a usage-stats baseline inside the hooked app's process.
 *
 * A freshly created container reports "installed minutes ago, never used"
 * through {@link UsageStatsManager#queryUsageStats} / {@link #queryEvents} —
 * one of the loudest zero-history tells. Writing the real
 * /data/system/usagestats store is not viable (the system server owns and
 * rebuilds it), so this hook layers synthetic records on top of whatever the
 * real service returns, inside the target app's process only.
 *
 * Inputs (seeded by the RDC desktop app, see services/usage.rs):
 * <ul>
 *   <li>/data/local/tmp/rdc-cloak/usage-pkg-list — one package name per line,
 *       brand-distributed;</li>
 *   <li>/data/local/tmp/rdc-cloak.json → {@code usage.seededDays} — the window
 *       (days) seeded activity is spread across, default 90.</li>
 * </ul>
 *
 * Determinism: install / last-use times are derived from a hash of the
 * package name and the device serial, so the same package always reports the
 * same times (stable across app restarts and queries) while different
 * packages get different placements.
 *
 * Honest limits (see README): everything is reflection-based because the
 * involved constructors/fields are not public API; on an Android version
 * where a field is renamed or removed, the hook silently degrades (original
 * value returned / field skipped) instead of crashing the host app.
 */
final class UsagestatsHooks {
    private static final String TAG = "DeviceCloak";

    /** Same staging dir the desktop app writes (chmod 777) — see usage.rs. */
    private static final String PKG_LIST_PATH = "/data/local/tmp/rdc-cloak/usage-pkg-list";

    private UsagestatsHooks() {
    }

    static void install(LoadPackageParam lpparam, CloakConfig config, String serial) {
        try {
            XposedHelpers.findAndHookMethod(
                    UsageStatsManager.class,
                    "queryUsageStats",
                    int.class,
                    long.class,
                    long.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) throws Throwable {
                            try {
                                @SuppressWarnings("unchecked")
                                List<UsageStats> original =
                                        (List<UsageStats>) param.getResult();
                                param.setResult(
                                        augmentUsageStats(original, config, serial, param));
                            } catch (Throwable t) {
                                XposedBridge.log(t);
                            }
                        }
                    });
        } catch (Throwable t) {
            XposedBridge.log(t);
            return; // no queryUsageStats hook → events hook alone is pointless
        }

        try {
            XposedHelpers.findAndHookMethod(
                    UsageStatsManager.class,
                    "queryEvents",
                    long.class,
                    long.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) throws Throwable {
                            try {
                                param.setResult(augmentUsageEvents(
                                        (UsageEvents) param.getResult(),
                                        config,
                                        serial,
                                        (Long) param.args[0],
                                        (Long) param.args[1]));
                            } catch (Throwable t) {
                                XposedBridge.log(t);
                            }
                        }
                    });
        } catch (Throwable t) {
            XposedBridge.log(t);
        }
        // The no-arg queryEvents() overload only covers the last ~7 days via a
        // fixed window; the 2-arg overload above is what fingerprinting SDKs
        // actually call, so the no-arg path is deliberately left untouched.
    }

    // ------------------------------------------------------------------ //
    // queryUsageStats synthesis                                          //
    // ------------------------------------------------------------------ //

    private static List<UsageStats> augmentUsageStats(
            List<UsageStats> original,
            CloakConfig config,
            String serial,
            XC_MethodHook.MethodHookParam param) {
        long[] window = windowFromArgs(param);
        List<UsageStats> result = new ArrayList<>();
        Set<String> present = new HashSet<>();
        if (original != null) {
            result.addAll(original);
            for (UsageStats stats : original) {
                try {
                    String pkg = (String) getObjectField(stats, "mPackageName");
                    if (pkg != null) {
                        present.add(pkg);
                    }
                } catch (Throwable ignored) {
                    // Cannot read the package name → leave this entry as-is.
                }
            }
        }
        long now = System.currentTimeMillis();
        for (String pkg : loadPackageList(config)) {
            if (present.contains(pkg)) {
                continue; // real record wins — never contradict the service
            }
            UsageStats synthetic = buildUsageStats(pkg, serial, config, now, window);
            if (synthetic != null) {
                result.add(synthetic);
            }
        }
        return result;
    }

    private static UsageStats buildUsageStats(
            String pkg,
            String serial,
            CloakConfig config,
            long now,
            long[] window) {
        try {
            UsageStats stats = new UsageStats();
            long spanDays = Math.max(1, config.usageSeededDays);
            // Stable per (package, serial): fraction in [0, 1).
            double installFrac = frac(serial, pkg, "install");
            double lastUseFrac = frac(serial, pkg, "lastuse");
            // Installed: within the seeded window, biased to the older half.
            long installTime = now - (long) (spanDays * 86_400_000.0 * (0.5 + 0.5 * installFrac));
            // Last used: recent but never after `now`, never before install.
            long lastTimeUsed = now - (long) (spanDays * 86_400_000.0 * 0.1 * lastUseFrac);
            if (lastTimeUsed < installTime) {
                lastTimeUsed = installTime;
            }
            if (window != null) {
                // Clamp into the queried window so the record is visible to
                // this specific query instead of being filtered downstream.
                installTime = clampMin(installTime, window[0]);
                lastTimeUsed = clamp(lastTimeUsed, window[0], window[1]);
            }
            setLongField(stats, "mBeginTimeStamp", installTime);
            setLongField(stats, "mEndTimeStamp", Math.max(lastTimeUsed, now));
            setLongField(stats, "mLastTimeUsed", lastTimeUsed);
            setLongField(stats, "mTotalTimeInForeground", 30_000L + (long) (lastUseFrac * 3_600_000.0));
            setIntField(stats, "mLaunchCount", 3 + (int) (lastUseFrac * 60));
            setObjectField(stats, "mPackageName", pkg);
            return stats;
        } catch (Throwable t) {
            // UsageStats internals differ across builds — degrade silently.
            XposedBridge.log(t);
            return null;
        }
    }

    // ------------------------------------------------------------------ //
    // queryEvents synthesis                                              //
    // ------------------------------------------------------------------ //

    private static UsageEvents augmentUsageEvents(
            UsageEvents original,
            CloakConfig config,
            String serial,
            long beginTime,
            long endTime) {
        try {
            UsageEvents events = (original != null) ? original : new UsageEvents();
            Object list = getObjectField(events, "mEvents");
            if (!(list instanceof List)) {
                return original; // internal layout unknown — return untouched
            }
            @SuppressWarnings("unchecked")
            List<Object> eventList = (List<Object>) list;
            long now = System.currentTimeMillis();
            long from = (beginTime > 0) ? beginTime : now - 7L * 86_400_000L;
            long to = (endTime > 0) ? endTime : now;
            if (to > now) {
                to = now;
            }
            for (String pkg : loadPackageList(config)) {
                Object event = buildEvent(pkg, serial, from, to);
                if (event != null) {
                    eventList.add(event);
                }
            }
            // Reset the read cursor so the caller iterates from the start.
            setIntField(events, "mIndex", 0);
            return events;
        } catch (Throwable t) {
            XposedBridge.log(t);
            return original;
        }
    }

    private static Object buildEvent(String pkg, String serial, long from, long to) {
        try {
            UsageEvents.Event event = new UsageEvents.Event();
            double frac = frac(serial, pkg, "event");
            long ts = from + (long) ((to - from) * frac);
            setLongField(event, "mTimeStamp", ts);
            setIntField(event, "mEventType", 1); // MOVE_TO_FOREGROUND
            // Field names shifted across Android versions (mPackage / mClass);
            // a missing field is skipped rather than failing the whole event.
            trySetObjectField(event, "mPackage", pkg);
            trySetObjectField(event, "mClass", pkg);
            return event;
        } catch (Throwable t) {
            XposedBridge.log(t);
            return null;
        }
    }

    // ------------------------------------------------------------------ //
    // shared helpers                                                     //
    // ------------------------------------------------------------------ //

    /** Package list from the seeded file; empty list disables the hook. */
    private static List<String> loadPackageList(CloakConfig config) {
        List<String> out = new ArrayList<>();
        try {
            File file = new File(PKG_LIST_PATH);
            if (!file.isFile()) {
                return out;
            }
            for (String line : new String(Files.readAllBytes(file.toPath()),
                    StandardCharsets.UTF_8).split("\n")) {
                String pkg = line.trim();
                if (!pkg.isEmpty() && !pkg.startsWith("#")) {
                    out.add(pkg);
                }
            }
        } catch (Throwable t) {
            XposedBridge.log(t);
        }
        return out;
    }

    /** FNV-1a over (serial|pkg|salt) → fraction in [0, 1); stable forever. */
    private static double frac(String serial, String pkg, String salt) {
        long h = 0xcbf29ce484222325L;
        String input = serial + "|" + pkg + "|" + salt;
        for (int i = 0; i < input.length(); i++) {
            h ^= input.charAt(i);
            h *= 0x100000001b3L;
        }
        return (h & 0xffffffffL) / 4294967296.0;
    }

    private static long[] windowFromArgs(XC_MethodHook.MethodHookParam param) {
        try {
            long begin = (Long) param.args[1];
            long end = (Long) param.args[2];
            return new long[]{begin, end};
        } catch (Throwable t) {
            return null;
        }
    }

    private static long clamp(long v, long min, long max) {
        return Math.max(min, Math.min(max, v));
    }

    private static long clampMin(long v, long min) {
        return Math.max(v, min);
    }

    private static Field field(Class<?> clazz, String name) throws Throwable {
        Field f = clazz.getDeclaredField(name);
        f.setAccessible(true);
        return f;
    }

    private static Object getObjectField(Object target, String name) throws Throwable {
        return field(target.getClass(), name).get(target);
    }

    private static void setLongField(Object target, String name, long value) throws Throwable {
        field(target.getClass(), name).setLong(target, value);
    }

    private static void setIntField(Object target, String name, int value) throws Throwable {
        field(target.getClass(), name).setInt(target, value);
    }

    private static void setObjectField(Object target, String name, Object value) throws Throwable {
        field(target.getClass(), name).set(target, value);
    }

    /** Best-effort setter: silently skips fields that don't exist on this API. */
    private static void trySetObjectField(Object target, String name, Object value) {
        try {
            setObjectField(target, name, value);
        } catch (Throwable ignored) {
            // Field absent on this API level — acceptable degradation.
        }
    }
}
