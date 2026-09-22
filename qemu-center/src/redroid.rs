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

use serde::{Deserialize, Serialize};

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
    /// Content-addressed redroid image reference (`name@sha256:<digest>`).
    pub image: String,
}

/// Container name for a logical instance name.
pub fn container_name(name: &str) -> String {
    format!("qc-{name}")
}

/// Protected redroid execution must use a content-addressed image reference.
pub fn validate_image_ref(image: &str) -> Result<(), String> {
    let Some((name, digest)) = image.split_once("@sha256:") else {
        return Err("redroid image must use an immutable @sha256 digest".into());
    };
    if name.is_empty()
        || !name.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/:".contains(c))
        || digest.len() != 64
        || !digest.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("redroid image digest is invalid".into());
    }
    Ok(())
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
        return Err(format!(
            "instance name {name:?} must be lowercase [a-z0-9-]"
        ));
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
pub fn redroid_create_args_with_mounts(
    spec: &RedroidSpec,
    binds: &[String],
    cgroup_parent: Option<&str>,
) -> Vec<String> {
    let mut args = redroid_create_args(spec);
    let image_index = args.len() - 5;
    let mut options = vec!["--restart".into(), "unless-stopped".into()];
    for bind in binds {
        options.extend(["--volume".into(), bind.clone()]);
    }
    if let Some(parent) = cgroup_parent {
        options.extend(["--cgroup-parent".into(), parent.into()]);
    }
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

/// Read-only runtime measurements for one redroid container. A stopped or
/// partially provisioned container is still represented; unavailable values
/// stay `None` so callers never mistake missing data for zero usage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct RedroidRuntimeStats {
    pub instance: String,
    #[serde(default)]
    pub container: String,
    #[serde(default)]
    pub status: String,
    pub memory_limit_bytes: Option<u64>,
    pub memory_current_bytes: Option<u64>,
    pub memory_peak_bytes: Option<u64>,
    pub oom_kills: Option<u64>,
    pub cpu_usage_percent: Option<f64>,
    pub boot_completed: Option<bool>,
}

/// CLI argv for `redroid stats <vm> [instance] --json`.
pub fn redroid_stats_args(vm: &str, instance: Option<&str>) -> Vec<String> {
    let mut args = vec!["redroid".into(), "stats".into(), vm.into()];
    if let Some(instance) = instance.filter(|value| !value.is_empty()) {
        args.push(instance.into());
    }
    args.push("--json".into());
    args
}

/// Parse the stable JSON contract emitted by the stats command.
pub fn parse_redroid_stats_json(raw: &str) -> Result<Vec<RedroidRuntimeStats>, String> {
    serde_json::from_str(raw).map_err(|e| format!("parse redroid stats JSON failed: {e}"))
}

/// Minimum guest RAM target accepted by the explicit balloon reclaim action.
pub const MIN_BALLOON_TARGET_MIB: u32 = 1536;
const BALLOON_QUANTUM_MIB: u32 = 256;
const BALLOON_BASE_RESERVE_MIB: u32 = 768;
const BALLOON_PER_INSTANCE_RESERVE_MIB: u32 = 512;

/// Safe result of the guest-memory reclaim planner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReclaimPlan {
    Reclaim {
        target_mib: u32,
        used_mib: u32,
        active_instances: u32,
    },
    Noop {
        reason: &'static str,
    },
    UnknownMetrics {
        instance: String,
    },
}

fn reclaim_active_status(status: &str) -> bool {
    let normalized = status.trim().to_ascii_lowercase();
    normalized == "running" || normalized == "up" || normalized.starts_with("up ")
}

fn reclaim_inactive_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "exited" | "created" | "dead" | "paused"
    ) || status.trim().to_ascii_lowercase().starts_with("exited ")
}

/// Compute a conservative balloon target from read-only guest cgroup stats.
/// Unknown rows never become permission to reclaim memory.
pub fn plan_memory_reclaim(node_mem_mib: u32, rows: &[RedroidRuntimeStats]) -> ReclaimPlan {
    if node_mem_mib <= MIN_BALLOON_TARGET_MIB {
        return ReclaimPlan::Noop {
            reason: "node memory is already at the safe reclaim floor",
        };
    }

    let mut used_mib = 0u32;
    let mut active_instances = 0u32;
    for row in rows {
        if reclaim_active_status(&row.status) {
            let Some(current_bytes) = row.memory_current_bytes else {
                return ReclaimPlan::UnknownMetrics {
                    instance: row.instance.clone(),
                };
            };
            active_instances = active_instances.saturating_add(1);
            let current_mib = current_bytes
                .saturating_add(1_048_575)
                .checked_div(1_048_576)
                .unwrap_or(u64::MAX)
                .min(u64::from(u32::MAX)) as u32;
            used_mib = used_mib.saturating_add(current_mib);
        } else if !reclaim_inactive_status(&row.status) {
            return ReclaimPlan::UnknownMetrics {
                instance: row.instance.clone(),
            };
        }
    }

    let reserve_mib = BALLOON_BASE_RESERVE_MIB
        .max(active_instances.saturating_mul(BALLOON_PER_INSTANCE_RESERVE_MIB));
    let raw_target = MIN_BALLOON_TARGET_MIB.max(used_mib.saturating_add(reserve_mib));
    let aligned_target = raw_target.saturating_add(BALLOON_QUANTUM_MIB - 1) / BALLOON_QUANTUM_MIB
        * BALLOON_QUANTUM_MIB;
    let target_mib = aligned_target.min(node_mem_mib);
    if target_mib > node_mem_mib.saturating_sub(BALLOON_QUANTUM_MIB) {
        return ReclaimPlan::Noop {
            reason: "current usage leaves less than one reclaim quantum",
        };
    }
    ReclaimPlan::Reclaim {
        target_mib,
        used_mib,
        active_instances,
    }
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
    pub install_gapps: bool,
    pub install_magisk: bool,
}

/// Runtime footprint preset. These are conservative starting points, not a
/// promise that every app fits; the actual measured snapshot remains the
/// source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceProfile {
    Lean,
    Standard,
    Full,
}

/// A full profile includes GApps and Magisk/zygisk services. E-033 measured
/// one at almost the entire 3072 MiB container ceiling on a 4096 MiB node,
/// leaving the Windows host in critical pressure. Keep the boundary explicit
/// and enforce it before Docker create; existing instances are not changed.
pub const FULL_PROFILE_MIN_NODE_MEMORY_MIB: u32 = 6144;

impl Default for ResourceProfile {
    fn default() -> Self {
        Self::Standard
    }
}

impl ResourceProfile {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "lean" => Ok(Self::Lean),
            "standard" | "" => Ok(Self::Standard),
            "full" => Ok(Self::Full),
            other => Err(format!(
                "resource profile must be lean, standard, or full (got {other:?})"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lean => "lean",
            Self::Standard => "standard",
            Self::Full => "full",
        }
    }

    pub fn container_defaults(self, node_vcpus: u16, node_mem_mib: u32) -> InstanceDefaults {
        let node_mem_mib = node_mem_mib.max(1024);
        let reserved = (node_mem_mib / 4).max(512);
        let available = node_mem_mib.saturating_sub(reserved);
        let (cpus, memory_mib, install_gapps, install_magisk) = match self {
            Self::Lean => (
                ((node_vcpus as u32) / 4).max(1),
                (available / 2).clamp(if node_mem_mib >= 3072 { 1536 } else { 1024 }, 4096),
                false,
                false,
            ),
            Self::Standard => (
                ((node_vcpus as u32) / 3).max(1),
                available
                    .max(1024)
                    .min((node_mem_mib / 4).max(2048))
                    .clamp(1024, 8192),
                false,
                false,
            ),
            Self::Full => (
                ((node_vcpus as u32) / 2).max(1),
                (available / 1).clamp(1536, 8192),
                true,
                true,
            ),
        };
        InstanceDefaults {
            cpus,
            memory_mib,
            width: 720,
            height: 1280,
            dpi: 320,
            install_gapps,
            install_magisk,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceBudgetError {
    InvalidNodeMemory,
    InvalidInstanceMemory,
    InsufficientHeadroom {
        requested_mib: u64,
        available_mib: u64,
        headroom_mib: u64,
    },
}

/// Validate a conservative node budget before asking Docker to create a
/// container. The reserved headroom covers the guest OS, Docker and startup
/// spikes; it intentionally does not equate a Docker limit with real usage.
pub fn validate_resource_budget(
    node_memory_mib: u32,
    instance_memory_mib: u32,
    running_instances: u32,
) -> Result<(), ResourceBudgetError> {
    if node_memory_mib == 0 {
        return Err(ResourceBudgetError::InvalidNodeMemory);
    }
    if instance_memory_mib < 512 {
        return Err(ResourceBudgetError::InvalidInstanceMemory);
    }
    let headroom_mib = (node_memory_mib / 4).max(512) as u64;
    let available_mib = (node_memory_mib as u64).saturating_sub(headroom_mib);
    let requested_mib = (instance_memory_mib as u64).saturating_mul(running_instances as u64);
    if requested_mib > available_mib {
        return Err(ResourceBudgetError::InsufficientHeadroom {
            requested_mib,
            available_mib,
            headroom_mib,
        });
    }
    Ok(())
}

pub fn defaults_for_node(node_vcpus: u16, node_mem_mib: u32) -> InstanceDefaults {
    let mut defaults = ResourceProfile::Standard.container_defaults(node_vcpus, node_mem_mib);
    defaults.cpus = defaults.cpus.clamp(1, 8);
    defaults
}

/// Resolve optional CLI resource overrides against the selected profile.
/// Explicit values win; omitted values use the same profile ladder exposed by
/// the desktop form so `--profile lean` cannot silently become a standard-sized
/// container.
pub fn resolve_instance_resources(
    profile: ResourceProfile,
    node_vcpus: u16,
    node_mem_mib: u32,
    cpus_override: Option<f64>,
    memory_override: Option<u32>,
) -> Result<(f64, u32), String> {
    if profile == ResourceProfile::Full && node_mem_mib < FULL_PROFILE_MIN_NODE_MEMORY_MIB {
        return Err(format!(
            "full profile requires a node with at least {} MiB; choose lean/standard or a larger node",
            FULL_PROFILE_MIN_NODE_MEMORY_MIB
        ));
    }
    let defaults = profile.container_defaults(node_vcpus, node_mem_mib);
    let cpus = cpus_override.unwrap_or(defaults.cpus as f64);
    if !cpus.is_finite() || cpus <= 0.0 {
        return Err("cpus must be a finite positive number".into());
    }
    let memory_mib = memory_override.unwrap_or(defaults.memory_mib);
    if memory_mib < 512 {
        return Err("memory must be at least 512 MiB".into());
    }
    Ok((cpus, memory_mib))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_IMAGE: &str = "redroid/redroid@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn preset_mounts_are_options_before_image_and_auto_restart_is_enabled() {
        let args = redroid_create_args_with_mounts(
            &spec(),
            &["/guest/cpuinfo:/proc/cpuinfo:ro".into()],
            Some("system.slice"),
        );
        let image = args
            .iter()
            .position(|s| s == TEST_IMAGE)
            .unwrap();
        let bind = args
            .iter()
            .position(|s| s == "/guest/cpuinfo:/proc/cpuinfo:ro")
            .unwrap();
        assert!(bind < image);
        assert!(args
            .windows(2)
            .any(|a| a == ["--restart", "unless-stopped"]));
        assert!(args
            .windows(2)
            .any(|a| a == ["--cgroup-parent", "system.slice"]));
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
            image: TEST_IMAGE.into(),
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
                TEST_IMAGE,
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
    fn protected_image_reference_requires_a_sha256_digest() {
        assert!(validate_image_ref(TEST_IMAGE).is_ok());
        assert!(validate_image_ref("redroid/redroid:14.0.0-latest").is_err());
        assert!(validate_image_ref("").is_err());
    }

    #[test]
    fn gpu_mode_switch() {
        let mut sp = spec();
        sp.gpu_mode = GpuMode::Host;
        assert!(redroid_create_args(&sp).contains(&"androidboot.redroid_gpu_mode=host".to_string()));
        assert_eq!(
            GpuMode::Guest.androidboot_value(),
            "androidboot.redroid_gpu_mode=guest"
        );
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

    #[test]
    fn stats_command_requests_cgroup_and_boot_state_without_mutation() {
        let args = redroid_stats_args("node1", Some("r13"));
        assert_eq!(args, vec!["redroid", "stats", "node1", "r13", "--json"]);
    }

    #[test]
    fn stats_parser_preserves_missing_cgroup_values_as_none() {
        let rows = parse_redroid_stats_json(
            r#"[{"instance":"r13","memory_limit_bytes":null,"oom_kills":null}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].instance, "r13");
        assert_eq!(rows[0].memory_limit_bytes, None);
        assert_eq!(rows[0].oom_kills, None);
    }

    fn stats_row(instance: &str, status: &str, current_mib: Option<u64>) -> RedroidRuntimeStats {
        RedroidRuntimeStats {
            instance: instance.into(),
            container: container_name(instance),
            status: status.into(),
            memory_limit_bytes: None,
            memory_current_bytes: current_mib.map(|mib| mib * 1024 * 1024),
            memory_peak_bytes: None,
            oom_kills: None,
            cpu_usage_percent: None,
            boot_completed: None,
        }
    }

    #[test]
    fn memory_reclaim_plan_uses_a_floor_and_ignores_exited_rows() {
        let plan = plan_memory_reclaim(
            3072,
            &[
                stats_row("r1", "Exited (0)", Some(4096)),
                stats_row("r2", "exited", None),
            ],
        );
        assert_eq!(
            plan,
            ReclaimPlan::Reclaim {
                target_mib: 1536,
                used_mib: 0,
                active_instances: 0,
            }
        );
    }

    #[test]
    fn memory_reclaim_plan_aligns_active_usage_and_reserves_headroom() {
        let plan = plan_memory_reclaim(3072, &[stats_row("r1", "Up 2 hours", Some(1750))]);
        assert_eq!(
            plan,
            ReclaimPlan::Reclaim {
                target_mib: 2560,
                used_mib: 1750,
                active_instances: 1,
            }
        );
    }

    #[test]
    fn memory_reclaim_plan_allows_exactly_one_reclaim_quantum() {
        let plan = plan_memory_reclaim(2048, &[stats_row("r1", "running", Some(900))]);
        assert_eq!(
            plan,
            ReclaimPlan::Reclaim {
                target_mib: 1792,
                used_mib: 900,
                active_instances: 1,
            }
        );
    }

    #[test]
    fn memory_reclaim_plan_fails_closed_for_unknown_active_metrics_or_status() {
        assert_eq!(
            plan_memory_reclaim(3072, &[stats_row("r1", "running", None)]),
            ReclaimPlan::UnknownMetrics {
                instance: "r1".into()
            }
        );
        assert_eq!(
            plan_memory_reclaim(3072, &[stats_row("r1", "unknown", Some(100))]),
            ReclaimPlan::UnknownMetrics {
                instance: "r1".into()
            }
        );
    }

    #[test]
    fn memory_reclaim_plan_is_noop_when_node_has_no_safe_reclaim_space() {
        assert_eq!(
            plan_memory_reclaim(1536, &[]),
            ReclaimPlan::Noop {
                reason: "node memory is already at the safe reclaim floor"
            }
        );
        assert_eq!(
            plan_memory_reclaim(3072, &[stats_row("r1", "running", Some(2400))]),
            ReclaimPlan::Noop {
                reason: "current usage leaves less than one reclaim quantum"
            }
        );
    }

    #[test]
    fn lean_profile_does_not_enable_optional_preloads() {
        let defaults = ResourceProfile::Lean.container_defaults(4, 4096);
        assert_eq!(defaults.memory_mib, 1536);
        assert!(!defaults.install_gapps);
        assert!(!defaults.install_magisk);
    }

    #[test]
    fn standard_profile_keeps_a_2_gib_starting_limit_on_a_4_gib_node() {
        let defaults = ResourceProfile::Standard.container_defaults(4, 4096);
        assert_eq!(defaults.memory_mib, 2048);
        assert!(!defaults.install_gapps);
        assert!(!defaults.install_magisk);
    }

    #[test]
    fn standard_profile_keeps_two_gib_on_a_3_gib_node_with_headroom() {
        let defaults = ResourceProfile::Standard.container_defaults(4, 3072);
        assert_eq!(defaults.memory_mib, 2048);
    }

    #[test]
    fn lean_profile_keeps_the_measured_floor_on_a_3_gib_node() {
        let defaults = ResourceProfile::Lean.container_defaults(4, 3072);
        assert_eq!(defaults.memory_mib, 1536);
        assert!(!defaults.install_gapps);
        assert!(!defaults.install_magisk);
    }

    #[test]
    fn omitted_cli_resources_follow_the_selected_profile() {
        assert_eq!(
            resolve_instance_resources(ResourceProfile::Lean, 4, 3072, None, None).unwrap(),
            (1.0, 1536)
        );
        assert_eq!(
            resolve_instance_resources(ResourceProfile::Full, 4, 6144, None, None).unwrap(),
            (2.0, 4608)
        );
        assert_eq!(
            resolve_instance_resources(ResourceProfile::Lean, 4, 3072, Some(2.0), Some(1792))
                .unwrap(),
            (2.0, 1792)
        );
    }

    #[test]
    fn budget_rejects_two_instances_that_leave_no_node_headroom() {
        let result = validate_resource_budget(4096, 2048, 2);
        assert!(matches!(
            result,
            Err(ResourceBudgetError::InsufficientHeadroom { .. })
        ));
    }

    #[test]
    fn full_profile_is_rejected_on_a_four_gib_node() {
        let error = resolve_instance_resources(ResourceProfile::Full, 4, 4096, None, None)
            .expect_err("full profile must not be admitted on a 4 GiB node");
        assert!(error.contains("6144 MiB"), "unexpected error: {error}");
    }

    #[test]
    fn full_profile_is_admitted_at_the_six_gib_boundary() {
        let resources = resolve_instance_resources(ResourceProfile::Full, 4, 6144, None, None)
            .expect("full profile should be admitted at 6 GiB");
        assert_eq!(resources.1, 4608);
    }
}
