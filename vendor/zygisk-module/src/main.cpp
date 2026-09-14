// RDC NativeCloak — Zygisk native companion for the Redroid Device Center
// "L3 container trace cleansing" feature.
//
// Division of labour (see README.md):
//   * DeviceCloak (vendor/lsposed-module, Java/Xposed)  → framework APIs
//     (props via XSharedPreferences, Build.*, GL via app-level getters,
//     telephony).
//   * NativeCloak (this module, C++/Zygisk)             → PLT-level direct
//     syscalls that no Java layer can see: `openat` on /proc/self/cgroup,
//     /proc/self/mountinfo, /proc/mounts, plus the native
//     eglQueryString/glGetString entry points.
//
// Target: redroid containers run x86_64 images, so the shipped .so for
// containers is x86_64 (arm64-v8a is also built for physical-device testing).
//
// STATUS: source deliverable — NOT compiled in this environment (no NDK).
// Build with build.sh; output lands in dist/.

#include <android/log.h>

#include <cctype>
#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <unistd.h>

#include <elf.h>
#include <link.h>
#include <sys/mman.h>
#include <sys/types.h>

#include "zygisk.hpp"

using zygisk::Api;
using zygisk::AppSpecializeArgs;
using zygisk::ModuleBase;
using zygisk::ServerSpecializeArgs;

#define LOG_TAG "RDC-NativeCloak"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)

namespace {

// ---------------------------------------------------------------------------
// Configuration paths. rdc-cloak.json is pushed by the desktop app
// (services/cloak.rs → push_cloak_config) and read once per process.
// Sanitized /proc snapshots are cached under kCloakDir (created 0777 by
// customize.sh) and re-written on first read per process.
// ---------------------------------------------------------------------------
constexpr const char *kConfigPath = "/data/local/tmp/rdc-cloak.json";
constexpr const char *kCloakDir = "/data/local/tmp/rdc-cloak";

// Cgroup sanitization: any docker-style segment is rewritten to look like a
// systemd-managed service slice. This complements the container-level
// `--cgroup-parent system.slice` flag set by the desktop app: the flag strips
// "docker" from real cgroup paths, and this rewrite catches readers inside
// older images where /docker/<id> would still show up.
constexpr const char *kFakeCgroupSlice = "/system.slice/rdc-instance.service";

// GL defaults mirror services/cloak.rs `gl_for()` so that a missing config
// still yields coherent strings for the default (SM8550 / Qualcomm) profile.
constexpr const char *kDefaultGlRenderer = "Adreno (TM) 740";
constexpr const char *kDefaultGlVendor = "Qualcomm";
constexpr const char *kDefaultGlVersion = "OpenGL ES 3.2 V@0615.73";

std::string g_gl_renderer;
std::string g_gl_vendor;
std::string g_gl_version;
std::string g_egl_vendor;
std::string g_egl_version;
std::once_flag g_config_once;

// --- naive JSON field lookup (no deps): finds "key": "value" occurrences ---
std::string json_string_field(const std::string &json, const std::string &key) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return {};
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return {};
    pos = json.find('"', pos + 1);
    if (pos == std::string::npos) return {};
    std::string out;
    for (size_t i = pos + 1; i < json.size(); ++i) {
        char c = json[i];
        if (c == '\\' && i + 1 < json.size()) {
            out.push_back(json[++i]);
            continue;
        }
        if (c == '"') break;
        out.push_back(c);
    }
    return out;
}

void load_config_once() {
    std::call_once(g_config_once, [] {
        int fd = open(kConfigPath, O_RDONLY | O_CLOEXEC);
        if (fd < 0) {
            LOGW("no rdc-cloak.json (%s), using defaults", strerror(errno));
            g_gl_renderer = kDefaultGlRenderer;
            g_gl_vendor = kDefaultGlVendor;
            g_gl_version = kDefaultGlVersion;
            return;
        }
        std::string json;
        char buf[4096];
        ssize_t n;
        while ((n = read(fd, buf, sizeof(buf))) > 0) json.append(buf, static_cast<size_t>(n));
        close(fd);
        g_gl_renderer = json_string_field(json, "renderer");
        g_gl_vendor = json_string_field(json, "vendor");
        g_gl_version = json_string_field(json, "version");
        g_egl_vendor = json_string_field(json, "eglVendor");
        g_egl_version = json_string_field(json, "eglVersion");
        // Fall back to GL trio / defaults for the EGL pair, mirroring the
        // Java-side config so one file drives both layers.
        if (g_egl_vendor.empty()) g_egl_vendor = g_gl_vendor.empty() ? kDefaultGlVendor : g_gl_vendor;
        if (g_egl_version.empty()) g_egl_version = g_gl_version.empty() ? kDefaultGlVersion : g_gl_version;
        if (g_gl_renderer.empty()) g_gl_renderer = kDefaultGlRenderer;
        if (g_gl_vendor.empty()) g_gl_vendor = kDefaultGlVendor;
        if (g_gl_version.empty()) g_gl_version = kDefaultGlVersion;
        LOGI("config loaded: renderer=%s vendor=%s", g_gl_renderer.c_str(), g_gl_vendor.c_str());
    });
}

// ---------------------------------------------------------------------------
// /proc content sanitization
// ---------------------------------------------------------------------------

// /proc/self/cgroup: rewrite docker-ish segments to a systemd service slice.
// Lines look like `11:cpuset:/docker/abc123...` (v1) or `0::/docker/abc...` (v2)
// or `0::/system.slice/docker-abc.scope` when --cgroup-parent is in effect.
std::string sanitize_cgroup(const std::string &in) {
    std::string out;
    out.reserve(in.size());
    for (size_t line_start = 0; line_start < in.size();) {
        size_t line_end = in.find('\n', line_start);
        if (line_end == std::string::npos) line_end = in.size();
        std::string line = in.substr(line_start, line_end - line_start);

        size_t colon = line.find(':');
        size_t slash = line.find('/', colon == std::string::npos ? 0 : colon);
        if (colon != std::string::npos && slash != std::string::npos) {
            std::string prefix = line.substr(0, slash);
            // Drop everything after the first path segment — the fake slice
            // replaces /docker/<id>, /system.slice/docker-<id>.scope, etc.
            line = prefix + kFakeCgroupSlice;
        }
        out.append(line);
        out.push_back('\n');
        line_start = line_end + 1;
    }
    return out;
}

bool is_dockerish_mount_line(const std::string &line) {
    // Drop container rootfs and docker data paths. Keep everything else so
    // /proc/mounts still looks like a normal Android device (system, vendor,
    // /data, /proc, /sys, ...).
    if (line.find(" overlay ") != std::string::npos) return true;
    if (line.find("overlay/") != std::string::npos) return true;
    if (line.find("/docker/") != std::string::npos) return true;
    if (line.find("docker/overlay2") != std::string::npos) return true;
    return false;
}

std::string sanitize_mounts(const std::string &in) {
    std::string out;
    out.reserve(in.size());
    for (size_t line_start = 0; line_start < in.size();) {
        size_t line_end = in.find('\n', line_start);
        if (line_end == std::string::npos) line_end = in.size();
        std::string line = in.substr(line_start, line_end - line_start);
        if (!is_dockerish_mount_line(line)) {
            out.append(line);
            out.push_back('\n');
        }
        line_start = line_end + 1;
    }
    return out;
}

// Read a whole file; returns false when unreadable.
bool read_all(const char *path, std::string *out) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    char buf[8192];
    ssize_t n;
    out->clear();
    while ((n = read(fd, buf, sizeof(buf))) > 0) out->append(buf, static_cast<size_t>(n));
    close(fd);
    return true;
}

// Serve a sanitized snapshot for `proc_path` from the cache dir. First access
// per process regenerates the cache file. Returns the fd to hand to the
// caller (already rewound), or -1 on failure.
int serve_sanitized(const char *proc_path, const char *cache_name,
                    std::string (*sanitize)(const std::string &)) {
    std::string cache_path = std::string(kCloakDir) + "/" + cache_name;
    std::string content;
    if (!read_all(cache_path.c_str(), &content)) {
        std::string raw;
        if (!read_all(proc_path, &raw)) return -1;
        content = sanitize(raw);
        int wfd = open(cache_path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
        if (wfd >= 0) {
            (void)!write(wfd, content.data(), content.size());
            close(wfd);
        }
        // Falls through to the memfd path below even when the cache dir is
        // not writable (e.g. customize.sh did not run in a container) — the
        // sanitized content is still served from memory.
    }
    // Serve from an anonymous in-memory fd: the caller can read() it exactly
    // like the original proc file, and nothing touches disk per-access.
    int mem = memfd_create(cache_name, MFD_CLOEXEC);
    if (mem < 0) mem = memfd_create(cache_name, 0);
    if (mem < 0) {
        // Last resort: hand out the real file (better than crashing callers).
        int real = open(proc_path, O_RDONLY | O_CLOEXEC);
        return real;
    }
    (void)!write(mem, content.data(), content.size());
    lseek(mem, 0, SEEK_SET);
    return mem;
}

// ---------------------------------------------------------------------------
// Minimal GOT/PLT hooker (no external deps; lsplt can be substituted here).
// Walks every loaded library via dl_iterate_phdr, resolves .rel.plt/.rel.dyn
// entries whose symbol name matches, and overwrites the GOT slot.
// ---------------------------------------------------------------------------

struct HookDef {
    const char *symbol;
    void *replace;
    void **orig; // stores the original function pointer
};

struct HookCtx {
    const HookDef *hooks;
    size_t count;
    size_t applied;
};

int apply_hooks_in_lib(struct dl_phdr_info *info, size_t /*size*/, void *data) {
    auto *ctx = reinterpret_cast<HookCtx *>(data);
    const char *name = info->dlpi_name ? info->dlpi_name : "";
    if (name[0] == '\0') return 0; // main executable
    if (strstr(name, "librdc_nativecloak") != nullptr) return 0;

    // Locate PT_DYNAMIC.
    ElfW(Addr) base = info->dlpi_addr;
    const ElfW(Dyn) *dyn = nullptr;
    for (int i = 0; i < info->dlpi_phnum; ++i) {
        if (info->dlpi_phdr[i].p_type == PT_DYNAMIC) {
            dyn = reinterpret_cast<const ElfW(Dyn) *>(base + info->dlpi_phdr[i].p_vaddr);
            break;
        }
    }
    if (!dyn) return 0;

    const ElfW(Sym) *symtab = nullptr;
    const char *strtab = nullptr;
    const ElfW(Rel) *rel = nullptr;
    size_t relsz = 0;
    const ElfW(Rela) *rela = nullptr;
    size_t relasz = 0;
    for (const ElfW(Dyn) *d = dyn; d->d_tag != DT_NULL; ++d) {
        switch (d->d_tag) {
            case DT_SYMTAB: symtab = reinterpret_cast<const ElfW(Sym) *>(base + d->d_un.d_ptr); break;
            case DT_STRTAB: strtab = reinterpret_cast<const char *>(base + d->d_un.d_ptr); break;
            case DT_REL: rel = reinterpret_cast<const ElfW(Rel) *>(base + d->d_un.d_ptr); break;
            case DT_RELSZ: relsz = d->d_un.d_val; break;
            case DT_RELA: rela = reinterpret_cast<const ElfW(Rela) *>(base + d->d_un.d_ptr); break;
            case DT_RELASZ: relasz = d->d_un.d_val; break;
            default: break;
        }
    }
    if (!symtab || !strtab) return 0;

    size_t entries = 0;
    bool is_rela = rela != nullptr && relasz > 0;
    if (!is_rela && rel == nullptr) return 0;
    entries = is_rela ? relasz / sizeof(ElfW(Rela)) : relsz / sizeof(ElfW(Rel));

    for (size_t i = 0; i < entries; ++i) {
        size_t sym_idx;
        void **got;
        if (is_rela) {
            sym_idx = ELF64_R_SYM(rela[i].r_info);
            got = reinterpret_cast<void **>(base + rela[i].r_offset);
        } else {
            // 64-bit only build targets (x86_64 / arm64-v8a); DT_REL is rare
            // there but kept for completeness of the parser.
            sym_idx = ELF64_R_SYM(rel[i].r_info);
            got = reinterpret_cast<void **>(base + rel[i].r_offset);
        }
        if (sym_idx == STN_UNDEF) continue;
        const char *sym_name = strtab + symtab[sym_idx].st_name;
        for (size_t h = 0; h < ctx->count; ++h) {
            if (strcmp(sym_name, ctx->hooks[h].symbol) != 0) continue;
            // Record the original once, then redirect.
            if (ctx->hooks[h].orig != nullptr && *ctx->hooks[h].orig == nullptr) {
                *ctx->hooks[h].orig = *got;
            }
            if (*got == reinterpret_cast<void *>(ctx->hooks[h].replace)) continue;
            size_t page = static_cast<size_t>(sysconf(_SC_PAGESIZE));
            uintptr_t addr = reinterpret_cast<uintptr_t>(got);
            uintptr_t page_start = addr & ~(page - 1);
            mprotect(reinterpret_cast<void *>(page_start), page,
                     PROT_READ | PROT_WRITE);
            *got = ctx->hooks[h].replace;
            ++ctx->applied;
        }
    }
    return 0;
}

size_t apply_got_hooks(const HookDef *hooks, size_t count) {
    HookCtx ctx{hooks, count, 0};
    dl_iterate_phdr(apply_hooks_in_lib, &ctx);
    return ctx.applied;
}

// ---------------------------------------------------------------------------
// Hooked functions
// ---------------------------------------------------------------------------

int (*orig_openat)(int, const char *, int, ...);

int my_openat(int dirfd, const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    if (pathname != nullptr) {
        if (strcmp(pathname, "/proc/self/cgroup") == 0 ||
            strcmp(pathname, "/proc/cgroups") == 0) {
            int fd = serve_sanitized("/proc/self/cgroup", "cgroup", sanitize_cgroup);
            if (fd >= 0) return fd;
        } else if (strcmp(pathname, "/proc/self/mountinfo") == 0 ||
                   strcmp(pathname, "/proc/self/mounts") == 0 ||
                   strcmp(pathname, "/proc/mounts") == 0) {
            int fd = serve_sanitized("/proc/self/mountinfo", "mounts", sanitize_mounts);
            if (fd >= 0) return fd;
        }
    }
    return orig_openat(dirfd, pathname, flags, mode);
}

// GL entry points — declare the signatures directly (no full GLES headers in
// the delivery; the NDK provides them, but keeping the three typedefs here
// makes the hook self-contained).
typedef unsigned int GLenum;
typedef unsigned char GLubyte;
constexpr GLenum GL_VENDOR_ENUM = 0x1F00;
constexpr GLenum GL_RENDERER_ENUM = 0x1F01;
constexpr GLenum GL_VERSION_ENUM = 0x1F02;

const GLubyte *(*orig_glGetString)(GLenum);

const GLubyte *my_glGetString(GLenum name) {
    load_config_once();
    switch (name) {
        case GL_RENDERER_ENUM:
            return reinterpret_cast<const GLubyte *>(g_gl_renderer.c_str());
        case GL_VENDOR_ENUM:
            return reinterpret_cast<const GLubyte *>(g_gl_vendor.c_str());
        case GL_VERSION_ENUM:
            return reinterpret_cast<const GLubyte *>(g_gl_version.c_str());
        default:
            return orig_glGetString(name);
    }
}

typedef const char *(*EglQueryStringType)(void *, int);
EglQueryStringType orig_eglQueryString;

// EGL enums (subset).
constexpr int EGL_VENDOR_ENUM = 0x3053;
constexpr int EGL_VERSION_ENUM = 0x3054;
constexpr int EGL_CLIENT_APIS_ENUM = 0x308D;

const char *my_eglQueryString(void *dpy, int name) {
    load_config_once();
    switch (name) {
        case EGL_VENDOR_ENUM:
            return g_egl_vendor.c_str();
        case EGL_VERSION_ENUM:
            return g_egl_version.c_str();
        case EGL_CLIENT_APIS_ENUM:
            return "OpenGL_ES ";
        default:
            return orig_eglQueryString(dpy, name);
    }
}

} // namespace

// ---------------------------------------------------------------------------
// Zygisk module
// ---------------------------------------------------------------------------

class RdcNativeCloak : public ModuleBase {
  public:
    void onLoad(Api *api, JNIEnv *env) override {
        api_ = api;
        env_ = env;
        LOGI("loaded (api v%d)", ZYGISK_API_VERSION);
    }

    void preAppSpecialize(AppSpecializeArgs *args) override {
        // Ask Zygisk to unmount the module from this app so the module files
        // themselves are not visible (belt and braces with denylist mode).
        api_->setOption(zygisk::FORCE_DENYLIST_UNMOUNT);
        load_config_once();
        if (args != nullptr && args->nice_name != nullptr && env_ != nullptr) {
            const char *name = env_->GetStringUTFChars(args->nice_name, nullptr);
            if (name != nullptr) {
                LOGI("specializing %s (uid=%d)", name, args->uid);
                env_->ReleaseStringUTFChars(args->nice_name, name);
            }
        }
    }

    void postAppSpecialize(const AppSpecializeArgs * /*args*/) override {
        // By now libEGL/libGLESv2 are preloaded in the app process (zygote
        // preloads graphics), so their GOT entries can be patched. openat is
        // imported by virtually every client library.
        HookDef hooks[] = {
            {"openat", reinterpret_cast<void *>(my_openat),
             reinterpret_cast<void **>(&orig_openat)},
            {"glGetString", reinterpret_cast<void *>(my_glGetString),
             reinterpret_cast<void **>(&orig_glGetString)},
            {"eglQueryString", reinterpret_cast<void *>(my_eglQueryString),
             reinterpret_cast<void **>(&orig_eglQueryString)},
        };
        size_t applied = apply_got_hooks(hooks, sizeof(hooks) / sizeof(hooks[0]));
        LOGI("hooks applied: %zu", applied);
    }

  private:
    Api *api_ = nullptr;
    JNIEnv *env_ = nullptr;
};

REGISTER_ZYGISK_MODULE(RdcNativeCloak)
