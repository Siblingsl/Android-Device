package dev.rdc.devicecloak;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Two layers on top of the original "missing sensors get placeholders" trick:
 *
 * 1. Placeholder injection (unchanged): getSensorList / getDefaultSensor gain
 *    the typical phone sensors a redroid guest lacks, so presence checks pass.
 * 2. Physical event generation: when an app registers a listener, a feeder
 *    thread synthesises plausible SensorEvents at the sensor's declared rate —
 *    accelerometer around gravity with noise and the occasional pulse, a
 *    near-zero-drift gyroscope coupled to those pulses, a ~45 µT magnetometer
 *    with a slowly rotating heading, a bounded random-walk light sensor and a
 *    binary proximity sensor with hold times.
 *
 * 3. Replay override: when /data/local/tmp/rdc-cloak/sensors.jsonl exists
 *    (one {"t":seconds,"type":int,"values":[…]} per line), events are replayed
 *    from it in a loop instead of being generated. Capture tooling is NOT part
 *    of this repo — record JSONL on a real device by hand for now (see README).
 *
 * Limits (honest): events are injected by calling the app's listener directly,
 * NOT through the system sensor pipeline — SensorManager is not aware of them.
 * Anything probing the HAL side (dumpsys sensorservice event counters, native
 * sensor NDK polling) still sees no real data. Generation parameters are
 * static per configuration; long-session statistical detectors may notice.
 */
final class SensorHooks {
    private static final String TAG = "DeviceCloak.Sensor";

    /** Replay file pushed next to rdc-cloak.json. Absent → generation. */
    private static final String REPLAY_PATH = "/data/local/tmp/rdc-cloak/sensors.jsonl";

    private static final int[] PHONE_SENSOR_TYPES = {
            Sensor.TYPE_ACCELEROMETER, // 1
            Sensor.TYPE_GYROSCOPE,     // 4
            Sensor.TYPE_MAGNETIC_FIELD, // 2
            Sensor.TYPE_LIGHT,         // 5
            Sensor.TYPE_PROXIMITY,     // 8
    };

    private static final long PULSE_PERIOD_MS = 25_000;
    private static final long PULSE_LENGTH_MS = 600;

    /** listener identity → feeder threads (keyed per sensor type). */
    private static final Map<String, FeederThread> ACTIVE = new ConcurrentHashMap<>();

    private static volatile ReplayData replay;

    static void install(LoadPackageParam lpparam, CloakConfig config) {
        try {
            Class<?> manager = XposedHelpers.findClass(
                    "android.hardware.SystemSensorManager", lpparam.classLoader);

            XposedHelpers.findAndHookMethod(
                    manager,
                    "getSensorList",
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            int type = (Integer) param.args[0];
                            List<?> result = (List<?>) param.getResult();
                            param.setResult(withPlaceholders(result, type));
                        }
                    });

            XposedHelpers.findAndHookMethod(
                    manager,
                    "getDefaultSensor",
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            if (param.getResult() == null) {
                                int type = (Integer) param.args[0];
                                param.setResult(placeholderSensor(type));
                            }
                        }
                    });

            // API 21+ SystemSensorManager#registerListenerImpl(listener, sensor,
            // samplingPeriodUs, handler, maxReportLatencyUs, reservedFlags).
            XposedHelpers.findAndHookMethod(
                    manager,
                    "registerListenerImpl",
                    SensorEventListener.class,
                    Sensor.class,
                    int.class,
                    Handler.class,
                    int.class,
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            if (!Boolean.TRUE.equals(param.getResult())) {
                                return;
                            }
                            startFeeder(param.args[0], (Sensor) param.args[1], config);
                        }
                    });

            XposedHelpers.findAndHookMethod(
                    manager,
                    "unregisterListenerImpl",
                    SensorEventListener.class,
                    Sensor.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            Sensor sensor = (Sensor) param.args[1];
                            if (sensor == null) {
                                stopFeeders(param.args[0], -1);
                            } else {
                                stopFeeders(param.args[0], sensor.getType());
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "sensor hooks failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }

    // ---- feeder management -------------------------------------------------

    private static void startFeeder(Object listener, Sensor sensor, CloakConfig config) {
        if (listener == null || sensor == null || !isPhoneSensor(sensor.getType())) {
            return;
        }
        String key = System.identityHashCode(listener) + ":" + sensor.getType();
        if (ACTIVE.containsKey(key)) {
            return;
        }
        FeederThread feeder = new FeederThread(listener, sensor, config);
        ACTIVE.put(key, feeder);
        feeder.start();
    }

    private static void stopFeeders(Object listener, int type) {
        if (listener == null) {
            return;
        }
        String prefix = System.identityHashCode(listener) + ":";
        for (Map.Entry<String, FeederThread> entry : ACTIVE.entrySet()) {
            boolean matches = type < 0
                    ? entry.getKey().startsWith(prefix)
                    : entry.getKey().equals(prefix + type);
            if (matches) {
                entry.getValue().running = false;
                ACTIVE.remove(entry.getKey());
            }
        }
    }

    private static boolean isPhoneSensor(int type) {
        for (int candidate : PHONE_SENSOR_TYPES) {
            if (candidate == type) {
                return true;
            }
        }
        return false;
    }

    // ---- event value sources ------------------------------------------------

    /** One replay row: seconds offset, sensor type, values. */
    private static final class ReplayEntry {
        final float tSec;
        final int type;
        final float[] values;

        ReplayEntry(float tSec, int type, float[] values) {
            this.tSec = tSec;
            this.type = type;
            this.values = values;
        }
    }

    private static final class ReplayData {
        final List<ReplayEntry> entries = new ArrayList<>();
        float totalSec;
    }

    /** Load the replay file once; null when missing or unparsable. */
    private static ReplayData loadReplay() {
        ReplayData data = replay;
        if (data != null) {
            return data;
        }
        synchronized (SensorHooks.class) {
            if (replay != null) {
                return replay;
            }
            File file = new File(REPLAY_PATH);
            if (!file.isFile()) {
                return null;
            }
            ReplayData parsed = new ReplayData();
            // FileReader(File, Charset) needs API 33; InputStreamReader is safe.
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(file), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) {
                        continue;
                    }
                    JSONObject json = new JSONObject(line);
                    org.json.JSONArray arr = json.getJSONArray("values");
                    float[] values = new float[arr.length()];
                    for (int i = 0; i < arr.length(); i++) {
                        values[i] = (float) arr.getDouble(i);
                    }
                    parsed.entries.add(new ReplayEntry(
                            (float) json.getDouble("t"),
                            json.getInt("type"),
                            values));
                    parsed.totalSec = Math.max(parsed.totalSec,
                            (float) json.getDouble("t"));
                }
            } catch (Throwable t) {
                Log.w(TAG, "replay parse failed, falling back to generation", t);
                return null;
            }
            if (parsed.entries.isEmpty() || parsed.totalSec <= 0) {
                return null;
            }
            replay = parsed;
            return parsed;
        }
    }

    /**
     * Feeder thread: emits SensorEvents to the registered listener until
     * stopped. Replay (looping) when data for the sensor type exists,
     * generation otherwise.
     */
    private static final class FeederThread extends Thread {
        final Object listener;
        final Sensor sensor;
        final CloakConfig config;
        final long periodMs;
        final long startNanos = SystemClock.elapsedRealtimeNanos();
        volatile boolean running = true;
        // per-feeder state for the random walks
        float lightValue;
        boolean proximityNear;
        long modeUntilMs;

        FeederThread(Object listener, Sensor sensor, CloakConfig config) {
            super("DeviceCloak-Sensor-" + sensor.getType());
            this.listener = listener;
            this.sensor = sensor;
            this.config = config;
            setDaemon(true);
            int declaredUs = sensor.getMinDelay();
            if (declaredUs > 0) {
                this.periodMs = Math.max(20, Math.min(250, declaredUs / 1000));
            } else {
                // on-change sensors (light / proximity) have no declared rate
                this.periodMs = 100;
            }
            this.lightValue = config.sensorsLightBase;
            this.modeUntilMs = 0;
        }

        @Override
        public void run() {
            // One accuracy callback so listeners that wait for it proceed.
            try {
                ((SensorEventListener) listener).onAccuracyChanged(sensor, 3);
            } catch (Throwable ignored) {
                // the app may already be gone
            }
            while (running) {
                try {
                    float[] values = nextValues();
                    if (values != null) {
                        dispatch(values);
                    }
                    Thread.sleep(periodMs);
                } catch (InterruptedException e) {
                    running = false;
                    return;
                } catch (Throwable t) {
                    running = false;
                    Log.w(TAG, "feeder stopped", t);
                    return;
                }
            }
        }

        private float[] nextValues() {
            ReplayData data = loadReplay();
            if (data != null) {
                float[] replayed = replayValues(data);
                if (replayed != null) {
                    return replayed;
                }
            }
            return generatedValues();
        }

        private float[] replayValues(ReplayData data) {
            float elapsed = (SystemClock.elapsedRealtimeNanos() - startNanos) / 1_000_000_000f;
            float t = elapsed % data.totalSec;
            ReplayEntry best = null;
            for (ReplayEntry entry : data.entries) {
                if (entry.type == sensor.getType() && entry.tSec <= t
                        && (best == null || best.tSec < entry.tSec)) {
                    best = entry;
                }
            }
            return best == null ? null : best.values;
        }

        private float[] generatedValues() {
            long nowMs = SystemClock.elapsedRealtimeNanos() / 1_000_000;
            long inCycle = nowMs % PULSE_PERIOD_MS;
            float pulse = inCycle <= PULSE_LENGTH_MS
                    ? 1.0f - (inCycle / (float) PULSE_LENGTH_MS)
                    : 0.0f;
            float noise = (float) config.sensorsNoise;
            switch (sensor.getType()) {
                case Sensor.TYPE_ACCELEROMETER: {
                    float gx = noise * (float) Math.sin(nowMs / 700.0);
                    float gy = noise * (float) Math.cos(nowMs / 900.0);
                    float gz = (float) config.sensorsGravity
                            + noise * (float) Math.sin(nowMs / 500.0);
                    return new float[]{gx + pulse * 1.4f, gy + pulse * 0.8f, gz};
                }
                case Sensor.TYPE_GYROSCOPE: {
                    float drift = 0.004f;
                    return new float[]{
                            drift * (float) Math.sin(nowMs / 1100.0) + pulse * 0.35f,
                            drift * (float) Math.cos(nowMs / 1300.0) + pulse * 0.2f,
                            drift * (float) Math.sin(nowMs / 1700.0)};
                }
                case Sensor.TYPE_MAGNETIC_FIELD: {
                    float field = (float) config.sensorsFieldUt;
                    float heading = (float) (nowMs / 120_000.0 * 2.0 * Math.PI);
                    return new float[]{
                            field * (float) Math.cos(heading),
                            field * (float) Math.sin(heading) * 0.7f,
                            field * 0.4f};
                }
                case Sensor.TYPE_LIGHT: {
                    float base = (float) config.sensorsLightBase;
                    float step = base * 0.06f * (float) (Math.random() - 0.5);
                    lightValue += step;
                    float low = base * 0.4f;
                    float high = base * 2.2f;
                    if (lightValue < low) {
                        lightValue = low;
                    }
                    if (lightValue > high) {
                        lightValue = high;
                    }
                    return new float[]{lightValue};
                }
                case Sensor.TYPE_PROXIMITY: {
                    long now = nowMs;
                    if (now > modeUntilMs) {
                        proximityNear = !proximityNear;
                        long hold = 4000 + (long) (Math.random() * 11_000);
                        modeUntilMs = now + hold;
                    }
                    float value = proximityNear ? 0.0f : (float) sensor.getMaximumRange();
                    return new float[]{value};
                }
                default:
                    return null;
            }
        }

        private void dispatch(float[] values) {
            SensorEvent event;
            try {
                Constructor<SensorEvent> ctor =
                        SensorEvent.class.getDeclaredConstructor(int.class);
                ctor.setAccessible(true);
                event = ctor.newInstance(values.length);
            } catch (Throwable t) {
                Log.w(TAG, "SensorEvent construction failed", t);
                running = false;
                return;
            }
            event.values = assignValues(event.values, values);
            event.sensor = sensor;
            event.accuracy = 3;
            event.timestamp = SystemClock.elapsedRealtimeNanos();
            ((SensorEventListener) listener).onSensorChanged(event);
        }

        /** Copy into the event's own array; the field itself is final. */
        private static float[] assignValues(float[] target, float[] source) {
            int n = Math.min(target.length, source.length);
            System.arraycopy(source, 0, target, 0, n);
            return target;
        }
    }

    // ---- placeholder list injection (unchanged behaviour) ------------------

    @SuppressWarnings("unchecked")
    private static List<Object> withPlaceholders(List<?> original, int type) {
        List<Object> merged = new ArrayList<>();
        if (original != null) {
            merged.addAll((List<Object>) original);
        }
        if (!isPhoneSensor(type)) {
            return merged;
        }
        boolean present = merged.stream().anyMatch(sensor -> ((Sensor) sensor).getType() == type);
        if (!present) {
            Sensor placeholder = placeholderSensor(type);
            if (placeholder != null) {
                merged.add(placeholder);
            }
        }
        return merged;
    }

    private static Sensor placeholderSensor(int type) {
        if (!isPhoneSensor(type)) {
            return null;
        }
        try {
            Constructor<Sensor> ctor = Sensor.class.getDeclaredConstructor();
            ctor.setAccessible(true);
            Sensor sensor = ctor.newInstance();
            setField(sensor, "mName", "RDC virtual sensor");
            setField(sensor, "mVendor", "RDC");
            setField(sensor, "mType", type);
            setField(sensor, "mVersion", 1);
            setField(sensor, "mMaxRange", type == Sensor.TYPE_PROXIMITY ? 8.0f : 40.0f);
            setField(sensor, "mResolution", 0.01f);
            setField(sensor, "mPower", 0.5f);
            setField(sensor, "mMinDelay", type == Sensor.TYPE_PROXIMITY ? 0 : 10000);
            return sensor;
        } catch (Throwable t) {
            Log.w(TAG, "placeholder sensor construction failed", t);
            return null;
        }
    }

    private static void setField(Object target, String name, Object value) {
        try {
            java.lang.reflect.Field field = Sensor.class.getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (Throwable ignored) {
            // best-effort
        }
    }
}
