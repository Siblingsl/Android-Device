//! Host orchestration of node-local image builds and reversible upgrades.
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use crate::models::{CreateInstanceRequest, RuntimeMetrics};
use crate::services::{adb, cloak, preset, qemu, spoof, traces, util};
use qemu::{QemuCliOutput, QemuRedroidCreateRequest, QemuRedroidInstance, QemuVmEntry};

static OPERATIONS: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 24 && !name.starts_with('-') && !name.ends_with('-')
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate(req: &QemuRedroidCreateRequest, upgrade: bool) -> Result<(), String> {
    if !valid_name(&req.vm) || !valid_name(&req.name) { return Err("节点/实例名称无效".into()); }
    if !matches!(req.profile.trim(), "" | "lean" | "standard" | "full") {
        return Err("资源 profile 必须是 lean、standard 或 full".into());
    }
    if !upgrade && (!req.cpus.is_finite() || req.cpus <= 0.0 || req.memory_mib < 512 || req.width == 0 || req.height == 0 || req.dpi == 0) {
        return Err("CPU、内存、分辨率和 DPI 必须是有效的正数（内存至少 512 MiB）".into());
    }
    let profile = req.spoof_profile_id.as_deref().unwrap_or("");
    if !req.install_magisk && (req.install_lsposed || req.install_shamiko || req.install_cloak || req.install_native_cloak
        || !req.module_zips.is_empty() || !profile.is_empty() || !req.spoof_profile.trim().is_empty() || req.spoof_abilist || !req.hide_packages.is_empty() || req.clean_traces) {
        return Err("模块、设备档案和高级伪装需要 Magisk + Zygisk".into());
    }
    if req.install_cloak && !req.install_lsposed { return Err("DeviceCloak 需要 LSPosed".into()); }
    if req.clean_traces && profile.is_empty() { return Err("环境痕迹配置需要选择设备档案".into()); }
    for package in &req.hide_packages {
        if package.is_empty() || !package.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$')) {
            return Err(format!("目标包名无效: {package}"));
        }
    }
    Ok(())
}

struct Guest { node: QemuVmEntry, state: PathBuf }
impl Guest {
    fn new(vm: &str) -> Result<Self, String> {
        let node = qemu::vm_list()?.into_iter().find(|v| v.name == vm).ok_or_else(|| format!("节点不存在: {vm}"))?;
        Ok(Self { node, state: qemu::default_portable_state_dir() })
    }
    fn options(&self, scp: bool) -> Vec<String> {
        vec![if scp { "-P" } else { "-p" }.into(), self.node.ssh_host_port.to_string(),
             "-i".into(), self.state.join("keys").join(format!("{}_ed25519", self.node.name)).to_string_lossy().into_owned(),
             "-o".into(), "BatchMode=yes".into(), "-o".into(), "StrictHostKeyChecking=accept-new".into(),
             "-o".into(), format!("UserKnownHostsFile={}", self.state.join("vms").join(&self.node.name).join("known_hosts").display()),
             "-o".into(), "ConnectTimeout=8".into()]
    }
    fn ssh(&self, script: &str, seconds: u64) -> QemuCliOutput {
        let mut args = self.options(false);
        args.extend(["rdc@127.0.0.1".into(), script.into()]);
        output(util::run_command_timeout("ssh", &args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(seconds)))
    }
    fn copy(&self, local: &Path, remote: &str) -> Result<(), String> {
        let mut args = self.options(true);
        args.extend([local.to_string_lossy().into_owned(), format!("rdc@127.0.0.1:{remote}")]);
        require(output(util::run_command_timeout("scp", &args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(600))))?;
        Ok(())
    }
    fn runner(&self, work: &str, request: &Value, seconds: u64) -> QemuCliOutput {
        let encoded = base64::engine::general_purpose::STANDARD.encode(request.to_string());
        self.ssh(&format!("printf %s {} | base64 -d > {}/request.json && sudo python3 {}/qemu_guest.py {}/request.json",
                          quote(&encoded), quote(work), quote(work), quote(work)), seconds)
    }
    fn upload(&self, local: &Path, remote: &str) -> Result<(), String> {
        std::fs::write(local.join("qemu_guest.py"), include_str!("qemu_guest.py").replace("\r\n", "\n")).map_err(|e| e.to_string())?;
        let archive = local.with_extension("tar");
        let result = (|| {
            require(output(util::run_command_timeout("tar", &["-cf", &archive.to_string_lossy(), "-C", &local.to_string_lossy(), "."], Duration::from_secs(300))))?;
            require(self.ssh(&format!("mkdir -p {}", quote(remote)), 30))?;
            self.copy(&archive, &format!("{remote}/bundle.tar"))?;
            require(self.ssh(&format!("tar -xf {0}/bundle.tar -C {0} && rm {0}/bundle.tar", quote(remote)), 180))?;
            Ok(())
        })();
        let _ = std::fs::remove_file(archive);
        result
    }
}

fn quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\"'\"'")) }
fn output(r: crate::models::ShellResult) -> QemuCliOutput {
    QemuCliOutput { success: r.success, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr }
}
fn require(r: QemuCliOutput) -> Result<QemuCliOutput, String> {
    if r.success { Ok(r) } else { Err(format!("{}\n{}", r.stdout, r.stderr).trim().into()) }
}

fn context_hash(root: &Path, base: &str) -> Result<String, String> {
    fn walk(path: &Path, relative: &str, h: &mut DefaultHasher) -> std::io::Result<()> {
        let mut files = std::fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        files.sort_by_key(|f| f.file_name());
        for entry in files {
            let name = format!("{relative}/{}", entry.file_name().to_string_lossy());
            h.write(name.as_bytes());
            if entry.file_type()?.is_dir() { walk(&entry.path(), &name, h)?; }
            else {
                let mut file = std::fs::File::open(entry.path())?;
                let mut buf = [0u8; 65536];
                loop { let n = file.read(&mut buf)?; if n == 0 { break; } h.write(&buf[..n]); }
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
    let file = std::fs::File::open(path).map_err(|e| format!("模块文件无法打开 {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut props = String::new();
    archive.by_name("module.prop").map_err(|_| format!("模块缺少 module.prop: {}", path.display()))?
        .take(65536).read_to_string(&mut props).map_err(|e| e.to_string())?;
    let id = props.lines().find_map(|l| l.trim().strip_prefix("id=")).unwrap_or("").trim();
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) || id == "." || id == ".." {
        return Err(format!("模块 ID 无效: {}", path.display()));
    }
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.enclosed_name().is_none() || entry.name().contains('\\') { return Err("模块 zip 含不安全路径".into()); }
    }
    Ok(id.into())
}

fn prepare(req: &QemuRedroidCreateRequest, base: &str, version: &str, work: &Path) -> Result<Value, String> {
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
    if extracted.is_dir() { std::fs::remove_dir_all(&extracted).map_err(|e| e.to_string())?; }
    let mut additional: Vec<PathBuf> = req.module_zips.iter().map(PathBuf::from).collect();
    if req.install_native_cloak {
        additional.push(if req.native_cloak_zip.trim().is_empty() { cloak::native_cloak_zip_path() } else { PathBuf::from(&req.native_cloak_zip) });
    }
    let modules = work.join("modules");
    if !additional.is_empty() { std::fs::create_dir_all(&modules).map_err(|e| e.to_string())?; }
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
        if ids.windows(2).any(|p| p[0] == p[1]) { return Err("所选模块存在重复 ID".into()); }
    }
    let profile = req.spoof_profile_id.as_deref().filter(|id| !id.is_empty()).map(|id|
        spoof::profile_by_id(id).ok_or_else(|| format!("设备档案不存在: {id}"))).transpose()?;
    if req.install_cloak {
        let apk = cloak::cloak_module_apk_path();
        std::fs::copy(&apk, work.join("DeviceCloak.apk")).map_err(|e| format!("缺少 DeviceCloak APK {}: {e}", apk.display()))?;
    }
    let mut expected = json!({});
    if let Some(profile) = &profile {
        std::fs::write(work.join("cloak.json"), cloak::render_cloak_config(profile)).map_err(|e| e.to_string())?;
        expected = json!({"ro.product.model": profile.model, "ro.product.brand": profile.brand});
        if req.clean_traces {
            let dir = work.join("traces");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("cpuinfo"), traces::fake_cpuinfo_for(profile)).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("version"), traces::fake_version_for(profile)).map_err(|e| e.to_string())?;
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    let key = home.and_then(|p| std::fs::read_to_string(p.join(".android/adbkey.pub")).ok()).unwrap_or_default();
    if req.install_magisk && key.trim().is_empty() { return Err("未找到宿主 ADB 公钥，请先使用设备中心连接一次设备".into()); }
    Ok(json!({"name": req.name, "androidVersion": version, "baseImage": base,
              "resourceProfile": if req.profile.trim().is_empty() { "standard" } else { req.profile.trim() },
              "installGapps": req.install_gapps, "installMagisk": req.install_magisk,
              "installLsposed": req.install_lsposed, "installCloak": req.install_cloak,
              "cleanTraces": req.clean_traces, "moduleIds": ids, "hidePackages": req.hide_packages,
              "expectedProps": expected, "adbPubkey": key.lines().next().unwrap_or("")}))
}

pub fn apply(req: QemuRedroidCreateRequest, upgrade: bool) -> Result<QemuCliOutput, String> {
    let _operation = OPERATIONS.try_lock().ok_or("已有节点操作正在运行，请等待完成")?;
    validate(&req, upgrade)?;
    let guest = Guest::new(&req.vm)?;
    if upgrade && !guest.node.adb_assignments.iter().any(|a| a.instance == req.name) { return Err("实例未注册".into()); }
    if !upgrade && guest.node.adb_assignments.iter().any(|a| a.instance == req.name) { return Err("实例名称已存在".into()); }
    let version = req.android_version.as_deref().filter(|s| !s.is_empty()).unwrap_or("14");
    let default_image = format!("redroid/redroid:{version}.0.0-latest");
    let base = req.image.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(&default_image);
    let work = qemu::default_portable_state_dir().join("presets").join(format!("job-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut request = prepare(&req, base, version, &work)?;
        let tag = format!("qc-preset:{}", context_hash(&work, base)?);
        let remote = format!("/home/rdc/.cache/rdc-presets/{}", work.file_name().unwrap().to_string_lossy());
        guest.upload(&work, &remote)?;
        request["context"] = json!(remote);
        request["image"] = json!(tag);
        request["action"] = json!("build");
        let built = require(guest.runner(&remote, &request, 1500))?;
        let mut stdout = built.stdout;
        if upgrade {
            request["action"] = json!("upgrade");
            let mut result = guest.runner(&remote, &request, 1500);
            result.stdout = format!("{stdout}\n{}", result.stdout);
            return Ok(result);
        }
        request["action"] = json!("seed");
        require(guest.runner(&remote, &request, 90))?;
        let mut create = req.clone();
        create.image = Some(tag);
        let mut args = qemu::args_redroid_create(&create);
        if req.clean_traces {
            for (file, target) in [("cpuinfo", "/proc/cpuinfo"), ("version", "/proc/version")] {
                args.extend(["--bind".into(), format!("{remote}/traces/{file}:{target}:ro")]);
            }
            args.extend(["--cgroup-parent".into(), "system.slice".into()]);
        }
        let created = qemu::run_cli(&args, Duration::from_secs(240))?;
        stdout.push_str(&format!("\n{}", created.stdout));
        if !created.success { return Ok(QemuCliOutput { stdout, ..created }); }
        request["action"] = json!("activate");
        let mut activated = guest.runner(&remote, &request, 900);
        activated.stdout = format!("{stdout}\n{}", activated.stdout);
        if activated.success {
            let serial = qemu::adb_list()?.into_iter().find(|m| m.vm == req.vm && m.instance == req.name).map(|m| m.serial).unwrap_or_default();
            let ready = adb::wait_ready(&serial, Duration::from_secs(60));
            if !ready.success { activated.success = false; activated.exit_code = 1; activated.stderr = format!("Android 预装完成，但宿主 ADB 尚未就绪: {}", ready.stderr); }
        }
        Ok(activated)
    })();
    // Keep failed preparation material for diagnostics; successful local payload can be removed.
    if result.as_ref().is_ok_and(|o| o.success) { let _ = std::fs::remove_dir_all(&work); }
    result
}

pub fn restore(vm: &str, name: &str) -> Result<QemuCliOutput, String> {
    let _operation = OPERATIONS.try_lock().ok_or("已有节点操作正在运行，请等待完成")?;
    if !valid_name(vm) || !valid_name(name) { return Err("节点/实例名称无效".into()); }
    let guest = Guest::new(vm)?;
    let work = qemu::default_portable_state_dir().join("presets").join(format!("restore-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let remote = format!("/home/rdc/.cache/rdc-presets/{}", work.file_name().unwrap().to_string_lossy());
    guest.upload(&work, &remote)?;
    let result = guest.runner(&remote, &json!({"action":"restore","name":name}), 180);
    let _ = std::fs::remove_dir_all(work);
    Ok(result)
}

pub fn enrich(vm: &str, rows: &mut [QemuRedroidInstance]) {
    if rows.is_empty() { return; }
    let Ok(guest) = Guest::new(vm) else { return; };
    // The Windows ssh client is MSYS2-based: arguments carrying quote characters
    // are rewritten and any command string longer than ~8 KiB is truncated, so
    // the runner travels as a file (as it already does for build/upgrade) instead
    // of being inlined into `python3 -c`.
    let work = qemu::default_portable_state_dir().join("presets").join(format!("details-{}", uuid::Uuid::new_v4().simple()));
    if std::fs::create_dir_all(&work).is_err() { return; }
    let request = json!({"action":"details", "names": rows.iter().map(|r| &r.instance).collect::<Vec<_>>()});
    let result: Result<QemuCliOutput, String> = (|| {
        let remote = format!("/home/rdc/.cache/rdc-presets/{}", work.file_name().ok_or("预装工作目录无效")?.to_string_lossy());
        guest.upload(&work, &remote)?;
        require(guest.runner(&remote, &request, 180))
    })();
    let _ = std::fs::remove_dir_all(&work);
    let Ok(output) = result else { return; };
    if !output.success { return; }
    let Ok(details) = serde_json::from_str::<Vec<Value>>(&output.stdout) else { return; };
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
}
