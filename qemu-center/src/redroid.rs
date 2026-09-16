//! redroid container commands, assembled for execution *inside the guest*
//! (`ssh … docker …`) or shown to the operator.
//!
//! **Independent implementation.** The redroid `docker run` shape here is
//! derived from the redroid documentation (privileged container + `androidboot.*`
//! kernel cmdline arguments) — it deliberately does **not** import or reuse
//! `src-tauri/src/services/docker.rs`. The two tracks share only the semantics
//! of the upstream redroid image, which is what makes the RDC runtime-trait
//! adapter (docs/architecture.md) a thin layer rather than a rewrite.
//!
//! Container naming: `qc-<name>` — the `qc-` prefix keeps them greppable and
//! unambiguous inside a guest that may also run unrelated containers.

/// GPU mode for `androidboot.redroid_gpu_mode`. A QEMU guest has no `/dev/dri`
/// unless a GPU device is passed through, so `Guest` (SwiftShader) is the
/// correct default in this architecture; `Host` is supported for future
/// virtio-gpu/VFIO setups and is documented as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuMode {
    Guest,
    Host,
}

impl GpuMode {
    pub fn androidboot_value(self) -> &'static str {
        match self {
            GpuMode::Guest => "androidboot.redroid_gpu_mode=guest",
            GpuMode::Host => "androidboot.redroid_gpu_mode=host",
        }
    }
}

/// A redroid instance spec (one container = one emulated Android device).
#[derive(Debug, Clone, PartialEq)]
pub struct RedroidSpec {
    /// Logical name; the container becomes `qc-<name>`.
    pub name: String,
    /// Host/guest ADB port (from the VM's reserved block — host port == guest
    /// port, so this single number is the whole mapping).
    pub adb_port: u16,
    /// Docker `--cpus` (fractional allowed).
    pub cpus: f64,
    /// Docker `--memory`, MiB (rendered as `<n>m`).
    pub memory_mib: u32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub gpu_mode: GpuMode,
    /// redroid image tag (default `redroid/redroid:14.0.0-latest`).
    pub image: String,
}

/// Container name for a logical instance name.
pub fn container_name(name: &str) -> String {
    format!("qc-{name}")
}

/// Docker volume holding the instance's `/data` (survives container recreate).
pub fn data_volume_name(name: &str) -> String {
    format!("qc-{name}-data")
}

/// Instance names become container names, volume names and port assignments.
pub fn validate_instance_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 24 {
        return Err("instance name must be 1..=24 chars".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("instance name {name:?} must be lowercase [a-z0-9-]"));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("instance name must not start or end with '-'".into());
    }
    Ok(())
}

/// `docker volume create qc-<name>-data` — idempotent, run before create.
pub fn docker_volume_create_args(name: &str) -> Vec<String> {
    vec!["volume".into(), "create".into(), data_volume_name(name)]
}

/// `docker run -d … <image> androidboot.*` for one redroid instance. Pure.
///
/// Semantics mirrored from the redroid docs: `--privileged` (binder/ashmem and
/// loop devices), CPU/memory caps, a `/data` volume for persistence, the ADB
/// port published on all interfaces *inside the guest* (the host never sees it
/// directly — QEMU's slirp `hostfwd` carries it to the host port of the same
/// number), and the `androidboot.redroid_*` cmdline properties.
pub fn redroid_create_args(spec: &RedroidSpec) -> Vec<String> {
    let container = container_name(&spec.name);
    let a: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        container,
        "--privileged".into(),
        "--cpus".into(),
        format_cpus(spec.cpus),
        "--memory".into(),
        format!("{}m", spec.memory_mib),
        "-v".into(),
        format!("{}:/data", data_volume_name(&spec.name)),
        "-p".into(),
        format!("0.0.0.0:{}:5555", spec.adb_port),
        spec.image.clone(),
        format!("androidboot.redroid_width={}", spec.width),
        format!("androidboot.redroid_height={}", spec.height),
        format!("androidboot.redroid_dpi={}", spec.dpi),
        spec.gpu_mode.androidboot_value().to_string(),
    ];
    a
}

/// Guest-only bind mounts and cgroup settings for a prepared device profile.
pub fn redroid_create_args_with_mounts(spec: &RedroidSpec, binds: &[String], cgroup_parent: Option<&str>) -> Vec<String> {
    let mut args = redroid_create_args(spec);
    let image_index = args.len() - 5;
    let mut options = vec!["--restart".into(), "unless-stopped".into()];
    for bind in binds { options.extend(["--volume".into(), bind.clone()]); }
    if let Some(parent) = cgroup_parent { options.extend(["--cgroup-parent".into(), parent.into()]); }
    args.splice(image_index..image_index, options);
    args
}

/// Docker `--cpus` wants `2` not `2.0`; keep one decimal only when needed.
fn format_cpus(cpus: f64) -> String {
    if (cpus.fract()).abs() < f64::EPSILON {
        format!("{}", cpus as u64)
    } else {
        format!("{cpus}")
    }
}

/// `docker start qc-<name>` / `docker stop qc-<name>`.
pub fn docker_lifecycle_args(action: &str, name: &str) -> Vec<String> {
    vec![action.to_string(), container_name(name)]
}

/// `docker exec qc-<name> getprop sys.boot_completed` — redroid boot probe.
pub fn boot_completed_args(name: &str) -> Vec<String> {
    vec![
        "exec".into(),
        container_name(name),
        "getprop".into(),
        "sys.boot_completed".into(),
    ]
}

/// `docker ps` filtered to this track's containers.
pub fn docker_ps_args() -> Vec<String> {
    vec![
        "ps".into(),
        "-a".into(),
        "--filter".into(),
        "name=^qc-".into(),
        "--format".into(),
        "{{.Names}}\\t{{.Status}}\\t{{.Ports}}".into(),
    ]
}

/// Judge `docker exec … getprop sys.boot_completed` output.
pub fn judge_boot_completed(stdout: &str) -> bool {
    stdout.trim() == "1"
}

/// Judge `docker ps` listing: container present (any state).
pub fn judge_container_listed(stdout: &str, name: &str) -> bool {
    let want = container_name(name);
    stdout
        .lines()
        .any(|l| l.split(['\t', ' ']).next() == Some(want.as_str()))
}

/// Defaults for a fresh instance on a 4 vCPU / 8 GiB node: one third of the
/// node's CPU and a quarter of its RAM, 720x1280 @ 320dpi — the middle
/// redroid phone profile (see RDC's resolution presets for the same ladder).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceDefaults {
    pub cpus: u32,
    pub memory_mib: u32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
}

pub fn defaults_for_node(node_vcpus: u16, node_mem_mib: u32) -> InstanceDefaults {
    let cpus = ((node_vcpus as u32) / 3).clamp(1, 8);
    let memory_mib = ((node_mem_mib / 4).max(1024)).min(8192);
    InstanceDefaults {
        cpus,
        memory_mib,
        width: 720,
        height: 1280,
        dpi: 320,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_mounts_are_options_before_image_and_auto_restart_is_enabled() {
        let args = redroid_create_args_with_mounts(&spec(), &["/guest/cpuinfo:/proc/cpuinfo:ro".into()], Some("system.slice"));
        let image = args.iter().position(|s| s == "redroid/redroid:14.0.0-latest").unwrap();
        let bind = args.iter().position(|s| s == "/guest/cpuinfo:/proc/cpuinfo:ro").unwrap();
        assert!(bind < image);
        assert!(args.windows(2).any(|a| a == ["--restart", "unless-stopped"]));
        assert!(args.windows(2).any(|a| a == ["--cgroup-parent", "system.slice"]));
    }

    fn spec() -> RedroidSpec {
        RedroidSpec {
            name: "r1".into(),
            adb_port: 24500,
            cpus: 2.0,
            memory_mib: 2048,
            width: 720,
            height: 1280,
            dpi: 320,
            gpu_mode: GpuMode::Guest,
            image: crate::vm::default_redroid_image(),
        }
    }

    #[test]
    fn create_args_snapshot() {
        let args = redroid_create_args(&spec());
        assert_eq!(
            args,
            vec![
                "run",
                "-d",
                "--name",
                "qc-r1",
                "--privileged",
                "--cpus",
                "2",
                "--memory",
                "2048m",
                "-v",
                "qc-r1-data:/data",
                "-p",
                "0.0.0.0:24500:5555",
                "redroid/redroid:14.0.0-latest",
                "androidboot.redroid_width=720",
                "androidboot.redroid_height=1280",
                "androidboot.redroid_dpi=320",
                "androidboot.redroid_gpu_mode=guest",
            ]
        );
    }

    #[test]
    fn create_uses_privileged_and_androidboot_props() {
        let s = redroid_create_args(&spec()).join(" ");
        // The three properties redroid needs to size/configure the device.
        assert!(s.contains("--privileged"));
        assert!(s.contains("androidboot.redroid_width=720"));
        assert!(s.contains("androidboot.redroid_height=1280"));
        assert!(s.contains("androidboot.redroid_dpi=320"));
        assert!(s.starts_with("run -d --name qc-r1"));
    }

    #[test]
    fn gpu_mode_switch() {
        let mut sp = spec();
        sp.gpu_mode = GpuMode::Host;
        assert!(redroid_create_args(&sp)
            .contains(&"androidboot.redroid_gpu_mode=host".to_string()));
        assert_eq!(GpuMode::Guest.androidboot_value(), "androidboot.redroid_gpu_mode=guest");
    }

    #[test]
    fn cpus_are_rendered_without_trailing_zero() {
        let mut sp = spec();
        sp.cpus = 1.5;
        assert!(redroid_create_args(&sp).contains(&"1.5".to_string()));
        sp.cpus = 4.0;
        assert!(redroid_create_args(&sp).contains(&"4".to_string()));
        assert!(!redroid_create_args(&sp).contains(&"4.0".to_string()));
    }

    #[test]
    fn adb_port_mapping_is_host_guest_same_number() {
        let mut sp = spec();
        sp.adb_port = 24517;
        let args = redroid_create_args(&sp);
        let i = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[i + 1], "0.0.0.0:24517:5555");
    }

    #[test]
    fn names_and_volumes_are_prefixed() {
        assert_eq!(container_name("r1"), "qc-r1");
        assert_eq!(data_volume_name("r1"), "qc-r1-data");
        assert_eq!(
            docker_volume_create_args("r1"),
            vec!["volume", "create", "qc-r1-data"]
        );
    }

    #[test]
    fn lifecycle_and_probe_args() {
        assert_eq!(docker_lifecycle_args("start", "r1"), vec!["start", "qc-r1"]);
        assert_eq!(docker_lifecycle_args("stop", "r1"), vec!["stop", "qc-r1"]);
        assert_eq!(
            boot_completed_args("r1"),
            vec!["exec", "qc-r1", "getprop", "sys.boot_completed"]
        );
        let ps = docker_ps_args().join(" ");
        assert!(ps.contains("--filter name=^qc-"));
        assert!(ps.contains("{{.Names}}\\t{{.Status}}\\t{{.Ports}}"));
    }

    #[test]
    fn boot_completed_judgement() {
        assert!(judge_boot_completed("1\n"));
        assert!(judge_boot_completed("1"));
        assert!(!judge_boot_completed("0\n"));
        assert!(!judge_boot_completed(""));
        assert!(!judge_boot_completed("error: no such container"));
    }

    #[test]
    fn container_listing_judgement() {
        let out = "qc-r1\tUp 3 minutes\t0.0.0.0:24500->5555/tcp\nqc-r2\tExited (0)\t\n";
        assert!(judge_container_listed(out, "r1"));
        assert!(judge_container_listed(out, "r2"));
        assert!(!judge_container_listed(out, "r3"));
        // A different prefix must not match (`qc-r1x` != `qc-r1`).
        assert!(!judge_container_listed("qc-r1x\tUp\n", "r1"));
    }

    #[test]
    fn instance_name_validation() {
        assert!(validate_instance_name("r1").is_ok());
        assert!(validate_instance_name("redroid-2").is_ok());
        assert!(validate_instance_name("").is_err());
        assert!(validate_instance_name("R1").is_err());
        assert!(validate_instance_name("r 1").is_err());
        assert!(validate_instance_name("r1;rm -rf /").is_err());
        assert!(validate_instance_name("-r1").is_err());
    }

    #[test]
    fn node_defaults_scale_with_node_size() {
        let d = defaults_for_node(4, 8192);
        assert_eq!(d.cpus, 1); // 4/3 = 1 (integer division, clamped ≥ 1)
        assert_eq!(d.memory_mib, 2048);
        let big = defaults_for_node(16, 65536);
        assert_eq!(big.cpus, 5); // 16/3 = 5
        assert_eq!(big.memory_mib, 8192); // capped
        let tiny = defaults_for_node(1, 1024);
        assert_eq!(tiny.cpus, 1);
        assert_eq!(tiny.memory_mib, 1024);
        assert_eq!((big.width, big.height, big.dpi), (720, 1280, 320));
    }
}
