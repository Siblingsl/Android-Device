use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::models::{
    CreateInstanceRequest, DockerContainer, DockerImage, DockerInfo, DockerVolume, ShellResult,
};
use crate::services::{adb, cache, log, settings, util};

static CREATE_STAGE: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

pub fn create_stage() -> String {
    CREATE_STAGE.lock().clone()
}

fn set_create_stage(msg: &str) {
    *CREATE_STAGE.lock() = msg.to_string();
    if !msg.is_empty() {
        log::info("Docker", msg);
    }
}

pub fn docker_bin() -> String {
    settings::docker_path()
}

pub fn is_running() -> bool {
    is_running_fast() || is_running_slow()
}

/// Second probe with a generous timeout: the 3s fast probe false-negatives
/// while the engine is cold-starting (WSL busy right after app launch), which
/// used to leave the Docker page on "未运行" with empty lists until a manual
/// refresh. Only reached when the fast probe already said down.
fn is_running_slow() -> bool {
    let r = util::run_command_timeout(
        &docker_bin(),
        &["version", "--format", "{{.Server.Version}}"],
        Duration::from_secs(12),
    );
    let ok = r.success && !r.stdout.is_empty();
    if ok {
        cache::set_docker_running(true);
        cache::set_docker_version(r.stdout.trim().to_string());
    }
    ok
}

/// Prefer lightweight ping over `docker info` (info is very slow on Windows).
pub fn is_running_fast() -> bool {
    if let Some(v) = cache::docker_running(Duration::from_secs(5)) {
        return v;
    }
    let r = util::run_command_timeout(&docker_bin(), &["version", "--format", "{{.Server.Version}}"], Duration::from_secs(3));
    let ok = r.success && !r.stdout.is_empty();
    cache::set_docker_running(ok);
    if ok {
        cache::set_docker_version(r.stdout.trim().to_string());
    }
    ok
}

pub fn version() -> String {
    version_cached()
}

pub fn version_cached() -> String {
    if let Some(v) = cache::docker_version(Duration::from_secs(30)) {
        return v;
    }
    let r = util::run_command_timeout(
        &docker_bin(),
        &["version", "--format", "{{.Server.Version}}"],
        Duration::from_secs(3),
    );
    let v = if r.success && !r.stdout.is_empty() {
        r.stdout
    } else {
        let r2 = util::run_command_timeout(&docker_bin(), &["--version"], Duration::from_secs(3));
        if r2.success {
            r2.stdout
        } else {
            "unavailable".into()
        }
    };
    cache::set_docker_version(v.clone());
    v
}

pub fn list_images() -> Vec<DockerImage> {
    let r = util::run_command_timeout(
        &docker_bin(),
        &[
            "images",
            "--format",
            "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}",
        ],
        Duration::from_secs(20),
    );
    if !r.success {
        return vec![];
    }
    r.stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let p: Vec<&str> = line.split('\t').collect();
            DockerImage {
                id: p.first().unwrap_or(&"").to_string(),
                repository: p.get(1).unwrap_or(&"").to_string(),
                tag: p.get(2).unwrap_or(&"").to_string(),
                size: p.get(3).unwrap_or(&"").to_string(),
                created: p.get(4).unwrap_or(&"").to_string(),
            }
        })
        .collect()
}

pub fn list_containers(all: bool) -> Vec<DockerContainer> {
    let mut args = vec![
        "ps",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}",
    ];
    if all {
        args.insert(1, "-a");
    }
    let mut r = util::run_command_timeout(&docker_bin(), &args, Duration::from_secs(20));
    if !r.success {
        // docker CLI fails transiently while the daemon is busy (e.g. a
        // container is starting); one retry beats silently reporting an
        // empty list that the UI then treats as "no instances".
        std::thread::sleep(Duration::from_millis(400));
        r = util::run_command_timeout(&docker_bin(), &args, Duration::from_secs(20));
        if !r.success {
            log::error(
                "Docker",
                &format!("docker ps failed: {} {}", r.stdout, r.stderr),
            );
            return vec![];
        }
    }
    let mut containers: Vec<DockerContainer> = r
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let p: Vec<&str> = line.split('\t').collect();
            let name = p.get(1).unwrap_or(&"").to_string();
            let image = p.get(2).unwrap_or(&"").to_string();
            let is_redroid = name.contains("redroid")
                || image.contains("redroid")
                || name.starts_with("rdc-");
            DockerContainer {
                id: p.first().unwrap_or(&"").to_string(),
                name,
                image,
                status: p.get(3).unwrap_or(&"").to_string(),
                ports: p.get(4).unwrap_or(&"").to_string(),
                created: p.get(5).unwrap_or(&"").to_string(),
                is_redroid,
            }
        })
        .collect();
    enrich_stopped_container_ports(&mut containers);
    containers
}

/// `docker ps -a` (Docker 25+) leaves the Ports column empty for stopped
/// containers even when they carry host port bindings, so port-conflict
/// checks became blind to exited instances and every new instance was
/// suggested 5555. Re-read HostConfig.PortBindings with one batched
/// `docker inspect` for containers whose Ports column came back empty.
fn enrich_stopped_container_ports(containers: &mut [DockerContainer]) {
    let names: Vec<String> = containers
        .iter()
        .filter(|c| c.ports.trim().is_empty())
        .map(|c| c.name.trim_start_matches('/').to_string())
        .collect();
    if names.is_empty() {
        return;
    }
    let mut args: Vec<String> = vec![
        "inspect".into(),
        "--format".into(),
        "{{.Name}} {{json .HostConfig.PortBindings}}".into(),
    ];
    args.extend(names);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let r = util::run_command_timeout(&docker_bin(), &arg_refs, Duration::from_secs(10));
    if !r.success {
        return;
    }
    for line in r.stdout.lines() {
        let Some((name, json)) = line.split_once(' ') else {
            continue;
        };
        let ports = bindings_to_ports(json);
        if ports.is_empty() {
            continue;
        }
        let clean = name.trim_start_matches('/');
        if let Some(c) = containers
            .iter_mut()
            .find(|c| c.name.trim_start_matches('/') == clean)
        {
            c.ports = ports;
        }
    }
}

/// Convert `{"5555/tcp":[{"HostIp":"","HostPort":"5555"}]}` into the
/// `docker ps` ports syntax (`0.0.0.0:5555->5555/tcp`) so the existing
/// string-based conflict checks keep working unchanged.
fn bindings_to_ports(json: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return String::new();
    };
    let Some(map) = v.as_object() else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (key, targets) in map {
        let Some(arr) = targets.as_array() else { continue };
        for t in arr {
            let host_port = t.get("HostPort").and_then(|x| x.as_str()).unwrap_or("");
            if host_port.is_empty() {
                continue;
            }
            let host_ip = t.get("HostIp").and_then(|x| x.as_str()).unwrap_or("");
            let ip = match host_ip {
                "" => "0.0.0.0",
                s if s.contains(':') && !s.starts_with('[') => "[::]",
                s => s,
            };
            parts.push(format!("{ip}:{host_port}->{key}"));
        }
    }
    parts.join(", ")
}

pub fn create_redroid(req: &CreateInstanceRequest) -> ShellResult {
    cache::invalidate_docker();
    cache::invalidate_devices();
    set_create_stage(&format!("检查名称与端口：{}", req.name));
    log::info("Docker", &format!("Creating Redroid instance: {}", req.name));

    let sanitized = sanitize_name(&req.name);
    if sanitized.is_empty() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "实例名称无效（需字母/数字/下划线/横线）".into(),
            exit_code: -1,
        };
    }
    let container_name = format!("rdc-{}", sanitized);
    let res_parts: Vec<&str> = req.resolution.split('x').collect();
    let width = res_parts.first().copied().unwrap_or("1080");
    let height = res_parts.get(1).copied().unwrap_or("1920");

    if req.adb_port == 0 {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "ADB 端口无效".into(),
            exit_code: -1,
        };
    }

    // Unique name + host ADB port (do not silently overwrite same-name instances)
    let existing = list_containers(true);
    if existing.iter().any(|c| {
        c.name == container_name
            || c.name.trim_start_matches('/') == container_name
            || c.name == format!("/{}", container_name)
    }) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!(
                "实例名称已存在: {}（容器 {}）。请换一个名字，或先删除旧实例。",
                req.name, container_name
            ),
            exit_code: -1,
        };
    }
    if host_port_in_use(&existing, req.adb_port) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!(
                "ADB 主机端口 {} 已被其它容器占用。请换端口（如 {}）。",
                req.adb_port,
                suggest_free_adb_port(&existing)
            ),
            exit_code: -1,
        };
    }

    // Bind ADB to loopback only: instances with a userdebug build run
    // unauthenticated ADB, which must not be reachable from the LAN.
    let port_map = format!("127.0.0.1:{}:5555", req.adb_port);
    let base_image = if req.image.is_empty() {
        format!("redroid/redroid:{}", req.android_version)
    } else {
        req.image.clone()
    };
    let cpus = normalize_cpus(&req.cpu);
    let memory = normalize_memory(&req.ram);

    // Ensure image exists first — pull can take several minutes
    if !image_exists(&base_image) {
        set_create_stage(&format!("拉取镜像 {base_image}（可能较久）…"));
        log::info("Docker", &format!("Image not found locally, pulling {} ...", base_image));
        let pull = util::run_command_timeout(
            &docker_bin(),
            &["pull", &base_image],
            Duration::from_secs(600),
        );
        if !pull.success {
            log::error(
                "Docker",
                &format!("Pull failed: {} {}", pull.stdout, pull.stderr),
            );
            return ShellResult {
                success: false,
                stdout: pull.stdout,
                stderr: format!(
                    "镜像拉取失败（可能超时或网络问题）: {}\n{}",
                    base_image, pull.stderr
                ),
                exit_code: pull.exit_code,
            };
        }
        log::info("Docker", &format!("Image pulled: {}", base_image));
    }

    let image = if req.install_magisk {
        set_create_stage("构建 / 复用 Magisk 定制镜像…");
        match ensure_preset_image(req, &base_image) {
            Ok(tag) => {
                log::info("Docker", &format!("Using Magisk preset image {tag}"));
                if req.install_gapps {
                    // GApps 叠加在 Magisk 预设之上：两个选项可同时生效
                    //（此前 else-if 会让勾选了 Magisk 的实例静默丢掉 GApps）。
                    set_create_stage("构建 / 复用 GApps 镜像（叠加在 Magisk 预设上）…");
                    let zip = resolve_gapps_zip(req.gapps_zip.trim(), &base_image);
                    match ensure_gapps_image(&tag, &zip) {
                        Ok(gtag) => {
                            log::info(
                                "Docker",
                                &format!("Using GApps image layered on Magisk preset: {gtag}"),
                            );
                            gtag
                        }
                        Err(e) => {
                            return ShellResult {
                                success: false,
                                stdout: String::new(),
                                stderr: e,
                                exit_code: -1,
                            };
                        }
                    }
                } else {
                    tag
                }
            }
            Err(e) => {
                return ShellResult {
                    success: false,
                    stdout: String::new(),
                    stderr: e,
                    exit_code: -1,
                };
            }
        }
    } else if req.install_gapps {
        set_create_stage("构建 / 复用 GApps 镜像…");
        let zip = resolve_gapps_zip(req.gapps_zip.trim(), &base_image);
        match ensure_gapps_image(&base_image, &zip) {
            Ok(tag) => {
                log::info("Docker", &format!("Using GApps image {tag}"));
                tag
            }
            Err(e) => {
                return ShellResult {
                    success: false,
                    stdout: String::new(),
                    stderr: e,
                    exit_code: -1,
                };
            }
        }
    } else {
        base_image
    };

    let dpi_arg = format!("androidboot.redroid_dpi={}", req.dpi);
    let w_arg = format!("androidboot.redroid_width={}", width);
    let h_arg = format!("androidboot.redroid_height={}", height);
    let volume = data_volume_name(&sanitized);
    let volume_map = format!("{volume}:/data");

    set_create_stage(&format!("创建数据卷 {volume}"));
    let created_vol = util::run_command_timeout(
        &docker_bin(),
        &["volume", "create", &volume],
        Duration::from_secs(20),
    );
    if !created_vol.success {
        log::warn(
            "Docker",
            &format!("volume create {volume} failed (will retry via -v): {}", created_vol.stderr),
        );
    }

    set_create_stage(&format!("启动容器 {container_name}"));
    // docker run -d usually returns quickly once image is local; still allow headroom
    let mut r = util::run_command_timeout(
        &docker_bin(),
        &[
            "run",
            "-d",
            "--name",
            &container_name,
            "--privileged",
            "--cpus",
            &cpus,
            "--memory",
            &memory,
            "-v",
            &volume_map,
            "-p",
            &port_map,
            image.as_str(),
            &w_arg,
            &h_arg,
            &dpi_arg,
            "androidboot.redroid_gpu_mode=guest",
        ],
        Duration::from_secs(120),
    );

    if r.success {
        log::info(
            "Docker",
            &format!("Created container {} vol={volume} ({})", container_name, r.stdout),
        );
        let serial = format!("127.0.0.1:{}", req.adb_port);
        if req.wait_adb {
            set_create_stage(&format!("等待 ADB 就绪 {serial}（最长约 4 分钟）"));
            let limit = 240u64;
            let ready = adb::wait_ready_with(&serial, Duration::from_secs(limit), |secs, state, boot| {
                let boot = if boot.is_empty() { "—" } else { boot };
                set_create_stage(&format!(
                    "等待 ADB {serial}：已等 {secs}/{limit} 秒 · state={state} · boot={boot}"
                ));
            });
            r.stdout = format!(
                "{}\n数据卷: {volume}\nADB: {serial}\n{}",
                r.stdout.trim(),
                ready.stdout.trim()
            )
            .trim()
            .to_string();
            if !ready.success {
                r.success = false;
                r.stderr = format!(
                    "容器已创建并启动，但 ADB 未就绪。\n{}\n{}",
                    ready.stderr, r.stderr
                );
                r.exit_code = ready.exit_code;
            } else {
                if req.install_magisk {
                    match magisk_first_boot_activation(&container_name, req, &serial) {
                        Ok(msg) => {
                            r.stdout = format!("{}\n{}", r.stdout.trim(), msg.trim());
                        }
                        Err(e) => {
                            log::warn(
                                "Docker",
                                &format!("Magisk activation incomplete for {container_name}: {e}"),
                            );
                            r.stdout = format!(
                                "{}\nMagisk 激活未完成（可手动 docker restart 后检查 /data/adb/rdc_preset.log）：{e}",
                                r.stdout.trim()
                            );
                        }
                    }
                }
                if req.install_gapps {
                    skip_first_boot_provisioning(&serial);
                }
                first_boot_screen_on(&serial);
            }
        } else {
            let magisk_hint = if req.install_magisk {
                "\n已勾选 Magisk：本次跳过了等待 ADB，开机后需手动重启一次容器以完成激活（Zygisk/模块）"
            } else {
                ""
            };
            r.stdout = format!(
                "{}\n数据卷: {volume}\nADB: {serial}\n已跳过等待 ADB（工具不可用或已关闭等待）{magisk_hint}",
                r.stdout.trim()
            );
        }
    } else {
        log::error(
            "Docker",
            &format!("Create failed: {} {}", r.stdout, r.stderr),
        );
    }
    cache::invalidate_docker();
    cache::invalidate_devices();
    set_create_stage(if r.success {
        "创建完成"
    } else {
        "创建未完成"
    });
    r
}

fn data_volume_name(sanitized: &str) -> String {
    format!("rdc-{sanitized}-data")
}

fn wait_container_adb(id_or_name: &str, timeout: Duration) -> ShellResult {
    let port = list_containers(true)
        .iter()
        .find(|c| {
            c.id == id_or_name
                || c.id.starts_with(id_or_name)
                || c.name.trim_start_matches('/') == id_or_name.trim_start_matches('/')
        })
        .and_then(|c| extract_container_host_port(&c.ports));
    let Some(port) = port else {
        return ShellResult {
            success: true,
            stdout: "容器已操作，但未解析到 ADB 端口，请手动连接".into(),
            stderr: String::new(),
            exit_code: 0,
        };
    };
    adb::wait_ready(&format!("127.0.0.1:{port}"), timeout)
}

fn extract_container_host_port(ports: &str) -> Option<u16> {
    for part in ports.split(',') {
        if let Some(left) = part.split("->").next() {
            if let Some(p) = left.split(':').last() {
                if let Ok(port) = p.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    None
}

fn normalize_cpus(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return "2".into();
    }
    if s.parse::<f64>().is_ok() {
        return s.to_string();
    }
    "2".into()
}

fn normalize_memory(raw: &str) -> String {
    let s = raw.trim().to_lowercase().replace(' ', "");
    if s.is_empty() {
        return "2g".into();
    }
    if s.chars().last().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
        return s;
    }
    if s.parse::<u64>().is_ok() {
        return format!("{s}g");
    }
    "2g".into()
}

/// Whether anything already listens on the loopback port. Catches non-Docker
/// processes (and Hyper-V reserved ranges) that the container port map can't
/// see — without this, create/clone only discover the conflict when
/// `docker run` fails minutes into image prep.
fn loopback_port_bound(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port))).is_err()
}

fn host_port_in_use(containers: &[DockerContainer], port: u16) -> bool {
    let needle_a = format!(":{}->", port);
    let needle_b = format!("0.0.0.0:{}", port);
    let needle_c = format!("[::]:{}", port);
    containers.iter().any(|c| {
        c.ports.contains(&needle_a)
            || c.ports.contains(&needle_b)
            || c.ports.contains(&needle_c)
            || c.ports.split(',').any(|p| {
                p.split("->")
                    .next()
                    .and_then(|l| l.split(':').last())
                    .and_then(|s| s.trim().parse::<u16>().ok())
                    == Some(port)
            })
    }) || loopback_port_bound(port)
}

pub fn suggest_free_adb_port(containers: &[DockerContainer]) -> u16 {
    let mut p: u16 = 5555;
    while p < 6000 {
        if !host_port_in_use(containers, p) {
            return p;
        }
        p += 1;
    }
    5555
}

/// Next free ADB host port among current containers (for UI defaults).
pub fn next_free_adb_port() -> u16 {
    suggest_free_adb_port(&list_containers(true))
}

pub fn adb_port_taken(port: u16) -> bool {
    host_port_in_use(&list_containers(true), port)
}

/// Launch Docker Desktop when the engine is unreachable. Returns true if the
/// exe was spawned; the engine needs ~30-60s to come up, so callers should
/// keep polling the docker probe afterwards.
pub fn start_docker_desktop() -> bool {
    let exe = std::env::var("ProgramFiles")
        .map(|p| {
            std::path::PathBuf::from(p)
                .join("Docker")
                .join("Docker")
                .join("Docker Desktop.exe")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"));
    if !exe.exists() {
        log::warn(
            "Docker",
            &format!("未找到 Docker Desktop.exe（{}），请手动启动", exe.display()),
        );
        return false;
    }
    match std::process::Command::new(&exe).spawn() {
        Ok(_) => {
            log::info("Docker", "已启动 Docker Desktop，等待引擎就绪（约 30-60s）…");
            true
        }
        Err(e) => {
            log::warn("Docker", &format!("启动 Docker Desktop 失败: {e}"));
            false
        }
    }
}

pub fn container_name_taken(name: &str) -> bool {
    let raw = name.trim().trim_start_matches('/');
    let base = raw.strip_prefix("rdc-").unwrap_or(raw);
    let container_name = format!("rdc-{}", sanitize_name(base));
    if container_name == "rdc-" {
        return true;
    }
    list_containers(true).iter().any(|c| {
        let n = c.name.trim_start_matches('/');
        n == container_name || n == raw || sanitize_name(n.strip_prefix("rdc-").unwrap_or(n)) == sanitize_name(base)
    })
}

pub fn resolve_gapps_zip(preferred: &str, image: &str) -> String {
    let p = preferred.trim();
    if !p.is_empty() && std::path::Path::new(p).exists() {
        return p.to_string();
    }
    let settings_p = settings::gapps_zip_path();
    if !settings_p.is_empty() && std::path::Path::new(&settings_p).exists() {
        return settings_p;
    }
    for dir in gapps_search_dirs() {
        if let Some(found) = pick_zip_in(&dir, image) {
            return found;
        }
    }
    String::new()
}

pub fn local_gapps_path() -> String {
    resolve_gapps_zip("", "redroid/redroid:13.0.0-latest")
}

fn gapps_search_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = project_root_dirs()
        .iter()
        .map(|r| r.join("vendor").join("gapps"))
        .collect();
    if let Some(exe_parent) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|x| x.to_path_buf()))
    {
        dirs.push(exe_parent.join("gapps"));
    }
    dirs
}

fn pick_zip_in(dir: &std::path::Path, image: &str) -> Option<String> {
    let hint = if image.contains("16.") {
        "16.0"
    } else if image.contains("15.") {
        "15.0"
    } else if image.contains("14.") {
        "14.0"
    } else if image.contains("13.") {
        "13.0"
    } else if image.contains("12.") {
        "12.1"
    } else {
        ""
    };
    let mut zips: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("zip"))
                .unwrap_or(false)
        })
        .collect();
    zips.sort_by_key(|p| {
        std::cmp::Reverse(
            p.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        )
    });
    if !hint.is_empty() {
        if let Some(p) = zips.iter().find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().contains(hint))
                .unwrap_or(false)
        }) {
            return Some(p.to_string_lossy().into());
        }
    }
    zips.first().map(|p| p.to_string_lossy().into())
}

fn image_exists(image: &str) -> bool {
    let r = util::run_command_timeout(
        &docker_bin(),
        &["image", "inspect", image, "--format", "{{.Id}}"],
        Duration::from_secs(8),
    );
    r.success && !r.stdout.is_empty()
}

/// Build (or reuse) a derived Redroid image with user-supplied GApps overlay.
/// Accepts MindTheGapps / extracted `system/` trees. Does not download GApps.
fn ensure_gapps_image(base_image: &str, zip_or_dir: &str) -> Result<String, String> {
    let src = zip_or_dir.trim();
    if src.is_empty() {
        return Err(
            "已勾选预装 Google 套件，但未指定本地 zip。请在创建设置或「设置 → GApps zip」中填写路径（OpenGApps / MindTheGapps，需自行下载）。".into(),
        );
    }
    let src_path = std::path::Path::new(src);
    if !src_path.exists() {
        return Err(format!(
            "GApps 路径不存在: {src}\n基础镜像: {base_image}"
        ));
    }

    let stamp = gapps_stamp(src_path)?;
    let tag_safe = base_image
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let tag = format!("rdc-gapps:{tag_safe}-{stamp}");
    if image_exists(&tag) {
        log::info("Docker", &format!("Reusing GApps image {tag}"));
        return Ok(tag);
    }

    let work = std::env::temp_dir().join(format!("rdc-gapps-{}", util::now_millis()));
    let overlay_dir = work.join("overlay");
    util::ensure_dir(&work.to_string_lossy());
    util::ensure_dir(&overlay_dir.to_string_lossy());

    let built = (|| {
        let extracted = if src_path.is_dir() {
            src_path.to_path_buf()
        } else {
            let dest = work.join("extract");
            util::ensure_dir(&dest.to_string_lossy());
            extract_archive(src_path, &dest)?;
            dest
        };
        if looks_like_opengapps(&extracted) {
            return Err(format!(
                "当前是 OpenGApps 压缩包（含 Core/ 分卷），需要 lzip 解包，本机暂不自动处理。请改用 MindTheGapps zip，或先自行解出带 system/app、system/priv-app 的目录。\n基础镜像: {base_image}\nGApps: {src}\n目标镜像: {tag}"
            ));
        }
        let system = find_system_overlay(&extracted).ok_or_else(|| {
            format!(
                "zip/目录里找不到 system/app、system/priv-app 或 system/product。请使用 MindTheGapps。\n基础镜像: {base_image}\nGApps: {src}\n目标镜像: {tag}"
            )
        })?;
        copy_dir_all(&system, &overlay_dir).map_err(|e| {
            format!("复制 GApps overlay 失败: {e}\n基础镜像: {base_image}\nGApps: {src}\n目标镜像: {tag}")
        })?;

        let dockerfile = work.join("Dockerfile");
        let df = format!("FROM {base_image}\nCOPY overlay/ /system/\n");
        std::fs::write(&dockerfile, df).map_err(|e| e.to_string())?;

        log::info("Docker", &format!("Building GApps image {tag} from {src}"));
        let build = util::run_command_timeout(
            &docker_bin(),
            &[
                "build",
                "-t",
                &tag,
                "-f",
                &dockerfile.to_string_lossy(),
                &work.to_string_lossy(),
            ],
            Duration::from_secs(600),
        );
        if !build.success {
            return Err(format!(
                "GApps 镜像构建失败\n基础镜像: {base_image}\nGApps: {src}\n目标镜像: {tag}\n{}\n{}",
                build.stdout, build.stderr
            ));
        }
        Ok(tag.clone())
    })();

    let _ = std::fs::remove_dir_all(&work);
    built.map_err(|e| {
        if e.contains("目标镜像:") || e.contains("GApps:") {
            e
        } else {
            format!("{e}\n基础镜像: {base_image}\nGApps: {src}\n目标镜像: {tag}")
        }
    })
}

fn gapps_stamp(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{len:x}-{mtime:x}"))
}

fn fnv1a64(data: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Copy a text file stripping CRLF — scripts/rc/conf baked into the Linux
/// image must not carry Windows line endings (sh dies on `\r`).
fn copy_text_normalized(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    let data = std::fs::read(src)?;
    let has_crlf = data.windows(2).any(|w| w == b"\r\n");
    if has_crlf {
        let mut out = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
                i += 1;
                continue;
            }
            out.push(data[i]);
            i += 1;
        }
        std::fs::write(dst, out)
    } else {
        std::fs::write(dst, data)
    }
}

/// Recursive stamp of a directory tree (relative paths + size/mtime stamps).
fn dir_stamp(root: &std::path::Path) -> String {
    fn walk(dir: &std::path::Path, rel: &str, acc: &mut String) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let p = e.path();
                if p.is_dir() {
                    walk(&p, &r, acc);
                } else {
                    acc.push_str(&r);
                    acc.push('=');
                    acc.push_str(&gapps_stamp(&p).unwrap_or_else(|_| "none".into()));
                    acc.push(';');
                }
            }
        }
    }
    let mut acc = String::new();
    walk(root, "", &mut acc);
    format!("{:016x}", fnv1a64(&acc))
}

/// Search dirs for Magisk assets downloaded by scripts/fetch-magisk.ps1.
/// Candidate project roots: the process cwd and, for dev builds (where the
/// binary runs with cwd = src-tauri), successive parents of the exe dir.
/// Asset dirs (vendor/magisk, vendor/gapps, vendor/magisk-overlay) live at
/// the repo root, so a single-level cwd lookup misses them in dev.
pub fn project_root_dirs() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    let mut push = |start: Option<std::path::PathBuf>| {
        let mut cur = start;
        for _ in 0..4 {
            match cur {
                Some(d) => {
                    if !roots.contains(&d) {
                        roots.push(d.clone());
                    }
                    cur = d.parent().map(|x| x.to_path_buf());
                }
                None => break,
            }
        }
    };
    push(std::env::current_dir().ok());
    push(
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|x| x.to_path_buf())),
    );
    roots
}

fn magisk_search_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = project_root_dirs()
        .iter()
        .map(|r| r.join("vendor").join("magisk"))
        .collect();
    if let Some(exe_parent) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|x| x.to_path_buf()))
    {
        dirs.push(exe_parent.join("magisk"));
    }
    dirs
}

/// Subdir that holds the extracted magisk binaries (magisk64 etc.).
fn magisk_bin_dir(root: &str) -> Option<std::path::PathBuf> {
    let root_path = std::path::Path::new(root);
    let nested = root_path.join("magisk");
    if nested.join("magisk").exists() || nested.join("magisk64").exists() {
        return Some(nested);
    }
    if root_path.join("magisk").exists() || root_path.join("magisk64").exists() {
        return Some(root_path.to_path_buf());
    }
    None
}

/// Directory containing the downloaded Magisk assets, or "" when missing.
pub fn resolve_magisk_dir() -> String {
    for dir in magisk_search_dirs() {
        let p = dir.to_string_lossy().to_string();
        if magisk_bin_dir(&p).is_some() {
            return p;
        }
    }
    String::new()
}

pub fn local_magisk_dir() -> String {
    resolve_magisk_dir()
}

/// Committed overlay source (rc + preset scripts + default spoof.conf).
fn resolve_overlay_dir() -> String {
    for root in project_root_dirs() {
        let dir = root.join("vendor").join("magisk-overlay");
        if dir
            .join("system")
            .join("etc")
            .join("init")
            .join("magisk_preset.rc")
            .exists()
        {
            return dir.to_string_lossy().into();
        }
    }
    String::new()
}

/// Find a module zip under `modules_dir` whose filename starts with `prefix`.
fn find_module_zip(modules_dir: &std::path::Path, prefix: &str) -> Option<std::path::PathBuf> {
    std::fs::read_dir(modules_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .map(|e| e.eq_ignore_ascii_case("zip"))
                    .unwrap_or(false)
                && p.file_name()
                    .map(|n| {
                        n.to_string_lossy()
                            .to_ascii_lowercase()
                            .starts_with(prefix)
                    })
                    .unwrap_or(false)
        })
        .min()
}

/// Magisk asset readiness for the create-form gate.
pub fn magisk_assets() -> crate::models::MagiskAssets {
    let dir = resolve_magisk_dir();
    let mut a = crate::models::MagiskAssets {
        magisk_dir: dir.clone(),
        ..Default::default()
    };
    if dir.is_empty() {
        a.message = "未找到 vendor/magisk，请先运行 .\\scripts\\fetch-magisk.ps1".into();
        return a;
    }
    if let Some(bin) = magisk_bin_dir(&dir) {
        a.magisk_ok =
            (bin.join("magisk").exists() || bin.join("magisk64").exists())
                && bin.join("magiskpolicy").exists()
                && bin.join("magisk.apk").exists();
    }
    let modules = std::path::Path::new(&dir).join("modules");
    a.lsposed_ok = find_module_zip(&modules, "lsposed").is_some();
    a.shamiko_ok = find_module_zip(&modules, "shamiko").is_some();
    if !a.magisk_ok {
        a.message =
            "Magisk 二进制不完整（缺 magiskpolicy/magisk.apk），请重跑 .\\scripts\\fetch-magisk.ps1".into();
    }
    a
}

/// Build (or reuse) a derived Redroid image with the Magisk preset
/// (magiskd + Zygisk + optional LSPosed/Shamiko modules + spoof props).
/// Also carries the GApps overlay when `install_gapps` is set.
fn ensure_preset_image(req: &CreateInstanceRequest, base_image: &str) -> Result<String, String> {
    let magisk_root = resolve_magisk_dir();
    if magisk_root.is_empty() {
        return Err(
            "已勾选预装 Magisk，但未找到 vendor/magisk 资产目录。\n请先运行 .\\scripts\\fetch-magisk.ps1（Magisk fork APK + LSPosed + Shamiko，均不进 Git）。".into(),
        );
    }
    let Some(bin_src) = magisk_bin_dir(&magisk_root) else {
        return Err(format!(
            "vendor/magisk 里找不到 magisk64 二进制。\n请重跑 .\\scripts\\fetch-magisk.ps1。\n目录: {magisk_root}"
        ));
    };
    let overlay_src = resolve_overlay_dir();
    if overlay_src.is_empty() {
        return Err(
            "未找到 vendor/magisk-overlay（镜像内 init rc 与首启脚本）。请检查项目文件完整性。".into(),
        );
    }
    let modules_src = std::path::Path::new(&magisk_root).join("modules");

    let mut module_zips: Vec<std::path::PathBuf> = Vec::new();
    if req.install_lsposed {
        let zip = find_module_zip(&modules_src, "lsposed").ok_or_else(|| {
            "已勾选 LSPosed，但 vendor/magisk/modules 下没有 lsposed-*.zip。\n请运行 .\\scripts\\fetch-magisk.ps1。".to_string()
        })?;
        module_zips.push(zip);
    }
    if req.install_shamiko {
        let zip = find_module_zip(&modules_src, "shamiko").ok_or_else(|| {
            "已勾选 Shamiko，但 vendor/magisk/modules 下没有 shamiko-*.zip。\n请运行 .\\scripts\\fetch-magisk.ps1。".to_string()
        })?;
        module_zips.push(zip);
    }

    // Optional spoof profile override (else the bundled default is baked in).
    let spoof_conf = {
        let p = req.spoof_profile.trim();
        if !p.is_empty() {
            let path = std::path::Path::new(p);
            if !path.exists() {
                return Err(format!("伪装配置文件不存在: {p}"));
            }
            path.to_path_buf()
        } else {
            std::path::Path::new(&overlay_src).join("system/etc/init/magisk/spoof.conf")
        }
    };

    // Stamp = everything that changes the derived image.
    let mut stamp_srcs: Vec<String> = vec![
        base_image.to_string(),
        format!("magisk={}", gapps_stamp(&bin_src.join("magisk.apk")).unwrap_or_default()),
        format!("conf={}", gapps_stamp(&spoof_conf).unwrap_or_default()),
        format!("gapps={}", req.install_gapps),
        format!("lsposed={}", req.install_lsposed),
        format!("shamiko={}", req.install_shamiko),
        dir_stamp(&std::path::Path::new(&overlay_src).join("system")),
    ];
    for z in &module_zips {
        stamp_srcs.push(gapps_stamp(z).unwrap_or_default());
    }
    let stamp = format!("{:016x}", fnv1a64(&stamp_srcs.join("|")));
    let tag_safe = base_image
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let tag = format!("rdc-preset:{tag_safe}-{stamp}");
    if image_exists(&tag) {
        log::info("Docker", &format!("Reusing Magisk preset image {tag}"));
        return Ok(tag);
    }

    let work = std::env::temp_dir().join(format!("rdc-preset-{}", util::now_millis()));
    util::ensure_dir(&work.to_string_lossy());
    let built = (|| {
        let ctx_bin = work.join("bin");
        let ctx_data = work.join("data");
        let ctx_etc = work.join("etc");
        let ctx_modules = work.join("modules");
        let ctx_overlay = work.join("overlay");
        for d in [&ctx_bin, &ctx_data, &ctx_etc, &ctx_modules, &ctx_overlay] {
            util::ensure_dir(&d.to_string_lossy());
        }

        // 1. GApps overlay (optional)
        if req.install_gapps {
            let zip = resolve_gapps_zip(req.gapps_zip.trim(), base_image);
            if zip.is_empty() {
                return Err(
                    "已勾选预装 Google 套件，但未指定本地 zip。请在创建设置或「设置 → GApps zip」中填写路径（MindTheGapps，需自行下载）。".into(),
                );
            }
            let src_path = std::path::Path::new(&zip);
            if !src_path.exists() {
                return Err(format!("GApps 路径不存在: {zip}\n基础镜像: {base_image}"));
            }
            let extracted = if src_path.is_dir() {
                src_path.to_path_buf()
            } else {
                let dest = work.join("extract");
                util::ensure_dir(&dest.to_string_lossy());
                extract_archive(src_path, &dest)?;
                dest
            };
            if looks_like_opengapps(&extracted) {
                return Err(
                    "当前是 OpenGApps 压缩包（含 Core/ 分卷），本机暂不自动处理。请改用 MindTheGapps zip 或解出的 system 目录。".into(),
                );
            }
            let system = find_system_overlay(&extracted).ok_or_else(|| {
                "zip/目录里找不到 system/app、system/priv-app 或 system/product。请使用 MindTheGapps。".to_string()
            })?;
            copy_dir_all(&system, &ctx_overlay).map_err(|e| format!("复制 GApps overlay 失败: {e}"))?;
        }

        // 2. Magisk binaries from the fetched assets (need the exec bit → COPY --chmod=755)
        for name in [
            "magisk",
            "magisk64",
            "magisk32",
            "magiskpolicy",
            "magiskboot",
            "busybox",
            "magiskinit",
            "init-ld",
        ] {
            let src = bin_src.join(name);
            if src.exists() {
                std::fs::copy(&src, ctx_bin.join(name)).map_err(|e| e.to_string())?;
            }
        }
        // 2b. Overlay scripts from the committed overlay source (normalize CRLF —
        // Windows checkouts must not carry \r into the image or sh breaks).
        let overlay_magisk = std::path::Path::new(&overlay_src).join("system/etc/init/magisk");
        for name in ["magisk_preset.sh", "rdc_apply_spoof.sh"] {
            let src = overlay_magisk.join(name);
            if src.exists() {
                copy_text_normalized(&src, &ctx_bin.join(name)).map_err(|e| e.to_string())?;
            }
        }
        if !ctx_bin.join("magisk").exists() && !ctx_bin.join("magisk64").exists() {
            return Err(format!(
                "Magisk 资产缺少 magisk 主二进制（来源 {}）。\n请重跑 scripts/fetch-magisk.ps1。",
                bin_src.display()
            ));
        }
        for required in ["magiskpolicy", "busybox", "magisk_preset.sh", "rdc_apply_spoof.sh"] {
            if !ctx_bin.join(required).exists() {
                return Err(format!(
                    "Magisk 资产缺少 {required}（来源 {}）。\n请重跑 .\\scripts\\fetch-magisk.ps1。",
                    bin_src.display()
                ));
            }
        }

        // 3. Data files (no exec bit needed)
        std::fs::copy(bin_src.join("magisk.apk"), ctx_data.join("magisk.apk"))
            .map_err(|e| e.to_string())?;
        // stub.apk: same-cert trust anchor for the daemon's check-signature
        // build. --setup-sbin copies it into /sbin where preserve_stub_apk
        // derives trusted_cert from it — without it, every manager install is
        // judged a signature mismatch and uninstalled within a minute.
        std::fs::copy(bin_src.join("stub.apk"), ctx_data.join("stub.apk"))
            .map_err(|e| e.to_string())?;
        let util_fn = bin_src.join("util_functions.sh");
        if util_fn.exists() {
            copy_text_normalized(&util_fn, &ctx_data.join("util_functions.sh")).map_err(|e| e.to_string())?;
        }
        copy_text_normalized(&spoof_conf, &ctx_data.join("spoof.conf")).map_err(|e| e.to_string())?;

        // 4. init rc
        copy_text_normalized(
            &std::path::Path::new(&overlay_src).join("system/etc/init/magisk_preset.rc"),
            &ctx_etc.join("magisk_preset.rc"),
        )
        .map_err(|e| e.to_string())?;

        // 5. Selected module zips
        for z in &module_zips {
            let name = z.file_name().unwrap_or_default();
            std::fs::copy(z, ctx_modules.join(name)).map_err(|e| e.to_string())?;
        }

        // NOTE: requires BuildKit (Docker Desktop default) for COPY --chmod.
        let dockerfile = work.join("Dockerfile");
        std::fs::write(
            &dockerfile,
            format!(
                "FROM {base_image}\n\
                 COPY overlay/ /system/\n\
                 COPY data/ /system/etc/init/magisk/\n\
                 COPY --chmod=755 bin/ /system/etc/init/magisk/\n\
                 COPY etc/ /system/etc/init/\n\
                 COPY modules/ /system/etc/init/magisk/modules/\n"
            ),
        )
        .map_err(|e| e.to_string())?;

        log::info("Docker", &format!("Building Magisk preset image {tag}"));
        let build = util::run_command_timeout(
            &docker_bin(),
            &[
                "build",
                "-t",
                &tag,
                "-f",
                &dockerfile.to_string_lossy(),
                &work.to_string_lossy(),
            ],
            Duration::from_secs(600),
        );
        if !build.success {
            return Err(format!(
                "Magisk 定制镜像构建失败\n目标镜像: {tag}\n{} {}\n（提示：COPY --chmod 需要 Docker BuildKit，Docker Desktop 默认开启）",
                build.stdout, build.stderr
            ));
        }
        Ok(tag.clone())
    })();

    let _ = std::fs::remove_dir_all(&work);
    built.map_err(|e| {
        if e.contains("目标镜像:") {
            e
        } else {
            format!("{e}\n目标镜像: {tag}")
        }
    })
}

/// Post-first-boot activation: write denylist targets, restart once so
/// Zygisk + installed modules take effect at zygote start.
fn magisk_first_boot_activation(
    container_name: &str,
    req: &CreateInstanceRequest,
    serial: &str,
) -> Result<String, String> {
    // The spoof turns the instance into a realistic user build
    // (ro.debuggable=0), which makes adbd require RSA auth — a headless
    // container can never confirm the on-device dialog, so ADB stays
    // unauthorized forever. Pre-trust this machine's adb key (the equivalent
    // of tapping "Always allow" on a real device); adbd picks the file up
    // via inotify and the key persists on the data volume.
    inject_host_adb_key(container_name);

    if !req.hide_packages.is_empty() {
        let list = req
            .hide_packages
            .iter()
            .map(|p| p.trim())
            .filter(|p| {
                !p.is_empty()
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$')
            })
            .collect::<Vec<_>>();
        if !list.is_empty() {
            let script = format!(
                "mkdir -p /data/adb && printf '{}\\n' {} | sort -u > /data/adb/rdc_target_packages.txt",
                "%s",
                list.join(" ")
            );
            let r = util::run_command_timeout(
                &docker_bin(),
                &["exec", container_name, "sh", "-c", &script],
                Duration::from_secs(20),
            );
            if !r.success {
                return Err(format!("写入 denylist 目标包失败: {}", r.stderr));
            }
        }
    }

    set_create_stage("等待 Magisk 首启配置完成（模块安装等，最长约 4 分钟）…");
    if !wait_preset_done(container_name, Duration::from_secs(240)) {
        log::warn(
            "Docker",
            &format!(
                "preset done marker not observed for {container_name} within timeout; restarting anyway"
            ),
        );
    }

    set_create_stage("重启容器以激活 Zygisk / 模块（Magisk 首启配置）…");
    let restart = util::run_command_timeout(
        &docker_bin(),
        &["restart", container_name],
        Duration::from_secs(60),
    );
    if !restart.success {
        return Err(format!("容器重启失败: {}", restart.stderr));
    }
    set_create_stage(&format!("等待重启完成 {serial}（最长约 4 分钟）…"));
    let ready = adb::wait_ready(serial, Duration::from_secs(240));
    if !ready.success {
        return Err(format!("重启后 ADB 未就绪: {}", ready.stderr));
    }
    Ok("Magisk 首启配置完成（Zygisk/模块/伪装已应用，详见容器内 /data/adb/rdc_preset.log）".into())
}

/// Headless boots idle into screen-off after the lock timeout, which shows as
/// a black scrcpy window until someone sends a keypress. Keep the display on
/// while "plugged" (a container always is) and wake it once so the first
/// screen share lands on the lit desktop. Best-effort; idempotent.
fn first_boot_screen_on(serial: &str) {
    let script = "settings put global stay_on_while_plugged_in 7; \
                  svc power stayon true 2>/dev/null; \
                  input keyevent KEYCODE_WAKEUP; true";
    let r = adb::shell_timeout(serial, script, Duration::from_secs(20));
    if r.success {
        log::info("Docker", &format!("已点亮并保持 {serial} 屏幕常亮（stay_on_while_plugged_in=7）"));
    } else {
        log::warn("Docker", &format!("屏幕常亮设置未确认（{serial}）：{}", r.stderr));
    }
}

/// On GApps images the GMS setup wizard is the HOME activity until the device
/// is marked provisioned — and it cannot run in a headless container: it
/// crashes in a loop (WifiService SecurityException from its WiFi tracker on
/// redroid), leaving scrcpy an eternal black screen with only the status/nav
/// bars. Mark the device provisioned and retire the wizard so Launcher3
/// becomes HOME. Idempotent; both flags and the disabled state persist on the
/// data volume.
/// Core provisioning script, shared by the create flow (which shows stage
/// progress) and the clone flow (fresh data volume, no stage UI). The nohup
/// loop re-asserts the verifier switches for ~4 minutes: Finsky writes
/// package_verifier_enable back to 1 during GMS first-boot init, which would
/// otherwise resurrect the adb-install hang on clones provisioned early.
fn apply_headless_gapps_provisioning(serial: &str) -> ShellResult {
    let script = "settings put secure user_setup_complete 1; \
                  settings put global device_provisioned 1; \
                  pm disable-user --user 0 com.google.android.setupwizard 2>/dev/null; \
                  settings put global package_verifier_enable 0; \
                  settings put global verifier_verify_adb_installs 0; \
                  settings put global verifier_verify_adb_installs_coefficient 0; \
                  nohup sh -c 'i=0; while [ $i -lt 5 ]; do sleep 45; \
                    settings put global package_verifier_enable 0; \
                    settings put global verifier_verify_adb_installs 0; \
                    i=$((i+1)); done' >/dev/null 2>&1 & true";
    adb::shell_timeout(serial, script, Duration::from_secs(30))
}

fn skip_first_boot_provisioning(serial: &str) {
    set_create_stage("跳过 GMS 开机向导（无头容器无法完成向导 UI）…");
    let r = apply_headless_gapps_provisioning(serial);
    if r.success {
        log::info(
            "Docker",
            &format!("已跳过 {serial} 的 GMS 开机向导，并关闭 Play 安装时验证（无头环境无法响应验证会话，会导致 adb install 挂死）"),
        );
    } else {
        log::warn(
            "Docker",
            &format!("跳过 GMS 开机向导未确认（{serial}）：{}", r.stderr),
        );
    }
}

/// Write this machine's adb public key into the container's
/// /data/misc/adb/adb_keys so adbd trusts it despite the user-build spoof
/// enforcing RSA auth. Idempotent; safe to call on every activation.
fn inject_host_adb_key(container_name: &str) {
    let Some(pubkey) = host_adb_pubkey() else {
        log::warn(
            "Docker",
            "未找到宿主机 adb 公钥（~/.android/adbkey.pub），伪装后的 user 构建可能无法 ADB 授权",
        );
        return;
    };
    let script = format!(
        "mkdir -p /data/misc/adb; grep -qF '{pubkey}' /data/misc/adb/adb_keys 2>/dev/null \
         || echo '{pubkey}' >> /data/misc/adb/adb_keys; \
         chown system:shell /data/misc/adb/adb_keys 2>/dev/null; \
         chmod 640 /data/misc/adb/adb_keys 2>/dev/null; true"
    );
    let r = util::run_command_timeout(
        &docker_bin(),
        &["exec", container_name, "sh", "-c", &script],
        Duration::from_secs(20),
    );
    if r.success {
        log::info("Docker", &format!("已注入宿主机 ADB 公钥到 {container_name}（user 构建授权）"));
    } else {
        log::warn(
            "Docker",
            &format!("ADB 公钥注入失败: {}", r.stderr.trim()),
        );
    }
}

fn host_adb_pubkey() -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let path = std::path::Path::new(&home)
        .join(".android")
        .join("adbkey.pub");
    let content = std::fs::read_to_string(path).ok()?;
    let line = content.lines().next()?.trim().to_string();
    // A pubkey line is base64 + " user@host" — no quotes; reject anything
    // that could break the single-quoted shell literal.
    if line.is_empty() || line.contains('\'') || line.contains('\n') {
        return None;
    }
    Some(line)
}

/// Poll for the first-boot preset completion marker inside the container.
/// Restarting before preset.sh finishes would kill module installs mid-way.
fn wait_preset_done(container_name: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        let r = util::run_command_timeout(
            &docker_bin(),
            &[
                "exec",
                container_name,
                "test",
                "-f",
                "/data/adb/.rdc_preset_done",
            ],
            Duration::from_secs(10),
        );
        if r.success {
            return true;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    false
}

fn extract_archive(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    extract_zip_native(zip_path, dest).or_else(|native_err| {
        log::warn("Docker", &format!("native unzip failed, fallback: {native_err}"));
        extract_zip_external(zip_path, dest).map_err(|ext_err| {
            format!("解压 GApps 失败。内置解压: {native_err}；系统解压: {ext_err}")
        })
    })
}

fn extract_zip_native(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out = dest.join(rel);
        if entry.is_dir() || entry.name().ends_with('/') {
            util::ensure_dir(&out.to_string_lossy());
            continue;
        }
        if let Some(parent) = out.parent() {
            util::ensure_dir(&parent.to_string_lossy());
        }
        let mut outfile = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_zip_external(zip: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let zip_s = zip.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();
    let r = if cfg!(target_os = "windows") {
        util::run_command_timeout(
            "tar",
            &["-xf", &zip_s, "-C", &dest_s],
            Duration::from_secs(180),
        )
    } else {
        util::run_command_timeout("unzip", &["-oq", &zip_s, "-d", &dest_s], Duration::from_secs(180))
    };
    if r.success {
        Ok(())
    } else {
        Err(format!("{} {}", r.stdout, r.stderr))
    }
}

fn looks_like_opengapps(root: &std::path::Path) -> bool {
    root.join("Core").is_dir()
        || std::fs::read_dir(root)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .any(|e| e.path().join("Core").is_dir())
}

fn find_system_overlay(root: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::collections::VecDeque;
    let mut q = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = q.pop_front() {
        if is_system_tree(&dir) {
            return Some(dir);
        }
        let nested = dir.join("system");
        if is_system_tree(&nested) {
            return Some(nested);
        }
        if depth >= 5 {
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    q.push_back((e.path(), depth + 1));
                }
            }
        }
    }
    None
}

fn is_system_tree(dir: &std::path::Path) -> bool {
    // The directory that should be copied onto /system
    dir.join("priv-app").is_dir()
        || dir.join("app").is_dir()
        || dir.join("product").join("priv-app").is_dir()
        || dir.join("product").join("app").is_dir()
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

pub fn start_container(id_or_name: &str) -> ShellResult {
    log::info("Docker", &format!("Starting container {}", id_or_name));
    let mut r = util::run_command_timeout(&docker_bin(), &["start", id_or_name], Duration::from_secs(30));
    cache::invalidate_docker();
    cache::invalidate_devices();
    if r.success {
        let ready = wait_container_adb(id_or_name, Duration::from_secs(180));
        r.stdout = format!("{}\n{}", r.stdout.trim(), ready.stdout.trim())
            .trim()
            .to_string();
        if !ready.success {
            r.success = false;
            r.stderr = ready.stderr;
            r.exit_code = ready.exit_code;
        }
    }
    r
}

pub fn stop_container(id_or_name: &str) -> ShellResult {
    log::info("Docker", &format!("Stopping container {}", id_or_name));
    let r = util::run_command_timeout(&docker_bin(), &["stop", id_or_name], Duration::from_secs(20));
    cache::invalidate_docker();
    cache::invalidate_devices();
    r
}

pub fn restart_container(id_or_name: &str) -> ShellResult {
    log::info("Docker", &format!("Restarting container {}", id_or_name));
    let mut r = util::run_command_timeout(&docker_bin(), &["restart", id_or_name], Duration::from_secs(40));
    cache::invalidate_docker();
    cache::invalidate_devices();
    if r.success {
        let ready = wait_container_adb(id_or_name, Duration::from_secs(180));
        r.stdout = format!("{}\n{}", r.stdout.trim(), ready.stdout.trim())
            .trim()
            .to_string();
        if !ready.success {
            r.success = false;
            r.stderr = ready.stderr;
            r.exit_code = ready.exit_code;
        }
    }
    r
}

pub fn remove_container(id_or_name: &str, force: bool) -> ShellResult {
    log::info("Docker", &format!("Removing container {}", id_or_name));
    let r = if force {
        util::run_command_timeout(&docker_bin(), &["rm", "-f", id_or_name], Duration::from_secs(30))
    } else {
        util::run_command_timeout(&docker_bin(), &["rm", id_or_name], Duration::from_secs(20))
    };
    cache::invalidate_docker();
    cache::invalidate_devices();
    r
}

pub fn rename_container(id_or_name: &str, new_name: &str) -> ShellResult {
    let name = format!("rdc-{}", sanitize_name(new_name));
    if name == "rdc-" {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "新名称无效".into(),
            exit_code: -1,
        };
    }
    let conflict = list_containers(true).iter().any(|c| {
        let n = c.name.trim_start_matches('/');
        let is_self = c.id == id_or_name
            || c.id.starts_with(id_or_name)
            || id_or_name.starts_with(&c.id)
            || n == id_or_name.trim_start_matches('/')
            || c.name == id_or_name;
        n == name && !is_self
    });
    if conflict {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("名称已被占用: {}", name),
            exit_code: -1,
        };
    }
    let r = util::run_command(&docker_bin(), &["rename", id_or_name, &name]);
    cache::invalidate_docker();
    cache::invalidate_devices();
    r
}

pub fn clone_container(id_or_name: &str, new_name: &str) -> ShellResult {
    log::info("Docker", &format!("Cloning container {} -> {}", id_or_name, new_name));
    let sanitized = sanitize_name(new_name);
    if sanitized.is_empty() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "克隆名称无效".into(),
            exit_code: -1,
        };
    }
    if container_name_taken(new_name) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("名称已存在: rdc-{}", sanitized),
            exit_code: -1,
        };
    }
    let commit = util::run_command_timeout(
        &docker_bin(),
        &["commit", id_or_name, &format!("rdc-clone-{}", sanitized)],
        Duration::from_secs(180),
    );
    if !commit.success {
        return commit;
    }
    let image_id = commit.stdout.trim().to_string();
    let name = format!("rdc-{}", sanitized);
    let volume = data_volume_name(&sanitized);
    let volume_map = format!("{volume}:/data");
    let _ = util::run_command_timeout(
        &docker_bin(),
        &["volume", "create", &volume],
        Duration::from_secs(20),
    );
    let port = next_free_adb_port();
    let port_map = format!("127.0.0.1:{}:5555", port);
    // Inherit the source container's resource caps — without them the clone
    // silently widens to the whole Docker VM.
    let (mem_bytes, cpus) = container_resource_limits(id_or_name);
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        name,
        "--privileged".into(),
    ];
    if cpus > 0.0 {
        args.push("--cpus".into());
        args.push(format!("{cpus}"));
    }
    if mem_bytes > 0 {
        args.push("--memory".into());
        args.push(mem_bytes.to_string());
    }
    args.extend([
        "-v".into(),
        volume_map,
        "-p".into(),
        port_map,
        image_id,
        "androidboot.redroid_gpu_mode=guest".into(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut r = util::run_command_timeout(&docker_bin(), &arg_refs, Duration::from_secs(120));
    let run_ok = r.success;
    if r.success {
        let serial = format!("127.0.0.1:{port}");
        let ready = adb::wait_ready(&serial, Duration::from_secs(180));
        r.stdout = format!(
            "{}\n数据卷: {volume}\nADB: 127.0.0.1:{port}\n{}",
            r.stdout.trim(),
            ready.stdout.trim()
        )
        .trim()
        .to_string();
        if ready.success {
            first_boot_screen_on(&serial);
            // The clone boots with an empty data volume, so every headless-boot
            // fix that lives in /data is gone. Re-apply when the committed
            // image carries GApps (setupwizard present).
            let wizard = adb::shell(&serial, "pm path com.google.android.setupwizard");
            if wizard.success && wizard.stdout.contains("package:") {
                apply_headless_gapps_provisioning(&serial);
                log::info("Docker", &format!("克隆实例 {serial} 携带 GApps，已重放无头引导修复"));
            }
            // Magisk preset replay: modules, spoof, denylist and the manager
            // apps live on the source's data volume; the clone boots a fresh
            // one. The baked rc re-runs the preset script (installs modules
            // from the image, enables Zygisk, spoofs props), but Zygisk needs
            // one more container restart to actually inject the zygote.
            let has_magisk = util::run_command_timeout(
                &docker_bin(),
                &["exec", &format!("rdc-{sanitized}"), "sh", "-c", "test -f /system/etc/init/magisk/magisk && echo yes"],
                Duration::from_secs(15),
            );
            if has_magisk.success && has_magisk.stdout.contains("yes") {
                let src_dl = util::run_command_timeout(
                    &docker_bin(),
                    &["exec", id_or_name, "sh", "-c",
                      "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --denylist ls 2>/dev/null"],
                    Duration::from_secs(20),
                );
                if src_dl.success {
                    let pkgs: Vec<String> = src_dl
                        .stdout
                        .lines()
                        .map(|l| l.trim().split('|').next().unwrap_or("").trim().to_string())
                        .filter(|p| {
                            !p.is_empty()
                                && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
                        })
                        .collect();
                    if !pkgs.is_empty() {
                        let script = format!(
                            "printf '%s\\n' {} > /data/adb/rdc_target_packages.txt",
                            pkgs.join(" ")
                        );
                        let _ = util::run_command_timeout(
                            &docker_bin(),
                            &["exec", &format!("rdc-{sanitized}"), "sh", "-c", &script],
                            Duration::from_secs(15),
                        );
                        log::info(
                            "Docker",
                            &format!("克隆实例 {serial} 继承 denylist {} 项（重启后由预设脚本应用）", pkgs.len()),
                        );
                    }
                }
                // Wholesale-copy the source's Magisk + LSPosed config
                // databases: su policies, the full denylist table, Zygisk
                // settings and LSPosed module scope all live there. This
                // supersedes the txt replay above (kept as a fallback for
                // preset images whose script predates the db copy). The
                // daemons are killed first and the clone restarts right
                // after, so no live writer races the replacement.
                let dst = format!("rdc-{sanitized}");
                let _ = util::run_command_timeout(
                    &docker_bin(),
                    &["exec", &dst, "sh", "-c",
                      "kill $(pidof lspd) 2>/dev/null; kill $(pidof magiskd magisk64) 2>/dev/null; sleep 1; echo killed"],
                    Duration::from_secs(15),
                );
                let mut inherited = Vec::new();
                for db in ["/data/adb/magisk.db", "/data/adb/lspd/config/modules_config.db"] {
                    if copy_db_into(id_or_name, &dst, db) {
                        inherited.push(db);
                    }
                }
                if !inherited.is_empty() {
                    log::info(
                        "Docker",
                        &format!("克隆实例 {serial} 继承配置库: {}", inherited.join(", ")),
                    );
                }
                log::info("Docker", &format!("重启克隆实例 {serial} 以激活 Zygisk / 模块（约 1-3 分钟）…"));
                let _ = util::run_command_timeout(
                    &docker_bin(),
                    &["restart", &format!("rdc-{sanitized}")],
                    Duration::from_secs(120),
                );
                let ready2 = adb::wait_ready(&serial, Duration::from_secs(180));
                if ready2.success {
                    first_boot_screen_on(&serial);
                    r.stdout = format!("{}\nMagisk 预设已重放（Zygisk/模块/伪装/denylist）", r.stdout.trim()).trim().to_string();
                } else {
                    r.success = false;
                    r.stderr = ready2.stderr;
                    r.exit_code = ready2.exit_code;
                }
            }
        } else {
            r.success = false;
            r.stderr = ready.stderr;
            r.exit_code = ready.exit_code;
        }
    }
    if !run_ok {
        // The container never started (port conflict etc.) — don't leak the
        // multi-GB image the commit step produced.
        let _ = util::run_command_timeout(
            &docker_bin(),
            &["rmi", "-f", &format!("rdc-clone-{sanitized}")],
            Duration::from_secs(60),
        );
    }
    r
}

/// Copy a SQLite db (plus its -wal sidecar) from the source container into
/// the clone. Binary bytes go through `docker exec -i sh -c 'cat > path'`
/// stdin pipes — `docker cp` fails on the container's read-only overlay.
pub fn copy_db_into(src: &str, dst: &str, path: &str) -> bool {
    let dir = match path.rfind('/') {
        Some(i) => &path[..i],
        None => "/",
    };
    let mut copied = false;
    for suffix in ["", "-wal"] {
        let p = format!("{path}{suffix}");
        let data = util::run_command_bytes(&docker_bin(), &["exec", src, "cat", &p], Duration::from_secs(20));
        let data = match data {
            Ok(d) if !d.is_empty() => d,
            _ => continue,
        };
        let cmd = format!("mkdir -p '{dir}' && cat > '{p}'");
        let r = util::run_command_stdin(
            &docker_bin(),
            &["exec", "-i", dst, "sh", "-c", &cmd],
            &data,
            Duration::from_secs(20),
        );
        copied |= r.success;
    }
    copied
}

pub fn inspect(id_or_name: &str) -> ShellResult {
    util::run_command(&docker_bin(), &["inspect", id_or_name])
}

/// Resource caps from `docker inspect`: (memory bytes, cpus). (0, 0.0) when
/// unset — a container without caps shares the whole Docker VM.
pub fn container_resource_limits(id_or_name: &str) -> (u64, f64) {
    let r = util::run_command_timeout(
        &docker_bin(),
        &["inspect", id_or_name],
        Duration::from_secs(20),
    );
    if !r.success {
        return (0, 0.0);
    }
    let parsed: serde_json::Value = match serde_json::from_str(r.stdout.trim()) {
        Ok(v) => v,
        Err(_) => return (0, 0.0),
    };
    let Some(hc) = parsed
        .as_array()
        .and_then(|a| a.first())
        .and_then(|c| c.get("HostConfig"))
    else {
        return (0, 0.0);
    };
    let mem = hc.get("Memory").and_then(|x| x.as_u64()).unwrap_or(0);
    let nano = hc.get("NanoCpus").and_then(|x| x.as_u64()).unwrap_or(0);
    (mem, nano as f64 / 1_000_000_000.0)
}

pub fn container_logs(id_or_name: &str, tail: u32) -> ShellResult {
    let n = tail.clamp(20, 500).to_string();
    util::run_command_timeout(
        &docker_bin(),
        &["logs", "--tail", &n, id_or_name],
        Duration::from_secs(25),
    )
}

pub fn list_volumes() -> Vec<DockerVolume> {
    let r = util::run_command_timeout(
        &docker_bin(),
        &[
            "volume",
            "ls",
            "--format",
            "{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}",
        ],
        Duration::from_secs(15),
    );
    if !r.success {
        return vec![];
    }
    let used = volume_usage_map();
    let sizes = volume_size_map();
    r.stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let p: Vec<&str> = line.split('\t').collect();
            let name = p.first().unwrap_or(&"").to_string();
            let is_rdc = name.starts_with("rdc-") && name.ends_with("-data");
            let (container_name, adb_serial) = used.get(&name).cloned().unwrap_or_default();
            DockerVolume {
                in_use: !container_name.is_empty(),
                is_rdc,
                driver: p.get(1).unwrap_or(&"").to_string(),
                mountpoint: p.get(2).unwrap_or(&"").to_string(),
                size: sizes.get(&name).cloned().unwrap_or_default(),
                container_name,
                adb_serial,
                name,
            }
        })
        .collect()
}

fn volume_size_map() -> std::collections::HashMap<String, String> {
    let r = util::run_command_timeout(
        &docker_bin(),
        &["system", "df", "-v", "--format", "{{.Name}}\t{{.Size}}"],
        Duration::from_secs(20),
    );
    let mut map = std::collections::HashMap::new();
    if !r.success {
        return map;
    }
    for line in r.stdout.lines() {
        let mut it = line.split('\t');
        if let (Some(name), Some(size)) = (it.next(), it.next()) {
            if !name.is_empty() && !size.is_empty() {
                map.insert(name.to_string(), size.trim().to_string());
            }
        }
    }
    // Fallback: parse default `docker system df -v` table if --format ignored
    if map.is_empty() {
        let raw = util::run_command_timeout(
            &docker_bin(),
            &["system", "df", "-v"],
            Duration::from_secs(20),
        );
        let mut in_volumes = false;
        for line in raw.stdout.lines() {
            if line.starts_with("VOLUME NAME") {
                in_volumes = true;
                continue;
            }
            if in_volumes {
                if line.is_empty() || line.starts_with("Build cache") {
                    break;
                }
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 3 {
                    map.insert(cols[0].to_string(), cols[2].to_string());
                }
            }
        }
    }
    map
}

fn volume_usage_map() -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();
    for c in list_containers(true) {
        let mounts = util::run_command_timeout(
            &docker_bin(),
            &[
                "inspect",
                "-f",
                "{{range .Mounts}}{{.Name}} {{end}}",
                &c.id,
            ],
            Duration::from_secs(8),
        );
        if !mounts.success {
            continue;
        }
        let serial = extract_container_host_port(&c.ports)
            .map(|p| format!("127.0.0.1:{p}"))
            .unwrap_or_default();
        for token in mounts.stdout.split_whitespace() {
            if token.starts_with("rdc-") && token.ends_with("-data") {
                map.insert(token.to_string(), (c.name.clone(), serial.clone()));
            }
        }
    }
    map
}

pub fn prune_dangling_images() -> ShellResult {
    log::info("Docker", "Pruning dangling images");
    let r = util::run_command_timeout(
        &docker_bin(),
        &["image", "prune", "-f"],
        Duration::from_secs(60),
    );
    cache::invalidate_docker();
    r
}

pub fn remove_image(id_or_ref: &str, force: bool) -> ShellResult {
    let target = id_or_ref.trim();
    if target.is_empty() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "镜像无效".into(),
            exit_code: -1,
        };
    }
    log::info("Docker", &format!("Removing image {target}"));
    let mut args = vec!["rmi"];
    if force {
        args.push("-f");
    }
    args.push(target);
    let r = util::run_command_timeout(&docker_bin(), &args, Duration::from_secs(60));
    cache::invalidate_docker();
    r
}

pub fn remove_volume(name: &str, force: bool) -> ShellResult {
    if name.trim().is_empty() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "卷名无效".into(),
            exit_code: -1,
        };
    }
    log::info("Docker", &format!("Removing volume {name}"));
    let r = if force {
        util::run_command_timeout(
            &docker_bin(),
            &["volume", "rm", "-f", name],
            Duration::from_secs(20),
        )
    } else {
        util::run_command_timeout(
            &docker_bin(),
            &["volume", "rm", name],
            Duration::from_secs(20),
        )
    };
    cache::invalidate_docker();
    r
}

pub fn export_config(id_or_name: &str, path: &str) -> Result<String, String> {
    let r = inspect(id_or_name);
    if !r.success {
        return Err(r.stderr);
    }
    std::fs::write(path, &r.stdout).map_err(|e| e.to_string())?;
    Ok(path.to_string())
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ContainerStats {
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub memory_total_mb: u64,
    pub memory_used_mb: u64,
}

fn parse_stats_percent(value: &str) -> Option<f64> {
    let parsed = value.trim().trim_end_matches('%').parse::<f64>().ok()?;
    if parsed.is_finite() && parsed >= 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn parse_stats_bytes(value: &str) -> Option<u64> {
    let token = value.trim().split_whitespace().next()?;
    let split = token
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(token.len());
    let number = token[..split].parse::<f64>().ok()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let multiplier = match token[split..].to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "kb" | "kib" => 1024.0,
        "mb" | "mib" => 1024.0 * 1024.0,
        "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    let bytes = number * multiplier;
    if bytes > u64::MAX as f64 {
        None
    } else {
        Some(bytes.round() as u64)
    }
}

fn parse_container_stats_line(line: &str) -> Option<ContainerStats> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 3 {
        return None;
    }
    let cpu_usage = parse_stats_percent(parts[0])?;
    let memory_usage = parse_stats_percent(parts[2])?.clamp(0.0, 100.0);
    let memory_parts: Vec<&str> = parts[1].split('/').collect();
    if memory_parts.len() < 2 {
        return None;
    }
    let memory_used_mb = parse_stats_bytes(memory_parts[0])? / 1024 / 1024;
    let memory_total_mb = parse_stats_bytes(memory_parts[1])? / 1024 / 1024;
    Some(ContainerStats {
        cpu_usage,
        memory_usage,
        memory_total_mb,
        memory_used_mb,
    })
}

#[allow(dead_code)]
fn parse_stats_summary_line(line: &str) -> Option<(f64, f64)> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 2 {
        return None;
    }
    Some((
        parse_stats_percent(parts[0]).unwrap_or(0.0),
        parse_stats_percent(parts[1]).unwrap_or(0.0),
    ))
}

pub fn container_stats(id_or_name: &str) -> Option<ContainerStats> {
    if id_or_name.trim().is_empty() {
        return None;
    }
    let r = util::run_command_timeout(
        &docker_bin(),
        &[
            "stats",
            "--no-stream",
            "--format",
            "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
            id_or_name,
        ],
        Duration::from_secs(8),
    );
    if !r.success {
        return None;
    }
    r.stdout.lines().find_map(parse_container_stats_line)
}

pub fn stats_summary() -> (f64, f64) {
    let r = util::run_command(
        &docker_bin(),
        &[
            "stats",
            "--no-stream",
            "--format",
            "{{.CPUPerc}}\t{{.MemPerc}}",
        ],
    );
    if !r.success || r.stdout.is_empty() {
        return (0.0, 0.0);
    }
    let mut cpu = 0.0;
    let mut mem = 0.0;
    let mut count = 0.0;
    for line in r.stdout.lines() {
        if let Some((cpu_usage, memory_usage)) = parse_stats_summary_line(line) {
            cpu += cpu_usage;
            mem += memory_usage;
            count += 1.0;
        }
    }
    if count > 0.0 {
        (cpu / count, mem / count)
    } else {
        (0.0, 0.0)
    }
}

pub fn info() -> DockerInfo {
    info_cached(true)
}

pub fn info_fresh() -> DockerInfo {
    cache::invalidate_docker();
    info_cached(false)
}

fn info_cached(use_cache: bool) -> DockerInfo {
    if use_cache {
        if let Some(v) = cache::docker(Duration::from_secs(3)) {
            return v;
        }
    }
    let running = is_running_fast() || is_running_slow();
    // Skip docker stats on every refresh — it is a major freeze source on Windows
    let info = DockerInfo {
        running,
        version: if running {
            version_cached()
        } else {
            "unavailable".into()
        },
        images: if running { list_images() } else { vec![] },
        containers: if running {
            list_containers(true)
        } else {
            vec![]
        },
        cpu_usage: 0.0,
        memory_usage: 0.0,
    };
    cache::set_docker(info.clone());
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str, ports: &str) -> DockerContainer {
        DockerContainer {
            id: format!("id-{name}"),
            name: name.to_string(),
            image: "redroid/redroid:13.0.0-latest".to_string(),
            status: "Exited (137)".to_string(),
            ports: ports.to_string(),
            created: String::new(),
            is_redroid: true,
        }
    }

    #[test]
    fn bindings_to_ports_parses_standard_bindings() {
        let json = r#"{"5555/tcp":[{"HostIp":"","HostPort":"5555"}]}"#;
        assert_eq!(bindings_to_ports(json), "0.0.0.0:5555->5555/tcp");
    }

    #[test]
    fn bindings_to_ports_handles_ipv6_and_multiple() {
        let json = r#"{"5555/tcp":[{"HostIp":"::","HostPort":"5556"}],"5432/tcp":[{"HostIp":"","HostPort":"5435"}]}"#;
        let out = bindings_to_ports(json);
        assert!(out.contains("[::]:5556->5555/tcp"), "got: {out}");
        assert!(out.contains("0.0.0.0:5435->5432/tcp"), "got: {out}");
    }

    #[test]
    fn bindings_to_ports_skips_empty_and_invalid() {
        assert_eq!(bindings_to_ports("{}"), "");
        assert_eq!(bindings_to_ports("not json"), "");
        assert_eq!(
            bindings_to_ports(r#"{"5555/tcp":[{"HostIp":"","HostPort":""}]}"#),
            ""
        );
    }

    #[test]
    fn suggest_counts_stopped_container_bindings() {
        // Exited container holding 5555 via a binding that docker ps hides
        let containers = vec![container(
            "rdc-redroid-1",
            "0.0.0.0:5555->5555/tcp",
        )];
        // Don't pin the exact port: the suggestion also skips real loopback
        // listeners, so the result depends on the host environment.
        let suggested = suggest_free_adb_port(&containers);
        assert!(suggested > 5555, "suggested {suggested}");
        assert!(host_port_in_use(&containers, 5555));
    }

    #[test]
    fn parse_container_stats_line_reads_cpu_and_memory_units() {
        let stats = parse_container_stats_line("12.5%\t128MiB / 2GiB\t6.25%").unwrap();

        assert!((stats.cpu_usage - 12.5).abs() < f64::EPSILON);
        assert!((stats.memory_usage - 6.25).abs() < f64::EPSILON);
        assert_eq!(stats.memory_used_mb, 128);
        assert_eq!(stats.memory_total_mb, 2048);
    }

    #[test]
    fn parse_stats_summary_line_keeps_the_legacy_two_column_format() {
        assert_eq!(parse_stats_summary_line("12.5%\t6.25%"), Some((12.5, 6.25)));
    }

    #[test]
    fn parse_container_stats_line_rejects_malformed_output() {
        assert!(parse_container_stats_line("not stats").is_none());
        assert!(parse_container_stats_line("1.0%\t2XB / 2GiB\t3.0%").is_none());
    }

    #[test]
    fn container_stats_rejects_empty_identifier() {
        assert!(container_stats(" ").is_none());
    }
}

#[cfg(test)]
mod root_dirs_tests {
    use super::*;

    #[test]
    fn project_root_dirs_are_absolute_and_deduped() {
        let roots = project_root_dirs();
        assert!(!roots.is_empty(), "should always produce at least cwd");
        assert!(roots.iter().all(|r| r.is_absolute()));
        let unique: std::collections::HashSet<&std::path::PathBuf> = roots.iter().collect();
        assert_eq!(unique.len(), roots.len(), "no duplicate roots expected");
    }
}
