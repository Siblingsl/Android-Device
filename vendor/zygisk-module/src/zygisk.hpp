/* Vendored Zygisk module API header (v2).
 *
 * Provenance: derived from the Magisk repository (topjohnwu/Magisk,
 * native/src/zygisk/api.hpp — the generated zygisk.hpp distributed with the
 * zygisk-module samples). Kept ABI-compatible with upstream v2: the exported
 * entry symbol (`zygisk_module_entry`) and the Api vtable order below must
 * not change or the module will misbehave inside the zygote.
 *
 * NOTE (RDC): before building for production, prefer overwriting this file
 * with the official header shipped in the Magisk repo to pick up upstream
 * fixes — see README.md "Using the upstream header".
 */

#pragma once

#include <jni.h>

#define ZYGISK_API_VERSION 2

namespace zygisk {

struct Api;

struct ModuleBase;

// Whether the module dir was successfully mounted for this process.
enum State : int {
    NOT_MOUNTED = 0,
    MOUNTED = 1,
};

enum Option : int {
    // Force the process to be unmounted from the denylist.
    FORCE_DENYLIST_UNMOUNT = 0,
    // Report a mount error to the daemon (diagnostics).
    DLCM_MOUNT_ERROR = 1,
};

// Arguments handed to pre/postAppSpecialize. Some trailing fields are
// optional and may be null depending on the Android version.
struct AppSpecializeArgs {
    jint &uid;
    jint &gid;
    jintArray &gids;
    jint &runtime_flags;
    jobjectArray &rlimits;
    jint &mount_external;
    jstring &se_info;
    jstring &nice_name;
    jstring &instruction_set;
    jstring &app_data_dir;

    // Optional — null on some Android versions.
    jboolean *const is_child_zygote;
    jboolean *const is_top_app;
    jobjectArray *const pkg_data_info_list;
    jobjectArray *const whitelisted_data_info_list;
    jobjectArray *const mount_data_dirs;
    jobjectArray *const mount_storage_dirs;
};

struct ServerSpecializeArgs {
    jint &uid;
    jint &gid;
    jintArray &gids;
    jint &runtime_flags;
    jlong &permitted_capabilities;
    jlong &effective_capabilities;
};

struct ModuleBase {
    // Called when the module is loaded into a (zygote-child) process.
    virtual void onLoad([[maybe_unused]] Api *api, [[maybe_unused]] JNIEnv *env) {}

    // Called before the forked zygote process is specialized into an app.
    virtual void preAppSpecialize([[maybe_unused]] AppSpecializeArgs *args) {}

    // Called after specialization; native libraries of the app may still be
    // loading, so install PLT hooks for system libraries here at the latest.
    virtual void postAppSpecialize([[maybe_unused]] const AppSpecializeArgs *args) {}

    virtual void preServerSpecialize([[maybe_unused]] ServerSpecializeArgs *args) {}

    virtual void postServerSpecialize([[maybe_unused]] const ServerSpecializeArgs *args) {}
};

// The ABI surface implemented by the Zygisk daemon. The vtable order below
// is part of API v2 — do NOT reorder.
struct Api {
    void setOption(Option opt);

    // Replace a JNI native method implementation at runtime.
    void hookJniNativeMethods(const char *className, const char *methodSig, void *fnPtr,
                              void **backup);

    // Register a GOT/PLT hook: every matching library (regex on full path)
    // importing `symbol` gets its GOT entry redirected to `fn`; the original
    // is stored into *backup.
    void pltHookRegister(const char *regex, const char *symbol, void *fn, void **backup);

    // Exclude matching libraries from a previously registered hook.
    void pltHookExclude(const char *regex, const char *symbol);

    // Apply all registered PLT hooks (call once, after preAppSpecialize).
    bool pltHookCommit();

    // Open a connection to the module's root companion process (magiskd).
    int connectCompanion();

    // Reserved for upstream compatibility — no-op in v2.
    void pltHookUnregister();

    // Request the module dir fd (must be pre-opened via companion).
    void getModuleDir(int fd);
};

namespace internal {
// Implemented by libzygisk (injected into the zygote): forwards the module
// instance to the daemon and wires the specialize callbacks.
void mod_entry(zygisk::Api *api, JNIEnv *env, ModuleBase *module);
} // namespace internal

} // namespace zygisk

// The entry symbol the Zygisk injector looks up (dlsym) after dlopen-ing the
// module .so. Must keep C linkage-style visibility and this exact name.
#define REGISTER_ZYGISK_MODULE(clazz)                                          \
    extern "C" [[gnu::visibility("default")]] void zygisk_module_entry(        \
        zygisk::Api *api, JNIEnv *env) {                                       \
        static clazz module;                                                   \
        zygisk::internal::mod_entry(api, env, &module);                        \
    }
