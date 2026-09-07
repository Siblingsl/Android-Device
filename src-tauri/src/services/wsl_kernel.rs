//! WSL2 custom binder kernel status + switch (Windows host).
//! Build itself is offline via scripts/* (10–40 min); app only switches/applies.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::models::{ShellResult, WslKernelStatus};
use crate::services::{log, util};

const DEFAULT_KERNEL: &str = r"C:\wsl-kernel\bzImage";
const DEFAULT_CONFIG: &str = r"C:\wsl-kernel\config-wsl-binder";

pub fn default_kernel_path() -> String {
    DEFAULT_KERNEL.into()
}

/// Host OS + CPU arch for prebuilt kernel / binder strategy.
/// Returns: platform, os, arch, strategy, supported, needs_wsl, asset_bz, asset_cfg
pub fn detect_platform() -> (String, String, String, String, bool, bool, String, String) {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "unknown"
    };

    let mut arch = if cfg!(target_arch = "x86_64") {
        "x64".to_string()
    } else if cfg!(target_arch = "aarch64") {
        "arm64".to_string()
    } else {
        std::env::consts::ARCH.to_string()
    };

    // Windows: prefer machine arch (handles WoW64)
    if cfg!(target_os = "windows") {
        if let Ok(pa) = std::env::var("PROCESSOR_ARCHITEW6432").or_else(|_| {
            std::env::var("PROCESSOR_ARCHITECTURE")
        }) {
            let u = pa.to_uppercase();
            arch = if u == "AMD64" || u == "X86_64" {
                "x64".into()
            } else if u == "ARM64" || u.contains("ARM") {
                "arm64".into()
            } else {
                arch
            };
        }
    }

    let platform = format!("{os}-{arch}");
    let (strategy, supported, needs_wsl, asset_bz, asset_cfg) = match platform.as_str() {
        "windows-x64" => (
            "wsl-prebuilt-or-build",
            true,
            true,
            "wsl-kernel-binder-windows-x64-bzImage",
            "wsl-kernel-binder-windows-x64-config",
        ),
        "windows-arm64" => (
            "wsl-prebuilt-or-build",
            true,
            true,
            "wsl-kernel-binder-windows-arm64-bzImage",
            "wsl-kernel-binder-windows-arm64-config",
        ),
        "linux-x64" | "linux-arm64" => ("host-binder", true, false, "", ""),
        _ => ("unsupported", false, false, "", ""),
    };

    (
        platform,
        os.into(),
        arch,
        strategy.into(),
        supported,
        needs_wsl,
        asset_bz.into(),
        asset_cfg.into(),
    )
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn wslconfig_path() -> PathBuf {
    home_dir().join(".wslconfig")
}

fn scripts_dir() -> Option<PathBuf> {
    // Dev runs the binary with cwd = src-tauri, so walk up from cwd and the
    // exe dir to find <repo>/scripts; packaged installs keep exe-adjacent.
    let mut candidates: Vec<PathBuf> = crate::services::docker::project_root_dirs()
        .iter()
        .map(|r| r.join("scripts"))
        .collect();
    if let Some(exe_parent) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(exe_parent.join("scripts"));
    }
    for c in candidates {
        if c.join("switch-wsl-kernel.ps1").is_file() || c.join("build-wsl-binder-kernel.sh").is_file()
        {
            return Some(c);
        }
    }
    None
}

fn file_exists(p: &str) -> bool {
    Path::new(p).is_file()
}

fn file_size(p: &str) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Parse `kernel=` from .wslconfig (active, non-commented).
fn read_configured_kernel() -> Option<String> {
    let path = wslconfig_path();
    let content = fs::read_to_string(&path).ok()?;
    let mut in_wsl2 = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_wsl2 = t.eq_ignore_ascii_case("[wsl2]");
            continue;
        }
        if !in_wsl2 || t.starts_with('#') {
            continue;
        }
        if let Some(rest) = t.strip_prefix("kernel=") {
            let v = rest.trim().trim_matches('"').replace("\\\\", "\\");
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn wsl_available() -> bool {
    let r = util::run_command_timeout("wsl", &["--status"], Duration::from_secs(4));
    r.success || r.exit_code == 0 || !r.stderr.to_lowercase().contains("not recognized")
}

fn wsl_run(args: &[&str], timeout: Duration) -> ShellResult {
    util::run_command_timeout("wsl", args, timeout)
}

fn probe_live_kernel() -> (String, bool, bool, bool, bool) {
    // uname, binder, tun, bridge_netfilter, iso9660 — best-effort via default distro
    let script = r#"
uname -r
zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_ANDROID_BINDER_IPC=|^CONFIG_TUN=|^CONFIG_BRIDGE_NETFILTER=|^CONFIG_ISO9660_FS=' || true
test -d /proc/sys/net/bridge && echo BRIDGE_SYSCTL=1 || echo BRIDGE_SYSCTL=0
"#;
    let r = wsl_run(&["-e", "bash", "-lc", script], Duration::from_secs(12));
    let out = format!("{}\n{}", r.stdout, r.stderr);
    let mut version = String::new();
    for line in out.lines() {
        let t = line.trim();
        if !t.is_empty() && !t.contains('=') && version.is_empty() {
            version = t.to_string();
            break;
        }
    }
    let binder = out.contains("CONFIG_ANDROID_BINDER_IPC=y");
    let tun = out.contains("CONFIG_TUN=y");
    let bridge = out.contains("CONFIG_BRIDGE_NETFILTER=y") || out.contains("BRIDGE_SYSCTL=1");
    let iso = out.contains("CONFIG_ISO9660_FS=y");
    (version, binder, tun, bridge, iso)
}

fn mode_from_config(configured: &Option<String>, custom_path: &str) -> String {
    match configured {
        Some(p) => {
            let a = p.replace('/', "\\").to_lowercase();
            let b = custom_path.replace('/', "\\").to_lowercase();
            if a == b || a.ends_with("bzimage") && file_exists(p) {
                "custom".into()
            } else {
                "custom".into() // any explicit kernel= counts as custom
            }
        }
        None => "default".into(),
    }
}

pub fn status() -> WslKernelStatus {
    let (platform, os, arch, strategy, plat_ok, needs_wsl, asset_bz, asset_cfg) = detect_platform();
    let custom_path = default_kernel_path();
    let custom_exists = file_exists(&custom_path);
    let configured = read_configured_kernel();
    let mode = mode_from_config(&configured, &custom_path);
    let wsl_ok = if os == "windows" {
        wsl_available()
    } else {
        false
    };

    let mut st = WslKernelStatus {
        wsl_available: wsl_ok,
        mode: mode.clone(),
        configured_kernel: configured.clone().unwrap_or_default(),
        custom_kernel_path: custom_path.clone(),
        custom_kernel_exists: custom_exists,
        custom_kernel_size: if custom_exists {
            file_size(&custom_path)
        } else {
            0
        },
        config_snapshot_exists: file_exists(DEFAULT_CONFIG),
        live_kernel_version: String::new(),
        binder_enabled: false,
        docker_ready_hints: vec![],
        message: String::new(),
        scripts_dir: scripts_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        platform: platform.clone(),
        os: os.clone(),
        arch: arch.clone(),
        strategy: strategy.clone(),
        platform_supported: plat_ok,
        needs_wsl_kernel: needs_wsl,
        release_asset_bz_image: asset_bz,
        release_asset_config: asset_cfg,
    };

    if !plat_ok {
        st.message = format!("当前平台 {platform} 不在支持列表（仅 Windows/Linux × x64/arm64）");
        st.docker_ready_hints
            .push("macOS 与其它架构未提供 Redroid/WSL 内核方案".into());
        return st;
    }

    // Linux: host binder, not WSL bzImage
    if strategy == "host-binder" {
        st.mode = "host".into();
        let (ver, binder, _, _, _) = probe_live_kernel_linux_or_wsl();
        st.live_kernel_version = ver;
        st.binder_enabled = binder;
        if binder {
            st.message = format!("Linux {arch}：主机 binder 可用，无需 WSL 内核");
        } else {
            st.message = format!("Linux {arch}：未检测到 binder，请运行 scripts/setup-linux-binder.sh");
            st.docker_ready_hints.push(
                "Linux 不要安装 Windows 的 bzImage；在主机加载 binder_linux 或启用内核选项".into(),
            );
        }
        return st;
    }

    // Windows + WSL path
    if !wsl_ok {
        st.message = "未检测到 WSL，请先安装 Windows Subsystem for Linux".into();
        return st;
    }

    let (ver, binder, tun, bridge, iso) = probe_live_kernel();
    st.live_kernel_version = ver;
    st.binder_enabled = binder;

    st.docker_ready_hints.push(format!(
        "本机架构 {platform}；预编译资源名：{}",
        if st.release_asset_bz_image.is_empty() {
            "(无)".into()
        } else {
            st.release_asset_bz_image.clone()
        }
    ));

    if !custom_exists {
        st.docker_ready_hints.push(
            "无本地内核：请用 scripts/install-wsl-kernel.ps1 安装预编译，或准备 C:\\wsl-kernel\\bzImage".into(),
        );
    }
    if mode == "default" && custom_exists {
        st.docker_ready_hints
            .push("已有 binder 内核镜像，但当前使用微软默认内核；运行 Redroid 前请切换到自定义内核".into());
    }
    if mode == "custom" && !binder && !st.live_kernel_version.is_empty() {
        st.docker_ready_hints
            .push("已配置自定义内核，但当前运行内核未启用 binder — 请执行「仅重启 WSL」".into());
    }
    if binder && !tun {
        st.docker_ready_hints
            .push("缺少 CONFIG_TUN=y，Docker Desktop 可能无法初始化 TAP".into());
    }
    if binder && !bridge {
        st.docker_ready_hints
            .push("缺少 BRIDGE_NETFILTER，Docker 可能报 bridge-nf-call-iptables".into());
    }
    if binder && !iso {
        st.docker_ready_hints
            .push("缺少 CONFIG_ISO9660_FS=y，Docker 可能报 unknown filesystem type iso9660".into());
    }
    if arch == "arm64" && custom_exists {
        st.docker_ready_hints
            .push("Windows ARM64 必须使用 arm64 版 bzImage，不能用 x64 预编译".into());
    }
    if binder && tun && bridge {
        st.message = format!("自定义 binder 内核已生效（{platform}），可用于 Redroid");
    } else if mode == "custom" && custom_exists {
        st.message = "已切换到自定义内核配置，重启 WSL 后生效".into();
    } else if mode == "default" {
        st.message = "当前为微软默认 WSL 内核（无 binder，Redroid 不可用）".into();
    } else {
        st.message = "内核状态未知".into();
    }

    st
}

fn probe_live_kernel_linux_or_wsl() -> (String, bool, bool, bool, bool) {
    #[cfg(target_os = "windows")]
    {
        return probe_live_kernel();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let script = r#"
uname -r
zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_ANDROID_BINDER_IPC=' || true
grep binder /proc/filesystems 2>/dev/null && echo BINDERFS=1 || true
"#;
        let r = util::run_command_timeout("bash", &["-lc", script], Duration::from_secs(8));
        let out = format!("{}\n{}", r.stdout, r.stderr);
        let mut version = String::new();
        for line in out.lines() {
            let t = line.trim();
            if !t.is_empty() && !t.contains('=') && version.is_empty() {
                version = t.to_string();
                break;
            }
        }
        let binder = out.contains("CONFIG_ANDROID_BINDER_IPC=y") || out.contains("BINDERFS=1");
        (version, binder, false, false, false)
    }
}

/// mode: "custom" | "default"
pub fn switch_kernel(mode: &str, apply: bool) -> ShellResult {
    let mode = mode.trim().to_lowercase();
    if mode != "custom" && mode != "default" {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "mode must be custom or default".into(),
            exit_code: -1,
        };
    }

    if mode == "custom" && !file_exists(DEFAULT_KERNEL) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!(
                "自定义内核不存在: {}\n请先一键编译 (scripts/setup-wsl-binder-oneclick.ps1)",
                DEFAULT_KERNEL
            ),
            exit_code: -1,
        };
    }

    // Prefer project PowerShell script for robust .wslconfig editing
    if let Some(dir) = scripts_dir() {
        let ps1 = dir.join("switch-wsl-kernel.ps1");
        if ps1.is_file() {
            let mut args = vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                ps1.to_string_lossy().into_owned(),
                "-Mode".into(),
                mode.clone(),
                "-KernelPath".into(),
                DEFAULT_KERNEL.into(),
            ];
            if apply {
                args.push("-Apply".into());
            }
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let r = util::run_command_timeout("powershell", &arg_refs, Duration::from_secs(60));
            log::info(
                "WSL-Kernel",
                &format!("switch mode={mode} apply={apply} ok={}", r.success),
            );
            return r;
        }
    }

    // Fallback: edit .wslconfig in Rust
    match write_wslconfig_mode(&mode) {
        Ok(msg) => {
            let mut out = msg;
            if apply {
                let shut = apply_shutdown();
                out = format!("{out}\n{}", shut.stdout);
                if !shut.success && !shut.stderr.is_empty() {
                    return ShellResult {
                        success: false,
                        stdout: out,
                        stderr: shut.stderr,
                        exit_code: shut.exit_code,
                    };
                }
            }
            ShellResult {
                success: true,
                stdout: out,
                stderr: String::new(),
                exit_code: 0,
            }
        }
        Err(e) => ShellResult {
            success: false,
            stdout: String::new(),
            stderr: e,
            exit_code: -1,
        },
    }
}

fn write_wslconfig_mode(mode: &str) -> Result<String, String> {
    let path = wslconfig_path();
    let original = fs::read_to_string(&path).unwrap_or_default();
    if path.exists() {
        let bak = path.with_extension(format!(
            "bak-rdc-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        let _ = fs::copy(&path, &bak);
    }

    let kernel_line = format!(
        "kernel={}",
        DEFAULT_KERNEL.replace('\\', r"\\")
    );

    let mut out: Vec<String> = Vec::new();
    let mut in_wsl2 = false;
    let mut wsl2_seen = false;
    let mut kernel_written = false;

    for line in original.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            if in_wsl2 && !kernel_written && mode == "custom" {
                out.push(kernel_line.clone());
                kernel_written = true;
            }
            in_wsl2 = t.eq_ignore_ascii_case("[wsl2]");
            if in_wsl2 {
                wsl2_seen = true;
            }
            out.push(line.to_string());
            continue;
        }
        if in_wsl2 && t.trim_start_matches('#').trim().starts_with("kernel=") {
            if mode == "custom" {
                out.push(kernel_line.clone());
                kernel_written = true;
            } else if !t.starts_with('#') {
                out.push(format!("# {t}"));
            } else {
                out.push(line.to_string());
            }
            continue;
        }
        out.push(line.to_string());
    }

    if in_wsl2 && !kernel_written && mode == "custom" {
        out.push(kernel_line.clone());
    }
    if !wsl2_seen {
        if out.last().map(|s| !s.is_empty()).unwrap_or(false) {
            out.push(String::new());
        }
        out.push("[wsl2]".into());
        if mode == "custom" {
            out.push(kernel_line);
        } else {
            out.push("# kernel= (Microsoft default)".into());
        }
    }

    fs::write(&path, out.join("\r\n") + "\r\n").map_err(|e| e.to_string())?;
    Ok(format!("Wrote {} (mode={mode})", path.display()))
}

pub fn apply_shutdown() -> ShellResult {
    log::info("WSL-Kernel", "wsl --shutdown");
    util::run_command_timeout("wsl", &["--shutdown"], Duration::from_secs(30))
}

pub fn verify_binder() -> ShellResult {
    let (_, os, _, strategy, _, _, _, _) = detect_platform();
    let script = r#"
echo "kernel: $(uname -r)"
echo "--- config ---"
zcat /proc/config.gz 2>/dev/null | grep -E 'CONFIG_ANDROID|BINDER|CONFIG_TUN=|CONFIG_ISO9660|CONFIG_BRIDGE_NETFILTER|CONFIG_IP_NF_TARGET_REJECT|CONFIG_IP_NF_IPTABLES_LEGACY' || echo "(no /proc/config.gz)"
echo "--- binderfs ---"
grep binder /proc/filesystems 2>/dev/null || echo "(no binder in filesystems)"
ls -la /dev/binder* 2>/dev/null || true
ls -la /dev/binderfs 2>/dev/null || true
echo "--- bridge sysctl ---"
ls /proc/sys/net/bridge 2>/dev/null || echo "(no /proc/sys/net/bridge)"
"#;
    if os == "windows" {
        wsl_run(&["-e", "bash", "-lc", script], Duration::from_secs(15))
    } else if strategy == "host-binder" {
        util::run_command_timeout("bash", &["-lc", script], Duration::from_secs(15))
    } else {
        ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("verify not supported on {os}"),
            exit_code: -1,
        }
    }
}


