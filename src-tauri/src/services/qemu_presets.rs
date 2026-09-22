//! Host orchestration of node-local image builds and reversible upgrades.
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::models::{CreateInstanceRequest, RuntimeMetrics};
use crate::services::{adb, cloak, preset, qemu, spoof, traces, util};
use base64::Engine;
use qemu::{QemuCliOutput, QemuRedroidCreateRequest, QemuRedroidInstance, QemuVmEntry};
use serde_json::{json, Value};

static OPERATIONS: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
const GUEST_CORE_ROOT: &str = "/run/rdc-presets";
/// The create workflow consumes three server-side one-time grants. The third
/// grant is consumed by the guest authorization preflight; qemu-center then
/// verifies its signed receipt and records a separate host-side one-time use
/// before Docker creation.
pub const QEMU_CREATE_EXECUTION_GRANT_COUNT: usize = 3;
pub const QEMU_UPGRADE_EXECUTION_GRANT_COUNT: usize = 2;
const BUILT_AUTH_RELEASE_URL: Option<&str> = option_env!("RDC_AUTH_EXECUTION_RELEASE_URL");
const BUILT_AUTH_PUBLIC_KEYS: Option<&str> = option_env!("RDC_AUTH_PUBLIC_KEYS");
const RENDERED_LOADER_SOURCE: &str = include_str!(concat!(env!("OUT_DIR"), "/qemu_loader.py"));

fn render_loader_source() -> Result<String, String> {
    let release_url = BUILT_AUTH_RELEASE_URL
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "发布版未配置 RDC_AUTH_EXECUTION_RELEASE_URL，受保护 QEMU 操作已禁用".to_string()
        })?;
    let public_keys = BUILT_AUTH_PUBLIC_KEYS
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "发布版未配置 RDC_AUTH_PUBLIC_KEYS，受保护 QEMU 操作已禁用".to_string())?;
    if [release_url, public_keys]
        .iter()
        .any(|value| value.contains(['\0', '\r', '\n', '"']))
    {
        return Err("受保护 QEMU loader 配置包含非法字符".into());
    }
    if RENDERED_LOADER_SOURCE.contains("__RDC_") {
        return Err("发布版 qemu loader 配置未完成渲染，受保护 QEMU 操作已禁用".into());
    }
    Ok(RENDERED_LOADER_SOURCE.to_owned())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 24
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate(req: &QemuRedroidCreateRequest, upgrade: bool) -> Result<(), String> {
    if !valid_name(&req.vm) || !valid_name(&req.name) {
        return Err("节点/实例名称无效".into());
    }
    if !matches!(req.profile.trim(), "" | "lean" | "standard" | "full") {
        return Err("资源 profile 必须是 lean、standard 或 full".into());
    }
    let base = req
        .image
        .as_deref()
        .filter(|image| !image.trim().is_empty())
        .ok_or("受保护 QEMU 预设必须提供带 SHA-256 digest 的基础镜像")?;
    preset::validate_immutable_image(base)?;
    if !upgrade
        && (!req.cpus.is_finite()
            || req.cpus <= 0.0
            || req.memory_mib < 512
            || req.width == 0
            || req.height == 0
            || req.dpi == 0)
    {
        return Err("CPU、内存、分辨率和 DPI 必须是有效的正数（内存至少 512 MiB）".into());
    }
    let profile = req.spoof_profile_id.as_deref().unwrap_or("");
    if !req.install_magisk
        && (req.install_lsposed
            || req.install_shamiko
            || req.install_cloak
            || req.install_native_cloak
            || !req.module_zips.is_empty()
            || !profile.is_empty()
            || !req.spoof_profile.trim().is_empty()
            || req.spoof_abilist
            || !req.hide_packages.is_empty()
            || req.clean_traces)
    {
        return Err("模块、设备档案和高级伪装需要 Magisk + Zygisk".into());
    }
    if req.install_cloak && !req.install_lsposed {
        return Err("DeviceCloak 需要 LSPosed".into());
    }
    if req.clean_traces && profile.is_empty() {
        return Err("环境痕迹配置需要选择设备档案".into());
    }
    for package in &req.hide_packages {
        if package.is_empty()
            || !package
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$'))
        {
            return Err(format!("目标包名无效: {package}"));
        }
    }
    Ok(())
}

/// Optional images, modules and identity overlays are protected product
/// inputs. The Tauri preset commands protect the whole runner because the
/// runner itself is the core product surface; this helper remains useful for
/// policy/UI classification and tests.
pub fn requires_protected_authorization(req: &QemuRedroidCreateRequest) -> bool {
    req.install_gapps
        || req.install_magisk
        || req.install_lsposed
        || req.install_shamiko
        || req.install_cloak
        || req.install_native_cloak
        || !req.module_zips.is_empty()
        || req
            .spoof_profile_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
        || !req.spoof_profile.trim().is_empty()
        || req.spoof_abilist
        || !req.hide_packages.is_empty()
        || req.clean_traces
}

struct Guest {
    node: QemuVmEntry,
    state: PathBuf,
}
impl Guest {
    fn new(vm: &str) -> Result<Self, String> {
        let node = qemu::vm_list()?
            .into_iter()
            .find(|v| v.name == vm)
            .ok_or_else(|| format!("节点不存在: {vm}"))?;
        Ok(Self {
            node,
            state: qemu::default_portable_state_dir(),
        })
    }
    fn options(&self, scp: bool) -> Vec<String> {
        vec![
            if scp { "-P" } else { "-p" }.into(),
            self.node.ssh_host_port.to_string(),
            "-i".into(),
            self.state
                .join("keys")
                .join(format!("{}_ed25519", self.node.name))
                .to_string_lossy()
                .into_owned(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "StrictHostKeyChecking=accept-new".into(),
            "-o".into(),
            format!(
                "UserKnownHostsFile={}",
                self.state
                    .join("vms")
                    .join(&self.node.name)
                    .join("known_hosts")
                    .display()
            ),
            "-o".into(),
            "ConnectTimeout=8".into(),
        ]
    }
    fn ssh(&self, script: &str, seconds: u64) -> QemuCliOutput {
        let mut args = self.options(false);
        args.extend(["rdc@127.0.0.1".into(), script.into()]);
        output(util::run_command_timeout(
            "ssh",
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            Duration::from_secs(seconds),
        ))
    }
    fn copy(&self, local: &Path, remote: &str) -> Result<(), String> {
        let mut args = self.options(true);
        args.extend([
            local.to_string_lossy().into_owned(),
            format!("rdc@127.0.0.1:{remote}"),
        ]);
        require(output(util::run_command_timeout(
            "scp",
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            Duration::from_secs(600),
        )))?;
        Ok(())
    }
    fn protected_runner(&self, work: &str, request: &Value, seconds: u64) -> QemuCliOutput {
        self.runner_with("qemu_loader.py", work, request, seconds)
    }
    fn runner_with(
        &self,
        program: &str,
        work: &str,
        request: &Value,
        seconds: u64,
    ) -> QemuCliOutput {
        let encoded = base64::engine::general_purpose::STANDARD.encode(request.to_string());
        self.ssh(
            &format!(
                "printf %s {} | base64 -d > {}/request.json && sudo python3 {}/{} {}/request.json",
                quote(&encoded),
                quote(work),
                quote(work),
                quote(program),
                quote(work)
            ),
            seconds,
        )
    }
    fn upload_loader(&self, local: &Path, remote: &str) -> Result<(), String> {
        std::fs::write(local.join("qemu_loader.py"), render_loader_source()?)
            .map_err(|e| format!("受保护 loader 无法准备: {e}"))?;
        self.upload_directory(local, remote)
    }
    fn upload_directory(&self, local: &Path, remote: &str) -> Result<(), String> {
        let archive = local.with_extension("tar");
        let result = (|| {
            require(output(util::run_command_timeout(
                "tar",
                &[
                    "-cf",
                    &archive.to_string_lossy(),
                    "-C",
                    &local.to_string_lossy(),
                    ".",
                ],
                Duration::from_secs(300),
            )))?;
            require(self.ssh(
                &format!(
                    "sudo -n install -d -o rdc -g rdc -m 700 {}",
                    quote(GUEST_CORE_ROOT)
                ),
                30,
            ))?;
            require(self.ssh(&format!("mkdir -p {}", quote(remote)), 30))?;
            self.copy(&archive, &format!("{remote}/bundle.tar"))?;
            require(self.ssh(
                &format!(
                    "tar -xf {0}/bundle.tar -C {0} && rm {0}/bundle.tar",
                    quote(remote)
                ),
                180,
            ))?;
            Ok(())
        })();
        let cleanup = match std::fs::remove_file(&archive) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("受保护上传归档清理失败: {error}")),
        };
        match (result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
            (Err(error), Err(cleanup_error)) => {
                Err(format!("{error}\n{cleanup_error}"))
            }
        }
    }
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
fn output(r: crate::models::ShellResult) -> QemuCliOutput {
    QemuCliOutput {
        success: r.success,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
    }
}
fn require(r: QemuCliOutput) -> Result<QemuCliOutput, String> {
    if r.success {
        Ok(r)
    } else {
        Err(format!("{}\n{}", r.stdout, r.stderr).trim().into())
    }
}

fn merge_cleanup_result(
    result: Result<QemuCliOutput, String>,
    cleanup: Result<(), String>,
) -> Result<QemuCliOutput, String> {
    match (result, cleanup) {
        (Ok(output), Ok(())) => Ok(output),
        (Ok(mut output), Err(cleanup_error)) => {
            output.success = false;
            output.exit_code = 1;
            let message = format!("受保护文件清理失败: {cleanup_error}");
            if output.stderr.is_empty() {
                output.stderr = message;
            } else {
                output.stderr = format!("{}\n{message}", output.stderr);
            }
            Ok(output)
        }
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => {
            Err(format!("{error}\n受保护文件清理失败: {cleanup_error}"))
        }
    }
}

fn cleanup_protected_artifacts(
    guest: &Guest,
    work: &Path,
    remote: &str,
    remote_files: &[&str],
    timeout_secs: u64,
    remove_work_dir: bool,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for file in ["qemu_loader.py", "qemu_guest.py", "execution-grant.json"] {
        match std::fs::remove_file(work.join(file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("本地 {file}: {error}")),
        }
    }
    if remove_work_dir {
        match std::fs::remove_dir_all(work) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("本地工作目录: {error}")),
        }
    }

    let remote_paths = remote_files
        .iter()
        .map(|file| quote(&format!("{remote}/{file}")))
        .collect::<Vec<_>>()
        .join(" ");
    let remote_cleanup = guest.ssh(&format!("rm -f {remote_paths}"), timeout_secs);
    if !remote_cleanup.success {
        failures.push(format!(
            "远端保护文件: {}",
            format!("{}\n{}", remote_cleanup.stdout, remote_cleanup.stderr).trim()
        ));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn attach_execution_grant(request: &mut Value, grant: Option<Value>) -> Result<(), String> {
    let Some(grant) = grant else {
        return Ok(());
    };
    if !grant.is_object() {
        return Err("执行票据格式无效".into());
    }
    request["executionGrant"] = grant;
    Ok(())
}

fn attach_next_workflow_grant(
    request: &mut Value,
    pending: &mut Option<std::vec::IntoIter<Value>>,
) -> Result<(), String> {
    let Some(pending) = pending else {
        return Ok(());
    };
    let grant = pending.next().ok_or("受保护工作流缺少下一阶段执行票据")?;
    attach_execution_grant(request, Some(grant))
}

fn ensure_no_pending_workflow_grants(
    pending: &mut Option<std::vec::IntoIter<Value>>,
) -> Result<(), String> {
    if pending
        .as_mut()
        .is_some_and(|grants| grants.next().is_some())
    {
        return Err("受保护工作流包含未使用的执行票据".into());
    }
    Ok(())
}

fn stage_execution_grant(path: &Path, grant: &Value) -> Result<(), String> {
    if !grant.is_object() {
        return Err("执行票据格式无效".into());
    }
    let bytes = serde_json::to_vec(grant).map_err(|error| format!("执行票据无法编码: {error}"))?;
    if bytes.len() > 64 * 1024 {
        return Err("执行票据过大".into());
    }
    std::fs::write(path, bytes).map_err(|error| format!("执行票据无法暂存: {error}"))
}

fn context_hash(root: &Path, base: &str) -> Result<String, String> {
    fn walk(path: &Path, relative: &str, h: &mut DefaultHasher) -> std::io::Result<()> {
        let mut files = std::fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        files.sort_by_key(|f| f.file_name());
        for entry in files {
            let name = format!("{relative}/{}", entry.file_name().to_string_lossy());
            h.write(name.as_bytes());
            if entry.file_type()?.is_dir() {
                walk(&entry.path(), &name, h)?;
            } else {
                let mut file = std::fs::File::open(entry.path())?;
                let mut buf = [0u8; 65536];
                loop {
                    let n = file.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    h.write(&buf[..n]);
                }
            }
        }
        Ok(())
    }
    let mut hasher = DefaultHasher::new();
    hasher.write(base.as_bytes());
    walk(root, "", &mut hasher).map_err(|e| e.to_string())?;
    Ok(format!("{:016x}", hasher.finish()))
}

fn module_id(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("模块文件无法打开 {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut props = String::new();
    archive
        .by_name("module.prop")
        .map_err(|_| format!("模块缺少 module.prop: {}", path.display()))?
        .take(65536)
        .read_to_string(&mut props)
        .map_err(|e| e.to_string())?;
    let id = props
        .lines()
        .find_map(|l| l.trim().strip_prefix("id="))
        .unwrap_or("")
        .trim();
    if id.is_empty()
        || id.len() > 100
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        || id == "."
        || id == ".."
    {
        return Err(format!("模块 ID 无效: {}", path.display()));
    }
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.enclosed_name().is_none() || entry.name().contains('\\') {
            return Err("模块 zip 含不安全路径".into());
        }
    }
    Ok(id.into())
}

fn prepare(
    req: &QemuRedroidCreateRequest,
    base: &str,
    version: &str,
    work: &Path,
) -> Result<Value, String> {
    let create: CreateInstanceRequest = serde_json::from_value(json!({
        "name": req.name, "androidVersion": version, "cpu": req.cpus.to_string(), "ram": req.memory_mib.to_string(),
        "resolution": format!("{}x{}", req.width, req.height), "dpi": req.dpi.to_string(), "adbPort": 0, "scrcpyPort": 0,
        "image": base, "installGapps": req.install_gapps, "gappsZip": req.gapps_zip,
        "installMagisk": req.install_magisk, "installLsposed": req.install_lsposed, "installShamiko": req.install_shamiko,
        "spoofProfile": req.spoof_profile, "spoofProfileId": req.spoof_profile_id, "spoofAbilist": req.spoof_abilist
    })).map_err(|e| e.to_string())?;
    preset::prepare(&create, base, work)?;
    // Extracted source is not part of a build context (the overlay is already copied).
    let extracted = work.join("extract");
    if extracted.is_dir() {
        std::fs::remove_dir_all(&extracted).map_err(|e| e.to_string())?;
    }
    let mut additional: Vec<PathBuf> = req.module_zips.iter().map(PathBuf::from).collect();
    if req.install_native_cloak {
        additional.push(if req.native_cloak_zip.trim().is_empty() {
            cloak::native_cloak_zip_path()
        } else {
            PathBuf::from(&req.native_cloak_zip)
        });
    }
    let modules = work.join("modules");
    if !additional.is_empty() {
        std::fs::create_dir_all(&modules).map_err(|e| e.to_string())?;
    }
    for (i, path) in additional.iter().enumerate() {
        module_id(path)?;
        std::fs::copy(path, modules.join(format!("extra-{i}.zip"))).map_err(|e| e.to_string())?;
    }
    let mut ids = Vec::new();
    if modules.is_dir() {
        for entry in std::fs::read_dir(&modules).map_err(|e| e.to_string())? {
            ids.push(module_id(&entry.map_err(|e| e.to_string())?.path())?);
        }
        ids.sort();
        if ids.windows(2).any(|p| p[0] == p[1]) {
            return Err("所选模块存在重复 ID".into());
        }
    }
    let profile = req
        .spoof_profile_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| spoof::profile_by_id(id).ok_or_else(|| format!("设备档案不存在: {id}")))
        .transpose()?;
    if req.install_cloak {
        let apk = cloak::cloak_module_apk_path();
        std::fs::copy(&apk, work.join("DeviceCloak.apk"))
            .map_err(|e| format!("缺少 DeviceCloak APK {}: {e}", apk.display()))?;
    }
    let mut expected = json!({});
    if let Some(profile) = &profile {
        std::fs::write(work.join("cloak.json"), cloak::render_cloak_config(profile))
            .map_err(|e| e.to_string())?;
        expected = json!({"ro.product.model": profile.model, "ro.product.brand": profile.brand});
        if req.clean_traces {
            let dir = work.join("traces");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("cpuinfo"), traces::fake_cpuinfo_for(profile))
                .map_err(|e| e.to_string())?;
            std::fs::write(dir.join("version"), traces::fake_version_for(profile))
                .map_err(|e| e.to_string())?;
        }
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let key = home
        .and_then(|p| std::fs::read_to_string(p.join(".android/adbkey.pub")).ok())
        .unwrap_or_default();
    if req.install_magisk && key.trim().is_empty() {
        return Err("未找到宿主 ADB 公钥，请先使用设备中心连接一次设备".into());
    }
    Ok(
        json!({"name": req.name, "androidVersion": version, "baseImage": base,
              "resourceProfile": if req.profile.trim().is_empty() { "standard" } else { req.profile.trim() },
              "installGapps": req.install_gapps, "installMagisk": req.install_magisk,
              "installLsposed": req.install_lsposed, "installCloak": req.install_cloak,
              "cleanTraces": req.clean_traces, "moduleIds": ids, "hidePackages": req.hide_packages,
              "expectedProps": expected, "adbPubkey": key.lines().next().unwrap_or("")}),
    )
}

pub fn apply_with_grants(
    req: QemuRedroidCreateRequest,
    upgrade: bool,
    execution_grants: Vec<Value>,
) -> Result<QemuCliOutput, String> {
    let _operation = OPERATIONS
        .try_lock()
        .ok_or("已有节点操作正在运行，请等待完成")?;
    validate(&req, upgrade)?;
    let guest = Guest::new(&req.vm)?;
    if upgrade
        && !guest
            .node
            .adb_assignments
            .iter()
            .any(|a| a.instance == req.name)
    {
        return Err("实例未注册".into());
    }
    if !upgrade
        && guest
            .node
            .adb_assignments
            .iter()
            .any(|a| a.instance == req.name)
    {
        return Err("实例名称已存在".into());
    }
    let version = req
        .android_version
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("14");
    let base = req
        .image
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or("受保护 QEMU 预设必须提供带 SHA-256 digest 的基础镜像")?;
    let work = qemu::default_portable_state_dir()
        .join("presets")
        .join(format!("job-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let remote = format!(
        "{GUEST_CORE_ROOT}/{}",
        work.file_name().unwrap().to_string_lossy()
    );
    let mut pending_grants = Some(execution_grants.into_iter());
    let result = (|| {
        let mut request = prepare(&req, base, version, &work)?;
        let tag = format!("qc-preset:{}", context_hash(&work, base)?);
        guest.upload_loader(&work, &remote)?;
        request["vm"] = json!(req.vm);
        request["executionInstance"] = json!(req.name);
        attach_next_workflow_grant(&mut request, &mut pending_grants)?;
        request["context"] = json!(remote);
        request["image"] = json!(tag);
        request["action"] = json!("build");
        let built = require(guest.protected_runner(&remote, &request, 1500))?;
        let mut stdout = built.stdout;
        if upgrade {
            attach_next_workflow_grant(&mut request, &mut pending_grants)?;
            request["action"] = json!("upgrade");
            let mut result = guest.protected_runner(&remote, &request, 1500);
            result.stdout = format!("{stdout}\n{}", result.stdout);
            return Ok(result);
        }
        attach_next_workflow_grant(&mut request, &mut pending_grants)?;
        request["action"] = json!("seed");
        require(guest.protected_runner(&remote, &request, 90))?;
        let mut create = req.clone();
        create.image = Some(tag);
        // Consume the activation grant in the guest before the host-side CLI
        // creates the container. The marker binds that online preflight to the
        // exact grant and per-operation staging directory.
        attach_next_workflow_grant(&mut request, &mut pending_grants)?;
        ensure_no_pending_workflow_grants(&mut pending_grants)?;
        let authorization_file = format!("{remote}/execution-authorized");
        request["executionAuthorizationPath"] = json!(authorization_file);
        request["action"] = json!("authorize");
        let authorized = require(guest.protected_runner(&remote, &request, 180))?;
        stdout.push_str(&format!("\n{}", authorized.stdout));
        request["action"] = json!("activate");
        let grant_file = work.join("execution-grant.json");
        stage_execution_grant(&grant_file, &request["executionGrant"])?;
        let mut args = qemu::args_redroid_create_with_grant_file(
            &create,
            &grant_file,
            Path::new(&authorization_file),
        );
        if req.clean_traces {
            for (file, target) in [("cpuinfo", "/proc/cpuinfo"), ("version", "/proc/version")] {
                args.extend([
                    "--bind".into(),
                    format!("{remote}/traces/{file}:{target}:ro"),
                ]);
            }
            args.extend(["--cgroup-parent".into(), "system.slice".into()]);
        }
        let created = qemu::run_cli(&args, Duration::from_secs(240))?;
        stdout.push_str(&format!("\n{}", created.stdout));
        if !created.success {
            return Ok(QemuCliOutput { stdout, ..created });
        }
        let mut activated = guest.protected_runner(&remote, &request, 900);
        activated.stdout = format!("{stdout}\n{}", activated.stdout);
        if activated.success {
            let serial = qemu::adb_list()?
                .into_iter()
                .find(|m| m.vm == req.vm && m.instance == req.name)
                .map(|m| m.serial)
                .unwrap_or_default();
            let ready = adb::wait_ready(&serial, Duration::from_secs(60));
            if !ready.success {
                activated.success = false;
                activated.exit_code = 1;
                activated.stderr =
                    format!("Android 预装完成，但宿主 ADB 尚未就绪: {}", ready.stderr);
            }
        }
        Ok(activated)
    })();
    // The runner is a protected plaintext artifact. Remove it from both the
    // local staging directory and the guest cache on every result path. Keep
    // other failed preparation material for diagnostics, but never keep the
    // core runner itself. Cleanup failure is part of the operation result.
    let cleanup = cleanup_protected_artifacts(
        &guest,
        &work,
        &remote,
        &[
            "qemu_loader.py",
            "qemu_guest.py",
            "request.json",
            "execution-authorized",
        ],
        60,
        result.as_ref().is_ok_and(|o| o.success),
    );
    merge_cleanup_result(result, cleanup)
}

pub fn restore_with_grant(
    vm: &str,
    name: &str,
    execution_grant: Value,
) -> Result<QemuCliOutput, String> {
    let _operation = OPERATIONS
        .try_lock()
        .ok_or("已有节点操作正在运行，请等待完成")?;
    if !valid_name(vm) || !valid_name(name) {
        return Err("节点/实例名称无效".into());
    }
    let guest = Guest::new(vm)?;
    let work = qemu::default_portable_state_dir()
        .join("presets")
        .join(format!("restore-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let remote = format!(
        "{GUEST_CORE_ROOT}/{}",
        work.file_name().unwrap().to_string_lossy()
    );
    let result = (|| {
        guest.upload_loader(&work, &remote)?;
        let mut request = json!({"action":"restore","name":name,"vm":vm,
                                  "executionInstance":name});
        attach_execution_grant(&mut request, Some(execution_grant.clone()))?;
        Ok(guest.protected_runner(&remote, &request, 180))
    })();
    let cleanup = cleanup_protected_artifacts(
        &guest,
        &work,
        &remote,
        &["qemu_loader.py", "qemu_guest.py", "request.json"],
        60,
        true,
    );
    merge_cleanup_result(result, cleanup)
}

pub fn enrich_with_grant(
    vm: &str,
    rows: &mut [QemuRedroidInstance],
    execution_grant: Value,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let Ok(guest) = Guest::new(vm) else {
        return Ok(());
    };
    // The Windows ssh client is MSYS2-based: arguments carrying quote characters
    // are rewritten and any command string longer than ~8 KiB is truncated, so
    // the runner travels as a file (as it already does for build/upgrade) instead
    // of being inlined into `python3 -c`.
    let work = qemu::default_portable_state_dir()
        .join("presets")
        .join(format!("details-{}", uuid::Uuid::new_v4().simple()));
    if std::fs::create_dir_all(&work).is_err() {
        return Ok(());
    }
    let mut request = json!({"action":"details", "names": rows.iter().map(|r| &r.instance).collect::<Vec<_>>(),
               "vm": vm, "executionInstance":"batch"});
    let Some(work_name) = work.file_name() else {
        return cleanup_local_work_dir(&work);
    };
    let remote = format!("{GUEST_CORE_ROOT}/{}", work_name.to_string_lossy());
    let result: Result<QemuCliOutput, String> = (|| {
        guest.upload_loader(&work, &remote)?;
        attach_execution_grant(&mut request, Some(execution_grant.clone()))?;
        require(guest.protected_runner(&remote, &request, 180))
    })();
    // The details runner is also protected plaintext. Clean both sides even
    // when upload/runner failed, so a release request cannot leave a reusable
    // copy in the guest cache or local staging directory.
    cleanup_protected_artifacts(
        &guest,
        &work,
        &remote,
        &[
            "qemu_loader.py",
            "qemu_guest.py",
            "request.json",
            "bundle.tar",
        ],
        15,
        true,
    )?;
    let Ok(output) = result else {
        return Ok(());
    };
    if !output.success {
        return Ok(());
    }
    let Ok(details) = serde_json::from_str::<Vec<Value>>(&output.stdout) else {
        return Ok(());
    };
    for row in rows {
        if let Some(detail) = details.iter().find(|d| d["instance"] == row.instance) {
            row.android_version = detail["androidVersion"].as_str().unwrap_or("").into();
            row.image = detail["image"].as_str().unwrap_or("").into();
            row.profile = match detail["resourceProfile"].as_str().unwrap_or("standard") {
                "lean" => "lean".into(),
                "full" => "full".into(),
                _ => "standard".into(),
            };
            row.rollback_available = detail["rollbackAvailable"].as_bool().unwrap_or(false);
            row.metrics = detail
                .get("metrics")
                .cloned()
                .and_then(|value| serde_json::from_value::<RuntimeMetrics>(value).ok());
        }
    }
    Ok(())
}

fn cleanup_local_work_dir(work: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(work) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("本地工作目录清理失败: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_template_contains_bootstrap_only_not_the_protected_runner() {
        let source = include_str!("qemu_loader.py");
        assert!(source.contains("EXECUTION_RELEASE_URL"));
        assert!(source.contains("MAX_CORE_BYTES"));
        assert!(!source.contains("def verify_execution_grant"));
        assert!(!source.contains("def consume_execution_grant"));
        assert!(!source.contains("def android_version(props)"));
    }

    #[test]
    fn protected_runner_request_carries_the_signed_execution_grant() {
        let mut request = json!({"action": "build"});
        let grant = json!({"key_id": "test-key", "payload": "payload", "signature": "signature"});

        attach_execution_grant(&mut request, Some(grant.clone())).unwrap();

        assert_eq!(request["executionGrant"], grant);
    }

    #[test]
    fn protected_workflow_consumes_distinct_grants_in_stage_order() {
        let grants = vec![
            json!({"jti": "build"}),
            json!({"jti": "seed"}),
            json!({"jti": "authorize"}),
        ];
        let mut pending = Some(grants.into_iter());
        let mut request = json!({"action": "build"});

        attach_next_workflow_grant(&mut request, &mut pending).unwrap();
        assert_eq!(request["executionGrant"]["jti"], "build");
        request["action"] = json!("seed");
        attach_next_workflow_grant(&mut request, &mut pending).unwrap();
        assert_eq!(request["executionGrant"]["jti"], "seed");
        request["action"] = json!("authorize");
        attach_next_workflow_grant(&mut request, &mut pending).unwrap();
        assert_eq!(request["executionGrant"]["jti"], "authorize");
        ensure_no_pending_workflow_grants(&mut pending).unwrap();
        // Host activation reuses the authorize grant's signed receipt; it does
        // not consume a fourth service-side JTI.
        request["action"] = json!("activate");
        assert_eq!(request["executionGrant"]["jti"], "authorize");
        assert!(attach_next_workflow_grant(&mut request, &mut pending).is_err());
    }

    #[test]
    fn protected_workflow_rejects_an_unused_grant() {
        let mut pending = Some(
            vec![
                json!({"jti": "build"}),
                json!({"jti": "seed"}),
                json!({"jti": "authorize"}),
                json!({"jti": "unexpected"}),
            ]
            .into_iter(),
        );
        assert!(ensure_no_pending_workflow_grants(&mut pending).is_err());
    }

    #[test]
    fn activation_grant_is_staged_as_json_without_inline_token_data() {
        let dir = std::env::temp_dir().join(format!(
            "rdc-grant-stage-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("execution-grant.json");
        let grant = json!({
            "key_id": "key-a",
            "payload": "signed-payload",
            "signature": "signed-signature",
            "device_proof": "device-proof"
        });

        stage_execution_grant(&path, &grant).unwrap();

        let decoded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(decoded, grant);
        assert!(!path.to_string_lossy().contains("signed-payload"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn protected_runner_stages_in_guest_runtime_directory() {
        assert_eq!(GUEST_CORE_ROOT, "/run/rdc-presets");
    }

    #[test]
    fn only_basic_redroid_creation_is_unprotected() {
        assert!(!requires_protected_authorization(
            &QemuRedroidCreateRequest::default()
        ));
    }

    #[test]
    fn optional_assets_and_overlays_require_a_lease() {
        let mut request = QemuRedroidCreateRequest::default();
        request.install_gapps = true;
        assert!(requires_protected_authorization(&request));

        request.install_gapps = false;
        request.module_zips.push("module.zip".into());
        assert!(requires_protected_authorization(&request));

        request.module_zips.clear();
        request.spoof_profile_id = Some("pixel".into());
        assert!(requires_protected_authorization(&request));
    }

    #[test]
    fn cleanup_failure_turns_a_successful_protected_operation_into_failure() {
        let output = QemuCliOutput {
            success: true,
            exit_code: 0,
            stdout: "created".into(),
            stderr: String::new(),
        };

        let result = merge_cleanup_result(Ok(output), Err("guest ssh unavailable".into()))
            .expect("operation output should remain serializable");

        assert!(!result.success);
        assert_eq!(result.exit_code, 1);
        assert!(result.stderr.contains("受保护文件清理失败"));
        assert!(result.stderr.contains("guest ssh unavailable"));
    }
}
