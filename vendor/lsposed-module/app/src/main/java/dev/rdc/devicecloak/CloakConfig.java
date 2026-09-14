package dev.rdc.devicecloak;

import android.util.Log;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Loads /data/local/tmp/rdc-cloak.json (pushed by the RDC desktop app) and
 * exposes typed overrides with safe fallbacks. If the file is absent the
 * module uses its compiled-in defaults.
 */
final class CloakConfig {
    private static final String TAG = "DeviceCloak";
    private static final String CONFIG_PATH = "/data/local/tmp/rdc-cloak.json";

    final String glRenderer;
    final String glVendor;
    final String glVersion;
    final String operator;
    final String operatorName;
    /** MediaDrm security_level reported to apps. Keep "L3" — see WidevineHooks. */
    final String widevineSecurityLevel;
    /** Advertising ID limit-ad-tracking flag served by GaidHooks. */
    final boolean gaidLimitAdTracking;
    /** GSF id hooks are OFF by default — see GsfHooks for the honest limits. */
    final boolean gsfEnabled;
    /** Sensor generation parameters (SensorHooks). */
    final double sensorsGravity;
    final double sensorsNoise;
    final double sensorsFieldUt;
    final double sensorsLightBase;
    /** Usage-baseline window in days (UsagestatsHooks). */
    final int usageSeededDays;

    CloakConfig(
            String glRenderer,
            String glVendor,
            String glVersion,
            String operator,
            String operatorName,
            String widevineSecurityLevel,
            boolean gaidLimitAdTracking,
            boolean gsfEnabled,
            double sensorsGravity,
            double sensorsNoise,
            double sensorsFieldUt,
            double sensorsLightBase,
            int usageSeededDays) {
        this.glRenderer = glRenderer;
        this.glVendor = glVendor;
        this.glVersion = glVersion;
        this.operator = operator;
        this.operatorName = operatorName;
        this.widevineSecurityLevel = widevineSecurityLevel;
        this.gaidLimitAdTracking = gaidLimitAdTracking;
        this.gsfEnabled = gsfEnabled;
        this.sensorsGravity = sensorsGravity;
        this.sensorsNoise = sensorsNoise;
        this.sensorsFieldUt = sensorsFieldUt;
        this.sensorsLightBase = sensorsLightBase;
        this.usageSeededDays = usageSeededDays;
    }

    static CloakConfig defaults() {
        return new CloakConfig(
                "Adreno (TM) 740",
                "Qualcomm",
                "OpenGL ES 3.2 V@0615.73",
                "46000",
                "China Mobile",
                "L3",
                false,
                false,
                9.81,
                0.05,
                45.0,
                300.0,
                90);
    }

    static CloakConfig load() {
        try {
            File file = new File(CONFIG_PATH);
            if (!file.isFile()) {
                return defaults();
            }
            String text = new String(
                    Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSONObject root = new JSONObject(text);
            JSONObject gl = root.optJSONObject("gl");
            JSONObject telephony = root.optJSONObject("telephony");
            JSONObject widevine = root.optJSONObject("widevine");
            JSONObject gaid = root.optJSONObject("gaid");
            JSONObject gsf = root.optJSONObject("gsf");
            JSONObject sensors = root.optJSONObject("sensors");
            JSONObject usage = root.optJSONObject("usage");
            CloakConfig defaults = defaults();
            return new CloakConfig(
                    gl == null ? defaults.glRenderer : gl.optString("renderer", defaults.glRenderer),
                    gl == null ? defaults.glVendor : gl.optString("vendor", defaults.glVendor),
                    gl == null ? defaults.glVersion : gl.optString("version", defaults.glVersion),
                    telephony == null ? defaults.operator
                            : telephony.optString("operator", defaults.operator),
                    telephony == null ? defaults.operatorName
                            : telephony.optString("operator_name", defaults.operatorName),
                    widevine == null ? defaults.widevineSecurityLevel
                            : widevine.optString("security_level", defaults.widevineSecurityLevel),
                    gaid != null && gaid.optBoolean("limit_ad_tracking", defaults.gaidLimitAdTracking),
                    gsf != null && gsf.optBoolean("enabled", defaults.gsfEnabled),
                    sensors == null ? defaults.sensorsGravity
                            : sensors.optDouble("gravity", defaults.sensorsGravity),
                    sensors == null ? defaults.sensorsNoise
                            : sensors.optDouble("noise", defaults.sensorsNoise),
                    sensors == null ? defaults.sensorsFieldUt
                            : sensors.optDouble("field_ut", defaults.sensorsFieldUt),
                    sensors == null ? defaults.sensorsLightBase
                            : sensors.optDouble("light_base", defaults.sensorsLightBase),
                    usage == null ? defaults.usageSeededDays
                            : usage.optInt("seededDays", defaults.usageSeededDays));
        } catch (Throwable t) {
            Log.w(TAG, "load config failed, using defaults", t);
            return defaults();
        }
    }
}
