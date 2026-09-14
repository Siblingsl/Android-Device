package dev.rdc.devicecloak;

import android.opengl.GLES20;
import android.util.Log;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage.LoadPackageParam;

/**
 * Hooks the Java-level GLES/EGL query entry points to report the profile's GL
 * renderer / vendor / version / extensions instead of the x86_64 guest
 * renderer (which leaks "virgl"/"llvmpipe"/host GL strings).
 *
 * Limits: any native code that dlopen()s libGLESv2/libEGL and calls the
 * driver directly bypasses this — this only covers apps going through the
 * public Java APIs.
 */
final class GlHooks {
    private static final String TAG = "DeviceCloak.Gl";

    static void install(LoadPackageParam lpparam, CloakConfig config) {
        try {
            // android.opengl.GLES20.glGetString(int) → GL_RENDERER / GL_VENDOR /
            // GL_VERSION / GL_EXTENSIONS.
            XposedHelpers.findAndHookMethod(
                    GLES20.class,
                    "glGetString",
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            int name = (Integer) param.args[0];
                            switch (name) {
                                case GLES20.GL_RENDERER:
                                    param.setResult(config.glRenderer);
                                    break;
                                case GLES20.GL_VENDOR:
                                    param.setResult(config.glVendor);
                                    break;
                                case GLES20.GL_VERSION:
                                    param.setResult(config.glVersion);
                                    break;
                                default:
                                    // Let GL_EXTENSIONS and others pass through.
                                    break;
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "GLES20.glGetString hook failed", t);
        }

        try {
            // android.opengl.EGL14.eglGetQueryString(EGLDisplay, int) — EGL
            // version/vendor string. EGL14.VENDOR=0x3053, EGL_VERSION=0x3054.
            Class<?> egl14 = Class.forName("android.opengl.EGL14");
            Class<?> eglDisplay = Class.forName("android.opengl.EGLDisplay");
            XposedHelpers.findAndHookMethod(
                    egl14,
                    "eglGetQueryString",
                    eglDisplay,
                    int.class,
                    new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            int name = (Integer) param.args[1];
                            if (name == 0x3053) { // EGL_VENDOR
                                param.setResult(config.glVendor);
                            } else if (name == 0x3054) { // EGL_VERSION
                                param.setResult(config.glVersion);
                            }
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "EGL14.eglGetQueryString hook failed", t);
        }

        XposedBridge.log(TAG + " installed for " + lpparam.packageName);
    }
}
