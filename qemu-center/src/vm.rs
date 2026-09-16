//! VM layer: QEMU command assembly (pure), qcow2 tooling, host port
//! allocation and the `state.json` registry.
//!
//! Design notes / honest limitations:
//! * **Windows detach**: QEMU's `-daemonize` is POSIX-only (it forks). On
//!   Windows the launcher therefore spawns the child detached itself
//!   (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`) and the assembled command
//!   must NOT carry `-daemonize`. [`Detach::Daemonize`] exists so the same
//!   builder stays usable on Linux/macOS hosts.
//! * **Stopping a VM**: no `-monitor`/`-qmp`-less kill. Each VM gets its own
//!   QMP TCP endpoint on loopback; [`qmp_stop_frames`] is the exact byte
//!   sequence sent (greeting → `qmp_capabilities` → `system_powerdown`).
//! * **Ports**: one VM owns a consecutive block of ADB host ports (default
//!   base 24500) plus one SSH (22300+) and one QMP (23300+) port. The block is
//!   pre-declared as QEMU user-mode `hostfwd` rules at boot, because slirp
//!   forwarding cannot be added after start without QMP — so a VM is created
//!   with room for N redroid instances up front. The RDC Docker track owns
//!   5555–6000; [`RESERVED_HOST_PORT_RANGES`] keeps this allocator out of it.
//! * **Registry locking**: `state.json` is written via temp-file + rename
//!   (atomic on NTFS and POSIX). There is NO cross-process lock: two
//!   concurrent `qemu-center` processes can lose an update. The CLI is a
//!   single-operator tool; this is a documented limitation, not a bug.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Default first ADB host port of a VM's forward block.
pub const DEFAULT_ADB_PORT_BASE: u16 = 24500;
/// Default SSH host port base (guest :22 is forwarded to a free port ≥ this).
pub const DEFAULT_SSH_PORT_BASE: u16 = 22300;
/// Default QMP TCP port base.
pub const DEFAULT_QMP_PORT_BASE: u16 = 23300;
/// How many ADB ports a new VM reserves by default (= max redroid instances).
pub const DEFAULT_ADB_PORT_COUNT: u16 = 32;
/// Registry schema version (bump on breaking state.json changes).
pub const STATE_VERSION: u32 = 1;

/// QMP id of the data disk in the QEMU argv (`-drive ...,id=disk0`). QMP
/// commands that must address the VM's live disk — the internal snapshot of
/// Bug A — use this id as their `device` argument.
pub const DISK_DEVICE_ID: &str = "disk0";

/// CPU model pinned for [`Accel::Whpx`] runs (`-cpu <this>`).
///
/// **Why this exists — real-machine evidence, not theory.** On the user's host
/// (Intel i5-11400H, Windows 11, QEMU 11.1, WHPX) the guest hung three times in
/// one day. `state/vms/node1/qemu.log` was a screenful of:
///
/// ```text
/// WHPX: Unexpected VP exit code 4
/// WHPX: Unexpected VP exit code 4
/// warning: host doesn't support requested feature: CPUID[eax=80000001h].ECX.svm [bit 2]
/// warning: Ignoring request for interrupt vector 0
/// ```
///
/// The launch argv carried no `-cpu`, so QEMU used its default model, which
/// advertises AMD `svm` / Intel `vmx` nested-virtualisation bits this host does
/// not implement. WHPX then faults ("Unexpected VP exit code 4") every time
/// the guest touches them, and the guest wedges.
///
/// A/B run with exactly one variable changed — the explicit
/// `-cpu max,-svm,-vmx`: "Unexpected VP exit" dropped from a screenful to
/// **0**, the guest booted normally, redroid containers came up on their own
/// and `boot_completed=1` (Android 13) was reached with the data volume
/// intact. `max` keeps the widest usable feature set; `-svm,-vmx` masks the
/// nested-virtualisation bits the hypervisor cannot back. redroid does not
/// need nested virtualisation, so nothing is lost.
///
/// [`Accel::Tcg`] deliberately keeps QEMU's default model: TCG emulates the
/// nested-virt bits in software without the WHPX fault, and the mask would
/// only hide features for no gain.
pub const WHPX_CPU_SPEC: &str = "max,-svm,-vmx";

/// Filename of the per-VM guest serial console log, written next to the disk
/// (`<vm_dir>/console.log`) — see [`console_log_path`].
pub const CONSOLE_LOG_FILENAME: &str = "console.log";

/// Host port ranges this allocator must never hand out. 5555–6000 is the RDC
/// Docker track's ADB range (see src-tauri/src/services/docker.rs
/// `suggest_free_adb_port`: 5555..6000).
pub const RESERVED_HOST_PORT_RANGES: &[(u16, u16)] = &[(5555, 6000)];

const DEFAULT_IMAGE: &str = "redroid/redroid:14.0.0-latest";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accel {
    /// Windows Hypervisor Platform (Hyper-V platform feature). Default.
    Whpx,
    /// Pure software emulation — slow but always available (fallback).
    Tcg,
}

impl Accel {
    pub fn as_qemu_arg(self) -> &'static str {
        match self {
            Accel::Whpx => "whpx",
            Accel::Tcg => "tcg",
        }
    }
}

/// How the QEMU process should be detached from the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detach {
    /// Run in the foreground (used by `doctor` probes and debugging).
    Foreground,
    /// POSIX `-daemonize` (QEMU forks itself). Not available on Windows.
    Daemonize,
    /// Windows/Win32: the caller spawns a detached child; no `-daemonize`.
    SpawnDetached,
}

impl Detach {
    /// The detach mode that is correct on the current platform.
    pub fn platform_default() -> Self {
        if cfg!(windows) {
            Detach::SpawnDetached
        } else {
            Detach::Daemonize
        }
    }

    fn uses_daemonize(self) -> bool {
        matches!(self, Detach::Daemonize)
    }
}

/// One QEMU user-mode network forward (host port → guest port).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortForward {
    pub host_port: u16,
    pub guest_port: u16,
    pub udp: bool,
}

impl PortForward {
    pub fn tcp(host_port: u16, guest_port: u16) -> Self {
        Self {
            host_port,
            guest_port,
            udp: false,
        }
    }

    /// `tcp::2222-:22` / `udp::5555-:5555` — the slirp `hostfwd` syntax.
    pub fn to_hostfwd(self) -> String {
        format!(
            "{}::{} -:{}",
            if self.udp { "udp" } else { "tcp" },
            self.host_port,
            self.guest_port
        )
        .replace(" -:", "-:")
    }
}

/// Build the `hostfwd=...` list for a VM: SSH plus one rule per ADB port.
/// ADB uses host port == guest port (the guest Docker publishes the container
/// on the same number), which keeps `adb connect 127.0.0.1:<port>` guessing-free.
pub fn hostfwd_rules(ssh_host_port: u16, adb_ports: &[u16]) -> Vec<PortForward> {
    let mut rules = vec![PortForward::tcp(ssh_host_port, 22)];
    for p in adb_ports {
        rules.push(PortForward::tcp(*p, *p));
    }
    rules
}

/// The `-netdev user,...` argument string for a set of forwards.
pub fn netdev_user_arg(ssh_host_port: u16, adb_ports: &[u16]) -> String {
    let mut s = String::from("user,id=net0");
    for r in hostfwd_rules(ssh_host_port, adb_ports) {
        s.push_str(&format!(",hostfwd={}", r.to_hostfwd()));
    }
    s
}

/// Everything needed to assemble a QEMU launch command.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchOptions {
    /// QEMU binary (absolute path from [`crate::doctor`] discovery, or name on PATH).
    pub qemu_bin: String,
    pub name: String,
    pub vcpus: u16,
    pub mem_mib: u32,
    pub accel: Accel,
    pub detach: Detach,
    pub disk: PathBuf,
    /// Cloud-init NoCloud seed *image* — a self-built FAT16 file (`seed.img`,
    /// [`crate::fat::build_fat16_image`]) attached as an ordinary read-only
    /// virtio disk. Carrier history, each prior step falsified on the user's
    /// real WHPX host: the self-built ISO stored names uppercase, and QEMU
    /// VVFAT (`file=fat:<dir>`) hard-wires its volume label to `QEMU VVFAT`,
    /// so `ds-identify`'s `LABEL=cidata` scan found nothing and cloud-init
    /// never activated. The FAT16 image carries label `CIDATA` + lowercase
    /// LFN names — validated end-to-end on the same machine (see README).
    pub seed_image: Option<PathBuf>,
    pub ssh_host_port: u16,
    pub adb_ports: Vec<u16>,
    pub qmp_host_port: u16,
}

/// Assemble the full QEMU argv (program first). Pure — the runtime only spawns it.
pub fn qemu_command(o: &LaunchOptions) -> Vec<String> {
    let mut a: Vec<String> = vec![
        o.qemu_bin.clone(),
        "-name".into(),
        format!("qemu-center-{}", o.name),
        "-machine".into(),
        "q35".into(),
        "-accel".into(),
        o.accel.as_qemu_arg().into(),
    ];
    // WHPX only: pin the CPU model. Without it QEMU's default model exposes
    // nested-virtualisation bits the host cannot back, and the guest hangs on
    // a flood of "WHPX: Unexpected VP exit code 4" — see [`WHPX_CPU_SPEC`] for
    // the real-machine A/B evidence. TCG keeps QEMU's default model.
    if o.accel == Accel::Whpx {
        a.push("-cpu".into());
        a.push(WHPX_CPU_SPEC.into());
    }
    a.push("-m".into());
    a.push(format!("{}", o.mem_mib));
    a.push("-smp".into());
    a.push(format!("{}", o.vcpus));
    // Data disk: qcow2 overlay (usually backed by the Ubuntu cloud image).
    // `id=` is what QMP addresses the live disk by (`blockdev-snapshot-internal-sync`
    // in [`DISK_DEVICE_ID`]); auto-generated node names are not stable.
    a.push("-drive".into());
    a.push(format!(
        "file={},if=virtio,format=qcow2,cache=writeback,id={DISK_DEVICE_ID}",
        o.disk.display()
    ));
    if let Some(seed) = &o.seed_image {
        // NoCloud seed as a plain virtio disk: a bare FAT16 volume (no
        // partition table) with volume label `CIDATA` and the seed files
        // stored under their exact lowercase names via VFAT LFN entries.
        // Replaced QEMU VVFAT, whose fixed `QEMU VVFAT` label the guest's
        // ds-identify could never match — see crate::fat and README.
        a.push("-drive".into());
        a.push(format!(
            "file={},if=virtio,format=raw,read-only=on",
            seed.display()
        ));
    }
    // Entropy for cloud-init's ssh host key generation (boot latency).
    a.push("-device".into());
    a.push("virtio-rng-pci".into());
    // User-mode networking with all forwards pre-declared (slirp cannot be
    // extended after start without QMP).
    a.push("-netdev".into());
    a.push(netdev_user_arg(o.ssh_host_port, &o.adb_ports));
    a.push("-device".into());
    a.push("virtio-net-pci,netdev=net0".into());
    // Headless: no display at all (redroid is driven via adb/scrcpy on the host).
    a.push("-display".into());
    a.push("none".into());
    // Guest serial console → `<vm_dir>/console.log` (same directory as the
    // disk). Independent of `-display none`: it is a chardev writing the guest
    // kernel / Android console to a file, and it is the only post-mortem view
    // into a guest that hung before its network came up — the WHPX freezes
    // behind [`WHPX_CPU_SPEC`] left a qemu.log full of VP exits and nothing
    // about what the guest was doing. Both accelerators get it: a hang under
    // TCG needs the same evidence.
    a.push("-serial".into());
    a.push(format!("file:{}", qemu_path_arg(&console_log_path(&o.disk))));
    // Per-VM QMP socket for `vm stop` (`system_powerdown`).
    a.push("-qmp".into());
    a.push(format!(
        "tcp:127.0.0.1:{},server=on,wait=off",
        o.qmp_host_port
    ));
    if o.detach.uses_daemonize() {
        a.push("-daemonize".into());
    }
    a
}

/// Suggested QEMU binary name per platform (search key for discovery).
pub fn qemu_binary_name() -> &'static str {
    if cfg!(windows) {
        "qemu-system-x86_64.exe"
    } else {
        "qemu-system-x86_64"
    }
}

// ---------------------------------------------------------------- qemu-img --

/// `qemu-img create -f qcow2 <path> <size>G` — a scratch disk.
pub fn qemu_img_create(qemu_img_bin: &str, path: &Path, size_gib: u32) -> Vec<String> {
    vec![
        qemu_img_bin.to_string(),
        "create".into(),
        "-f".into(),
        "qcow2".into(),
        path.display().to_string(),
        format!("{size_gib}G"),
    ]
}

/// `qemu-img create -f qcow2 -b <base> -F qcow2 <path>` — an overlay disk.
/// The Ubuntu cloud image stays pristine and shareable between VMs.
pub fn qemu_img_create_overlay(
    qemu_img_bin: &str,
    path: &Path,
    base: &Path,
    size_gib: Option<u32>,
) -> Vec<String> {
    let mut a = vec![
        qemu_img_bin.to_string(),
        "create".into(),
        "-f".into(),
        "qcow2".into(),
        "-b".into(),
        base.display().to_string(),
        "-F".into(),
        "qcow2".into(),
        path.display().to_string(),
    ];
    if let Some(g) = size_gib {
        a.push(format!("{g}G"));
    }
    a
}

/// `qemu-img snapshot -c <tag> <disk>` — internal qcow2 snapshot.
///
/// **Bug A (real machine, QEMU 11.1)**: running this against a disk that a
/// *live* QEMU has open (`cache=writeback`) writes an invalid snapshot table
/// entry. Every later `qemu-img` call then fails with `Too much extra metadata
/// in snapshot table entry 0`, `vm start` refuses to open the disk at all, and
/// `qemu-img check -r all` degrades it further (`Preventing invalid write on
/// metadata (overlaps with snapshot table)`) until the node is unrecoverable.
///
/// So this argv is legal **only** when no QEMU owns the image. Resolve
/// [`snapshot_plan`] first and use [`qmp_internal_snapshot_frame`] whenever the
/// VM is running.
pub fn qemu_img_snapshot_create(qemu_img_bin: &str, disk: &Path, tag: &str) -> Vec<String> {
    vec![
        qemu_img_bin.to_string(),
        "snapshot".into(),
        "-c".into(),
        tag.into(),
        disk.display().to_string(),
    ]
}

/// `qemu-img snapshot -d <tag> <disk>` — drop an internal snapshot. This writes
/// to the image too, so it obeys the same live-disk rule as
/// [`qemu_img_snapshot_create`].
pub fn qemu_img_snapshot_delete(qemu_img_bin: &str, disk: &Path, tag: &str) -> Vec<String> {
    vec![
        qemu_img_bin.to_string(),
        "snapshot".into(),
        "-d".into(),
        tag.into(),
        disk.display().to_string(),
    ]
}

/// `qemu-img snapshot -a <tag> <disk>` — restore (apply) an internal qcow2
/// snapshot. The VM must be stopped: qemu-img refuses to touch an image that
/// is locked by a running qemu process, and even where it succeeds the guest
/// would keep running on stale in-memory state.
pub fn qemu_img_snapshot_apply(qemu_img_bin: &str, disk: &Path, tag: &str) -> Vec<String> {
    vec![
        qemu_img_bin.to_string(),
        "snapshot".into(),
        "-a".into(),
        tag.into(),
        disk.display().to_string(),
    ]
}

/// `qemu-img info --output=json <disk>` — used to check a disk's backing file.
pub fn qemu_img_info(qemu_img_bin: &str, disk: &Path) -> Vec<String> {
    vec![
        qemu_img_bin.to_string(),
        "info".into(),
        "--output=json".into(),
        disk.display().to_string(),
    ]
}

/// Snapshot tags must be safe in a qemu-img argv and in a `snapshot -d` later.
pub fn validate_snapshot_tag(tag: &str) -> Result<(), String> {
    if tag.is_empty() || tag.len() > 32 {
        return Err("snapshot tag must be 1..=32 chars".into());
    }
    if !tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("snapshot tag {tag:?} has unsafe characters"));
    }
    Ok(())
}

/// VM names become directory + file names and QEMU `-name` values.
pub fn validate_vm_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 24 {
        return Err("VM name must be 1..=24 chars".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "VM name {name:?} must be lowercase [a-z0-9-] (it is used as a path component)"
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("VM name must not start or end with '-'".into());
    }
    Ok(())
}

// -------------------------------------------------------------------- ports --

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortError {
    /// The requested block size is zero.
    ZeroCount,
    /// No run of `count` free, non-reserved ports exists at/above `base`.
    Exhausted { base: u16, count: u16 },
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortError::ZeroCount => write!(f, "port block size must be > 0"),
            PortError::Exhausted { base, count } => write!(
                f,
                "no free block of {count} ports at or above {base} (65535 limit / reserved ranges)"
            ),
        }
    }
}

impl std::error::Error for PortError {}

pub fn port_is_reserved(p: u16) -> bool {
    RESERVED_HOST_PORT_RANGES
        .iter()
        .any(|(lo, hi)| p >= *lo && p <= *hi)
}

/// First free non-reserved port at/above `base`.
pub fn next_free_port(used: &BTreeSet<u16>, base: u16) -> Option<u16> {
    (base..=u16::MAX).find(|p| !used.contains(p) && !port_is_reserved(*p))
}

/// Allocate `count` consecutive free non-reserved ports at/above `base`.
/// Consecutive (not scattered) so the VM's hostfwd block is human-readable.
pub fn allocate_port_block(
    used: &BTreeSet<u16>,
    base: u16,
    count: u16,
) -> Result<Vec<u16>, PortError> {
    if count == 0 {
        return Err(PortError::ZeroCount);
    }
    let mut start = base;
    // Block must fit below the 65535 ceiling.
    while (start as u32) + (count as u32) - 1 <= u16::MAX as u32 {
        let block: Vec<u16> = (start..start + count).collect();
        if block
            .iter()
            .all(|p| !used.contains(p) && !port_is_reserved(*p))
        {
            return Ok(block);
        }
        start += 1;
    }
    Err(PortError::Exhausted { base, count })
}

// ----------------------------------------------------------------- registry --

/// One VM's persistent record in `state.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VmEntry {
    pub name: String,
    /// Ubuntu cloud image this VM's disk overlays (read-only base).
    pub base_image: Option<PathBuf>,
    pub disk: PathBuf,
    pub vcpus: u16,
    pub mem_mib: u32,
    pub accel: Accel,
    pub ssh_host_port: u16,
    pub qmp_host_port: u16,
    /// Reserved ADB host-port block (host port == guest port).
    pub adb_ports: Vec<u16>,
    /// redroid container name → ADB host port, inside the block above.
    pub adb_assignments: BTreeMap<String, u16>,
    /// qcow2 internal snapshot tags created via `vm snapshot`.
    pub snapshots: Vec<String>,
    /// SystemTime::now() as unix seconds (no chrono dependency).
    pub created_at_unix: u64,
    pub cloud_init: crate::cloudinit::CloudInitConfig,
    /// Container image used by `redroid create` defaults for this VM.
    pub redroid_image: String,
}

impl VmEntry {
    /// Ports occupied in the guest by redroid containers: host port == guest
    /// port, so an assignment is simply the port the guest Docker publishes on.
    pub fn assigned_ports(&self) -> BTreeSet<u16> {
        self.adb_assignments.values().copied().collect()
    }

    /// Next unused port from this VM's block, for a new container.
    pub fn next_free_adb_port(&self) -> Option<u16> {
        let used = self.assigned_ports();
        self.adb_ports.iter().copied().find(|p| !used.contains(p))
    }
}

/// Root of `state.json` (schema-versioned).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub vms: Vec<VmEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            vms: Vec::new(),
        }
    }
}

impl Registry {
    pub fn get(&self, name: &str) -> Option<&VmEntry> {
        self.vms.iter().find(|v| v.name == name)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut VmEntry> {
        self.vms.iter_mut().find(|v| v.name == name)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// Every port owned by every VM (ssh, qmp and every reserved ADB port —
    /// the whole block is bound by hostfwd at boot, so the whole block counts).
    pub fn used_ports(&self) -> BTreeSet<u16> {
        let mut s = BTreeSet::new();
        for v in &self.vms {
            s.insert(v.ssh_host_port);
            s.insert(v.qmp_host_port);
            s.extend(v.adb_ports.iter().copied());
        }
        s
    }
}

/// Default state directory: `%APPDATA%\QemuCenter` on Windows,
/// `~/.config/QemuCenter` on Linux/macOS. Falls back to `./qemu-center-state`.
pub fn default_state_dir() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("QemuCenter"))
        .unwrap_or_else(|| PathBuf::from("qemu-center-state"))
}

pub fn registry_path(state_dir: &Path) -> PathBuf {
    state_dir.join("state.json")
}

pub fn vm_dir(state_dir: &Path, name: &str) -> PathBuf {
    state_dir.join("vms").join(name)
}

pub fn vm_disk_path(state_dir: &Path, name: &str) -> PathBuf {
    vm_dir(state_dir, name).join("disk.qcow2")
}

/// Seed image of a VM: the self-built FAT16 cloud-init NoCloud disk
/// (output of [`crate::fat::build_fat16_image`]), attached read-only at
/// `vm start`.
pub fn vm_seed_image(state_dir: &Path, name: &str) -> PathBuf {
    vm_dir(state_dir, name).join("seed.img")
}

pub fn vm_ssh_key_path(state_dir: &Path, name: &str) -> PathBuf {
    state_dir.join("keys").join(format!("{name}_ed25519"))
}

pub fn vm_ssh_key_pub_path(state_dir: &Path, name: &str) -> PathBuf {
    state_dir
        .join("keys")
        .join(format!("{name}_ed25519.pub"))
}

pub fn vm_known_hosts_path(state_dir: &Path, name: &str) -> PathBuf {
    vm_dir(state_dir, name).join("known_hosts")
}

/// Where a detached QEMU's stdout+stderr go: `vms/<name>/qemu.log` (appended
/// across starts). A detached child must not inherit the CLI's stdio — that
/// would keep the caller's pipe open for as long as the VM lives (see
/// [`crate::exec::detached_stdio_redirection`]); a log file is what the
/// operator wants instead of `/dev/null` when a VM fails to boot.
pub fn vm_qemu_log_path(state_dir: &Path, name: &str) -> PathBuf {
    vm_dir(state_dir, name).join("qemu.log")
}

/// Host-side path of a VM's guest serial console log, derived from the disk
/// path so it always lands in the same directory: `<vm_dir>/console.log`.
///
/// [`qemu_command`] hands this to `-serial file:<path>`; the guest
/// kernel/Android console is written there by QEMU, independently of the
/// `qemu.log` that captures QEMU's *own* stdout/stderr. A bare filename (disk
/// given with no parent directory) degrades to a relative `console.log`
/// instead of panicking.
pub fn console_log_path(disk: &Path) -> PathBuf {
    match disk.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(CONSOLE_LOG_FILENAME),
        _ => PathBuf::from(CONSOLE_LOG_FILENAME),
    }
}

/// Convenience wrapper around [`console_log_path`] for the standard layout
/// (`vms/<name>/disk.qcow2` → `vms/<name>/console.log`).
pub fn vm_console_log_path(state_dir: &Path, name: &str) -> PathBuf {
    console_log_path(&vm_disk_path(state_dir, name))
}

/// Render a host path for use **inside** a QEMU option value (after `file:` /
/// `file=`) with `/` separators.
///
/// Backslashes do work in QEMU's Windows file handling (`-drive
/// file=C:\...\disk.qcow2` is the verified form), but `Path::join` happily
/// produces mixed `\`+`/` output, and `/` is accepted by every Windows file
/// API QEMU can reach — so new option values are emitted the unambiguous way.
/// The `-drive` disk/seed arguments keep their existing rendering untouched:
/// those are the forms already proven on the user's real machine.
fn qemu_path_arg(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// Load the registry; a missing file is an empty registry (first run).
pub fn load_registry(state_dir: &Path) -> Result<Registry, String> {
    let path = registry_path(state_dir);
    if !path.exists() {
        return Ok(Registry::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Registry::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Persist the registry atomically: write `state.json.tmp` then rename over
/// `state.json`. Atomic on NTFS/POSIX, so a crash never leaves a half file.
/// Known limitation: no cross-process lock (see module docs).
pub fn save_registry(state_dir: &Path, reg: &Registry) -> Result<(), String> {
    std::fs::create_dir_all(state_dir)
        .map_err(|e| format!("mkdir {}: {e}", state_dir.display()))?;
    let path = registry_path(state_dir);
    let tmp = state_dir.join("state.json.tmp");
    let body = serde_json::to_string_pretty(reg).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        )
    })
}

/// Now, as unix seconds (std-only; no chrono in this crate).
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Default container image for new VMs (mirrors the RDC Docker track's redroid
/// image family; kept as its own constant — this crate imports nothing from RDC).
pub fn default_redroid_image() -> String {
    DEFAULT_IMAGE.to_string()
}

// ---------------------------------------------------------------------- QMP --

/// QMP frames for a graceful shutdown: negotiate capabilities, then ask ACPI
/// to power the guest down. Sent as newline-delimited JSON over TCP.
pub fn qmp_stop_frames() -> Vec<&'static str> {
    vec![
        r#"{"execute":"qmp_capabilities"}"#,
        r#"{"execute":"system_powerdown"}"#,
    ]
}

/// A QMP reply is an error iff it carries a non-null `error` member.
pub fn qmp_reply_is_ok(reply: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(reply.trim()) {
        Ok(v) => v.get("error").map(|e| e.is_null()).unwrap_or(true),
        Err(_) => false,
    }
}

/// QEMU's QMP greeting (`{"QMP": {...}}`) must arrive before any command.
pub fn qmp_greeting_received(line: &str) -> bool {
    line.contains("\"QMP\"")
}

/// `qmp_capabilities` — the mandatory first command on every QMP connection
/// (downstream commands are rejected until it succeeds).
pub fn qmp_capabilities_frame() -> &'static str {
    r#"{"execute":"qmp_capabilities"}"#
}

/// `blockdev-snapshot-internal-sync` — the only correct way to write an internal
/// snapshot into a disk that a **running** QEMU has open (Bug A). Synchronous:
/// the reply arrives once the snapshot table entry exists, so the caller can
/// time it. Addressable by device id (`-drive id=disk0`) or by node name.
///
/// Built with `serde_json` rather than `format!` so a tag can never break the
/// frame's quoting.
pub fn qmp_internal_snapshot_frame(device: &str, tag: &str) -> String {
    serde_json::json!({
        "execute": "blockdev-snapshot-internal-sync",
        "arguments": { "device": device, "name": tag },
    })
    .to_string()
}

/// `blockdev-snapshot-delete-internal-sync` — drop an internal snapshot of a
/// running VM (same `device`/`name` arguments as the create frame). Used to keep
/// a timing probe from accumulating snapshot table entries.
pub fn qmp_delete_internal_snapshot_frame(device: &str, tag: &str) -> String {
    serde_json::json!({
        "execute": "blockdev-snapshot-delete-internal-sync",
        "arguments": { "device": device, "name": tag },
    })
    .to_string()
}

/// `query-block` — lists every block device with its active image. Used to find
/// the device that owns a VM's disk, so the QMP snapshot works even for VMs
/// started before the `id=disk0` argv convention existed.
pub fn qmp_query_block_frame() -> &'static str {
    r#"{"execute":"query-block"}"#
}

/// The `error.desc` of a QMP reply, if it is an error reply.
pub fn qmp_reply_error(reply: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(reply.trim()).ok()?;
    let e = v.get("error")?;
    if e.is_null() {
        return None;
    }
    Some(
        e.get("desc")
            .and_then(|d| d.as_str())
            .unwrap_or("unspecified QMP error")
            .to_string(),
    )
}

/// Image paths from QEMU and from state.json differ only in separators and
/// case (QEMU echoes the `-drive file=` string back verbatim).
fn normalize_image_path(p: &str) -> String {
    p.replace('\\', "/").to_ascii_lowercase()
}

/// Find the `device` entry of a `query-block` reply whose active image is
/// `disk` — i.e. the block device QMP commands must address.
pub fn qmp_device_for_disk(query_block_reply: &str, disk: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(query_block_reply.trim()).ok()?;
    let want = normalize_image_path(&disk.to_string_lossy());
    v.get("return")?
        .as_array()?
        .iter()
        .find_map(|dev| {
            let file = dev.pointer("/inserted/file")?.as_str()?;
            if normalize_image_path(file) == want {
                dev.get("device")?.as_str().map(str::to_string)
            } else {
                None
            }
        })
}

// ------------------------------------------------- live-disk write safety ----

/// What a probe of a VM's QMP endpoint saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QmpProbe {
    /// A QMP greeting came back: a QEMU process is running for this VM and owns
    /// its disks right now.
    Answered,
    /// Connection refused: nothing is listening, so the VM is stopped.
    Refused,
    /// No answer within the budget (filtered/foreign listener, hung process):
    /// liveness is unknown.
    TimedOut,
}

/// Whether a VM's disk is owned by a running QEMU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmLiveness {
    Running,
    Stopped,
    /// Could not be established. Every write path treats this as "probably
    /// live", never as "safe to touch".
    Unknown,
}

/// Pure: map a QMP probe outcome onto VM liveness. The QMP endpoint exists
/// exactly while the QEMU process does, which is the only reliable signal this
/// crate has (Windows' `file-win32` takes no image lock, so "can I open the
/// qcow2?" cannot answer it).
pub fn vm_liveness_from_qmp_probe(probe: QmpProbe) -> VmLiveness {
    match probe {
        QmpProbe::Answered => VmLiveness::Running,
        QmpProbe::Refused => VmLiveness::Stopped,
        QmpProbe::TimedOut => VmLiveness::Unknown,
    }
}

/// How an internal snapshot may be taken without endangering the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotPlan {
    /// No running QEMU owns the image: `qemu-img snapshot -c` is safe.
    QemuImg,
    /// A running QEMU owns the image: only QMP may write to it
    /// ([`qmp_internal_snapshot_frame`]).
    QmpInternal,
    /// The image cannot be proven idle and no safe channel exists: skip the
    /// step and report honestly. **Never** falls back to `qemu-img` (Bug A).
    Skip(&'static str),
}

/// Pure: decide how — or whether — an internal snapshot may be taken.
///
/// The invariant that fixes Bug A: [`VmLiveness::Running`] **never** yields
/// [`SnapshotPlan::QemuImg`]. A live disk may only be written through QMP, and
/// when even that is unavailable the probe is skipped instead of risking the
/// image. `qmp_usable` is the runtime's verdict that the QMP channel works
/// (greeting received, capabilities negotiated).
pub fn snapshot_plan(liveness: VmLiveness, qmp_usable: bool) -> SnapshotPlan {
    match liveness {
        VmLiveness::Stopped => SnapshotPlan::QemuImg,
        VmLiveness::Running if qmp_usable => SnapshotPlan::QmpInternal,
        VmLiveness::Running => SnapshotPlan::Skip(
            "the VM is running but its QMP endpoint is unusable: refusing to write \
             to the live disk with qemu-img (that corrupts qcow2 images)",
        ),
        VmLiveness::Unknown => SnapshotPlan::Skip(
            "could not prove the disk is idle (no QMP answer): refusing to write \
             to a possibly live disk with qemu-img",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> LaunchOptions {
        LaunchOptions {
            qemu_bin: "qemu-system-x86_64".into(),
            name: "node1".into(),
            vcpus: 4,
            mem_mib: 4096,
            accel: Accel::Whpx,
            detach: Detach::SpawnDetached,
            disk: PathBuf::from("C:/qc/vms/node1/disk.qcow2"),
            seed_image: Some(PathBuf::from("C:/qc/vms/node1/seed.img")),
            ssh_host_port: 22300,
            adb_ports: vec![24500, 24501],
            qmp_host_port: 23300,
        }
    }

    fn joined(a: &[String]) -> String {
        a.join(" ")
    }

    /// Value that follows `flag` in an argv (`-cpu` → `max,-svm,-vmx`), or
    /// `None` when the flag is absent. Takes the first occurrence.
    fn flag_value(argv: &[String], flag: &str) -> Option<String> {
        argv.iter()
            .position(|a| a == flag)
            .and_then(|i| argv.get(i + 1).cloned())
    }

    // --- command assembly ---

    #[test]
    fn qemu_command_snapshot_whpx_headless() {
        let cmd = qemu_command(&opts());
        assert_eq!(cmd[0], "qemu-system-x86_64");
        let s = joined(&cmd);
        println!("WHPX argv: {s}");
        for expect in [
            "-name qemu-center-node1",
            "-machine q35",
            "-accel whpx",
            "-cpu max,-svm,-vmx",
            "-m 4096",
            "-smp 4",
            "file=C:/qc/vms/node1/disk.qcow2,if=virtio,format=qcow2,cache=writeback",
            "file=C:/qc/vms/node1/seed.img,if=virtio,format=raw,read-only=on",
            "-device virtio-rng-pci",
            "-device virtio-net-pci,netdev=net0",
            "-display none",
            "-serial file:C:/qc/vms/node1/console.log",
            "-qmp tcp:127.0.0.1:23300,server=on,wait=off",
        ] {
            assert!(s.contains(expect), "missing {expect:?} in {s}");
        }
        // Slirp forwards: ssh + both adb ports.
        assert!(s.contains("hostfwd=tcp::22300-:22"));
        assert!(s.contains("hostfwd=tcp::24500-:24500"));
        assert!(s.contains("hostfwd=tcp::24501-:24501"));
    }

    /// The WHPX hang fix, as an argv assertion: real-machine evidence showed a
    /// guest wedged behind "WHPX: Unexpected VP exit code 4" (plus the
    /// `CPUID[eax=80000001h].ECX.svm` warning) when QEMU ran its default CPU
    /// model; pinning `max,-svm,-vmx` — the only variable in the A/B — took the
    /// counter to 0. Losing this flag is a regression to that hang.
    #[test]
    fn whpx_pins_cpu_model_masking_nested_virt() {
        assert_eq!(WHPX_CPU_SPEC, "max,-svm,-vmx");
        let cmd = qemu_command(&opts());
        assert_eq!(flag_value(&cmd, "-cpu").as_deref(), Some(WHPX_CPU_SPEC));
        // Positioned as a compact `-accel whpx -cpu ...` pair.
        let s = joined(&cmd);
        assert!(s.contains("-accel whpx -cpu max,-svm,-vmx"), "in {s}");
    }

    /// The mask is WHPX-only and must not leak into the TCG variant.
    #[test]
    fn tcg_keeps_the_default_cpu_model() {
        let mut o = opts();
        o.accel = Accel::Tcg;
        let cmd = qemu_command(&o);
        let s = joined(&cmd);
        println!("TCG argv: {s}");
        assert_eq!(flag_value(&cmd, "-cpu"), None, "in {s}");
        assert!(!s.contains("svm"), "TCG must not carry the WHPX mask: {s}");
        assert!(!s.contains("vmx"), "TCG must not carry the WHPX mask: {s}");
    }

    /// `-serial file:<vm_dir>/console.log` on both accelerators, without
    /// disturbing `-display none` or the QMP endpoint.
    #[test]
    fn serial_console_log_lands_next_to_the_disk_for_both_accels() {
        for accel in [Accel::Whpx, Accel::Tcg] {
            let mut o = opts();
            o.accel = accel;
            let cmd = qemu_command(&o);
            let s = joined(&cmd);
            assert_eq!(
                flag_value(&cmd, "-serial").as_deref(),
                Some("file:C:/qc/vms/node1/console.log"),
                "-serial wrong for {accel:?}"
            );
            assert!(s.contains("-display none"), "display disturbed for {accel:?}");
            assert!(
                s.contains("-qmp tcp:127.0.0.1:23300,server=on,wait=off"),
                "QMP disturbed for {accel:?}"
            );
        }
    }

    #[test]
    fn console_log_path_follows_the_disk_directory() {
        assert_eq!(
            console_log_path(Path::new("C:/qc/vms/node1/disk.qcow2")),
            PathBuf::from("C:/qc/vms/node1/console.log")
        );
        assert_eq!(
            vm_console_log_path(Path::new("C:/qc"), "node1"),
            PathBuf::from("C:/qc/vms/node1/console.log")
        );
        // Relative/malformed disks must not panic and must not escape the cwd.
        assert_eq!(console_log_path(Path::new("disk.qcow2")), PathBuf::from("console.log"));
        assert_eq!(console_log_path(Path::new("")), PathBuf::from("console.log"));
    }

    /// Real-machine shape: the state dir is a Windows path with backslashes, so
    /// `Path::join` yields `...\node1\console.log`. QEMU must receive it in the
    /// `/`-separated form (see [`qemu_path_arg`]) — never a mixed `\`+`/` path.
    #[cfg(windows)]
    #[test]
    fn serial_renders_a_windows_disk_path_with_forward_slashes() {
        let mut o = opts();
        o.disk =
            PathBuf::from(r"F:\code\project\Android-Device\qemu-center\state\vms\node1\disk.qcow2");
        let cmd = qemu_command(&o);
        assert_eq!(
            flag_value(&cmd, "-serial").as_deref(),
            Some("file:F:/code/project/Android-Device/qemu-center/state/vms/node1/console.log")
        );
    }

    /// `-serial` is a chardev, not a display: a VM launched without any seeded
    /// disk must still get its console log.
    #[test]
    fn serial_is_present_without_a_seed_image() {
        let mut o = opts();
        o.seed_image = None;
        o.accel = Accel::Tcg;
        let cmd = qemu_command(&o);
        assert_eq!(
            flag_value(&cmd, "-serial").as_deref(),
            Some("file:C:/qc/vms/node1/console.log")
        );
    }

    #[test]
    fn daemonize_only_on_posix_style_detach() {
        let mut o = opts();
        o.detach = Detach::Foreground;
        assert!(!qemu_command(&o).contains(&"-daemonize".to_string()));
        o.detach = Detach::SpawnDetached;
        assert!(!qemu_command(&o).contains(&"-daemonize".to_string()));
        o.detach = Detach::Daemonize;
        assert_eq!(qemu_command(&o).last().unwrap(), "-daemonize");
        // Platform default is spawn-detached on Windows, -daemonize elsewhere.
        if cfg!(windows) {
            assert_eq!(Detach::platform_default(), Detach::SpawnDetached);
        } else {
            assert_eq!(Detach::platform_default(), Detach::Daemonize);
        }
    }

    #[test]
    fn tcg_accel_and_no_seed_variant() {
        let mut o = opts();
        o.accel = Accel::Tcg;
        o.seed_image = None;
        let cmd = qemu_command(&o);
        let s = joined(&cmd);
        assert!(s.contains("-accel tcg"));
        // No seed image → no second drive at all (old state.json VMs without
        // a seed.img on disk start exactly as before, just seedless).
        assert!(!s.contains("seed.img"));
        // The data disk drive remains — and only it.
        let drives: Vec<&String> = cmd
            .windows(2)
            .filter(|w| w[0] == "-drive")
            .map(|w| &w[1])
            .collect();
        assert_eq!(drives.len(), 1);
        assert!(drives[0].starts_with("file=C:/qc/vms/node1/disk.qcow2"));
    }

    #[test]
    fn hostfwd_rules_ssh_first_then_adb() {
        let rules = hostfwd_rules(22300, &[24500, 24501]);
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].host_port, 22300);
        assert_eq!(rules[0].guest_port, 22);
        assert_eq!(rules[1].to_hostfwd(), "tcp::24500-:24500");
        assert_eq!(PortForward { host_port: 5353, guest_port: 5353, udp: true }.to_hostfwd(), "udp::5353-:5353");
    }

    #[test]
    fn netdev_arg_has_id_and_no_trailing_comma_without_forwards() {
        assert_eq!(netdev_user_arg(22300, &[]), "user,id=net0,hostfwd=tcp::22300-:22");
    }

    // --- qemu-img + validation ---

    #[test]
    fn qemu_img_commands() {
        let d = Path::new("/s/vms/a/disk.qcow2");
        assert_eq!(
            qemu_img_create("qemu-img", d, 40),
            vec!["qemu-img", "create", "-f", "qcow2", "/s/vms/a/disk.qcow2", "40G"]
        );
        assert_eq!(
            qemu_img_create_overlay("qemu-img", d, Path::new("/s/base.img"), None),
            vec![
                "qemu-img",
                "create",
                "-f",
                "qcow2",
                "-b",
                "/s/base.img",
                "-F",
                "qcow2",
                "/s/vms/a/disk.qcow2"
            ]
        );
        assert_eq!(
            qemu_img_snapshot_create("qemu-img", d, "clean-1"),
            vec!["qemu-img", "snapshot", "-c", "clean-1", "/s/vms/a/disk.qcow2"]
        );
        assert_eq!(
            qemu_img_snapshot_apply("qemu-img", d, "clean-1"),
            vec!["qemu-img", "snapshot", "-a", "clean-1", "/s/vms/a/disk.qcow2"]
        );
        assert_eq!(
            qemu_img_info("qemu-img", d),
            vec!["qemu-img", "info", "--output=json", "/s/vms/a/disk.qcow2"]
        );
    }

    #[test]
    fn snapshot_tag_validation() {
        assert!(validate_snapshot_tag("clean-1").is_ok());
        assert!(validate_snapshot_tag("v1.2_ok").is_ok());
        assert!(validate_snapshot_tag("").is_err());
        assert!(validate_snapshot_tag("a b").is_err());
        assert!(validate_snapshot_tag("a;b").is_err());
        assert!(validate_snapshot_tag(&"x".repeat(33)).is_err());
    }

    #[test]
    fn vm_name_validation_blocks_path_traversal() {
        assert!(validate_vm_name("node1").is_ok());
        assert!(validate_vm_name("node-1").is_ok());
        assert!(validate_vm_name("../evil").is_err());
        assert!(validate_vm_name("Node1").is_err());
        assert!(validate_vm_name("node 1").is_err());
        assert!(validate_vm_name("-node").is_err());
        assert!(validate_vm_name(&"n".repeat(25)).is_err());
    }

    // --- port allocation ---

    #[test]
    fn allocate_port_block_returns_consecutive_ports() {
        let used = BTreeSet::new();
        assert_eq!(
            allocate_port_block(&used, 24500, 3).unwrap(),
            vec![24500, 24501, 24502]
        );
    }

    #[test]
    fn allocate_port_block_skips_used_and_reserved() {
        let mut used: BTreeSet<u16> = BTreeSet::new();
        used.insert(24500);
        used.insert(24502);
        assert_eq!(
            allocate_port_block(&used, 24500, 2).unwrap(),
            vec![24503, 24504]
        );
        // A block that would overlap the RDC Docker range 5555-6000 is refused
        // by sliding past it entirely.
        let block = allocate_port_block(&BTreeSet::new(), 5999, 3).unwrap();
        assert_eq!(block, vec![6001, 6002, 6003]);
    }

    #[test]
    fn allocate_port_block_never_overlaps_between_vms() {
        let mut used = BTreeSet::new();
        let a = allocate_port_block(&used, DEFAULT_ADB_PORT_BASE, 4).unwrap();
        used.extend(a.iter().copied());
        let b = allocate_port_block(&used, DEFAULT_ADB_PORT_BASE, 4).unwrap();
        used.extend(b.iter().copied());
        let c = allocate_port_block(&used, DEFAULT_ADB_PORT_BASE, 4).unwrap();
        let all: BTreeSet<u16> = a.iter().chain(b.iter()).chain(c.iter()).copied().collect();
        assert_eq!(all.len(), 12, "port blocks must be disjoint");
        assert!(b.iter().all(|p| !a.contains(p)));
        assert!(c.iter().all(|p| !a.contains(p) && !b.contains(p)));
    }

    #[test]
    fn allocate_port_block_rejects_zero_and_exhaustion() {
        assert_eq!(
            allocate_port_block(&BTreeSet::new(), 24500, 0),
            Err(PortError::ZeroCount)
        );
        assert!(matches!(
            allocate_port_block(&BTreeSet::new(), 65535, 2),
            Err(PortError::Exhausted { .. })
        ));
    }

    #[test]
    fn reserved_range_covers_rdc_docker_ports() {
        assert!(port_is_reserved(5555));
        assert!(port_is_reserved(6000));
        assert!(!port_is_reserved(6001));
        assert!(!port_is_reserved(24500));
        assert_eq!(next_free_port(&BTreeSet::new(), 5999), Some(6001));
    }

    // --- registry ---

    fn entry(name: &str, ssh: u16, adb: Vec<u16>) -> VmEntry {
        VmEntry {
            name: name.into(),
            base_image: Some(PathBuf::from("C:/qc/base/ubuntu-24.04.qcow2")),
            disk: PathBuf::from(format!("C:/qc/vms/{name}/disk.qcow2")),
            vcpus: 4,
            mem_mib: 4096,
            accel: Accel::Whpx,
            ssh_host_port: ssh,
            qmp_host_port: 23300,
            adb_ports: adb,
            adb_assignments: BTreeMap::new(),
            snapshots: Vec::new(),
            created_at_unix: 1_760_000_000,
            cloud_init: crate::cloudinit::CloudInitConfig {
                hostname: name.into(),
                ssh_pubkey: "ssh-ed25519 AAAA test".into(),
                docker_install: "get-docker".into(),
            },
            redroid_image: default_redroid_image(),
        }
    }

    #[test]
    fn registry_json_roundtrip() {
        let mut reg = Registry::default();
        let mut e = entry("node1", 22300, vec![24500, 24501]);
        e.adb_assignments.insert("qc-r1".into(), 24500);
        e.snapshots.push("clean".into());
        reg.vms.push(e.clone());
        let json = serde_json::to_string_pretty(&reg).unwrap();
        let back: Registry = serde_json::from_str(&json).unwrap();
        assert_eq!(back, reg);
        assert_eq!(back.vms[0].adb_assignments["qc-r1"], 24500);
    }

    #[test]
    fn registry_get_contains_and_used_ports() {
        let mut reg = Registry::default();
        reg.vms.push(entry("a", 22300, vec![24500, 24501]));
        reg.vms.push(entry("b", 22301, vec![24502, 24503]));
        assert!(reg.contains("a"));
        assert!(!reg.contains("c"));
        assert!(reg.get_mut("a").is_some());
        let used = reg.used_ports();
        assert!(used.contains(&22300) && used.contains(&23300));
        assert!(used.contains(&24503) && !used.contains(&24504));
    }

    #[test]
    fn registry_load_missing_file_is_empty_and_roundtrips_on_disk() {
        let dir = std::env::temp_dir().join(format!("qc-reg-test-{}", now_unix()));
        let _ = std::fs::remove_dir_all(&dir);
        // Missing file → default empty registry.
        let reg = load_registry(&dir).unwrap();
        assert_eq!(reg, Registry::default());
        assert_eq!(reg.version, STATE_VERSION);

        let mut reg = Registry::default();
        reg.vms.push(entry("node1", 22300, vec![24500]));
        save_registry(&dir, &reg).unwrap();
        // Atomic write leaves no temp file behind.
        assert!(!dir.join("state.json.tmp").exists());
        let back = load_registry(&dir).unwrap();
        assert_eq!(back, reg);
        // Overwriting is idempotent.
        save_registry(&dir, &reg).unwrap();
        assert_eq!(load_registry(&dir).unwrap(), reg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_load_rejects_corrupt_json() {
        let dir = std::env::temp_dir().join(format!("qc-reg-bad-{}", now_unix()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(registry_path(&dir), "{not json").unwrap();
        assert!(load_registry(&dir).is_err());
        // An empty file is treated as "no state yet".
        std::fs::write(registry_path(&dir), "   ").unwrap();
        assert_eq!(load_registry(&dir).unwrap(), Registry::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vm_entry_port_assignment_is_unique_per_container() {
        let mut e = entry("node1", 22300, vec![24500, 24501, 24502]);
        assert_eq!(e.next_free_adb_port(), Some(24500));
        e.adb_assignments.insert("r1".into(), 24500);
        assert_eq!(e.next_free_adb_port(), Some(24501));
        e.adb_assignments.insert("r2".into(), 24501);
        e.adb_assignments.insert("r3".into(), 24502);
        assert_eq!(e.next_free_adb_port(), None, "block exhausted");
        assert_eq!(e.adb_assignments.len(), e.adb_ports.len());
    }

    #[test]
    fn vm_paths_are_derived_from_state_dir_and_name() {
        let s = Path::new("C:/qc");
        assert_eq!(vm_dir(s, "node1"), PathBuf::from("C:/qc/vms/node1"));
        assert_eq!(
            vm_disk_path(s, "node1"),
            PathBuf::from("C:/qc/vms/node1/disk.qcow2")
        );
        assert_eq!(
            vm_seed_image(s, "node1"),
            PathBuf::from("C:/qc/vms/node1/seed.img")
        );
        assert_eq!(
            vm_ssh_key_path(s, "node1"),
            PathBuf::from("C:/qc/keys/node1_ed25519")
        );
        assert_eq!(registry_path(s), PathBuf::from("C:/qc/state.json"));
    }

    // --- QMP ---

    #[test]
    fn qmp_frames_and_reply_parsing() {
        let f = qmp_stop_frames();
        assert_eq!(f.len(), 2);
        assert!(f[0].contains("qmp_capabilities"));
        assert!(f[1].contains("system_powerdown"));
        assert!(qmp_reply_is_ok(r#"{"return": {}}"#));
        assert!(qmp_reply_is_ok(r#"{"return": {}}"#));
        assert!(!qmp_reply_is_ok(r#"{"error": {"class": "GenericError", "desc": "x"}}"#));
        assert!(!qmp_reply_is_ok("not json"));
        assert!(qmp_greeting_received(
            r#"{"QMP": {"version": {"qemu": {"major": 8}}, "capabilities": []}}"#
        ));
        assert!(!qmp_greeting_received(r#"{"return": {}}"#));
    }

    #[test]
    fn qmp_internal_snapshot_frames_are_well_formed() {
        let f = qmp_internal_snapshot_frame(DISK_DEVICE_ID, "verify-1789462000");
        let v: serde_json::Value = serde_json::from_str(&f).unwrap();
        assert_eq!(v["execute"], "blockdev-snapshot-internal-sync");
        assert_eq!(v["arguments"]["device"], "disk0");
        assert_eq!(v["arguments"]["name"], "verify-1789462000");

        let d = qmp_delete_internal_snapshot_frame("disk0", "verify-1789462000");
        let v: serde_json::Value = serde_json::from_str(&d).unwrap();
        assert_eq!(v["execute"], "blockdev-snapshot-delete-internal-sync");
        assert_eq!(v["arguments"]["device"], "disk0");
        assert_eq!(v["arguments"]["name"], "verify-1789462000");

        assert_eq!(qmp_query_block_frame(), r#"{"execute":"query-block"}"#);
        assert_eq!(qmp_capabilities_frame(), r#"{"execute":"qmp_capabilities"}"#);
        // The shutdown frames must reuse the same capabilities frame.
        assert_eq!(qmp_stop_frames()[0], qmp_capabilities_frame());

        // Frames are built by serde_json, so even a hostile tag cannot break
        // out of the JSON string (qemu-img would be vulnerable to an argv here).
        let weird = qmp_internal_snapshot_frame("disk0", "a\"b\\c");
        let v: serde_json::Value = serde_json::from_str(&weird).unwrap();
        assert_eq!(v["arguments"]["name"], "a\"b\\c");
        assert_eq!(v["arguments"]["device"], "disk0");
    }

    #[test]
    fn qmp_reply_error_extracts_the_description() {
        assert_eq!(qmp_reply_error(r#"{"return": {}}"#), None);
        assert_eq!(
            qmp_reply_error(
                r#"{"error":{"class":"GenericError","desc":"internal snapshots not supported"}}"#
            ),
            Some("internal snapshots not supported".to_string())
        );
        assert_eq!(qmp_reply_error(r#"{"error":null}"#), None);
        assert_eq!(
            qmp_reply_error(r#"{"error":{"class":"GenericError"}}"#),
            Some("unspecified QMP error".to_string())
        );
        assert_eq!(qmp_reply_error("garbage"), None);
    }

    #[test]
    fn query_block_devices_are_matched_by_image_path() {
        let reply = r#"{"return":[
            {"device":"seed0","inserted":{"file":"C:/qc/vms/node1/seed.img"}},
            {"device":"disk0","inserted":{"file":"C:\\qc\\vms\\node1\\disk.qcow2","backing_file":"base.img"}},
            {"device":"cd0"}
        ]}"#;
        assert_eq!(
            qmp_device_for_disk(reply, Path::new("C:/qc/vms/node1/disk.qcow2")),
            Some("disk0".to_string())
        );
        // Separator + case differences still match (QEMU echoes our -drive string).
        assert_eq!(
            qmp_device_for_disk(reply, Path::new(r"C:\QC\vms\NODE1\Disk.QCOW2")),
            Some("disk0".to_string())
        );
        // A different VM's disk never matches (no cross-node snapshot).
        assert_eq!(
            qmp_device_for_disk(reply, Path::new("C:/qc/vms/other/disk.qcow2")),
            None
        );
        assert_eq!(qmp_device_for_disk("not json", Path::new("x")), None);
        assert_eq!(qmp_device_for_disk(r#"{"error":{}}"#, Path::new("x")), None);
    }

    /// **Bug A invariant.** A disk owned by a running QEMU must never be written
    /// with `qemu-img`; when QMP is unavailable the step is skipped and reported
    /// as UNTESTED rather than risking the image.
    #[test]
    fn snapshot_plan_never_uses_qemu_img_while_a_vm_runs() {
        for qmp_usable in [true, false] {
            let plan = snapshot_plan(VmLiveness::Running, qmp_usable);
            assert_ne!(
                plan,
                SnapshotPlan::QemuImg,
                "a live disk must never go through qemu-img"
            );
        }
        assert_eq!(
            snapshot_plan(VmLiveness::Running, true),
            SnapshotPlan::QmpInternal
        );
        assert!(matches!(
            snapshot_plan(VmLiveness::Running, false),
            SnapshotPlan::Skip(_)
        ));
        // Unknown liveness is never "safe to write" either.
        assert!(matches!(
            snapshot_plan(VmLiveness::Unknown, true),
            SnapshotPlan::Skip(_)
        ));
        assert!(matches!(
            snapshot_plan(VmLiveness::Unknown, false),
            SnapshotPlan::Skip(_)
        ));
        // Only a *proven* stopped VM goes through qemu-img.
        assert_eq!(snapshot_plan(VmLiveness::Stopped, true), SnapshotPlan::QemuImg);
        assert_eq!(snapshot_plan(VmLiveness::Stopped, false), SnapshotPlan::QemuImg);
        // Every skip reason names the hazard so reports stay honest.
        for liveness in [VmLiveness::Running, VmLiveness::Unknown] {
            match snapshot_plan(liveness, false) {
                SnapshotPlan::Skip(why) => {
                    assert!(why.contains("qemu-img"), "{why}");
                    assert!(why.contains("refusing"), "{why}");
                }
                other => panic!("expected Skip for {liveness:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn qmp_probe_maps_to_liveness_without_guessing() {
        assert_eq!(
            vm_liveness_from_qmp_probe(QmpProbe::Answered),
            VmLiveness::Running
        );
        assert_eq!(
            vm_liveness_from_qmp_probe(QmpProbe::Refused),
            VmLiveness::Stopped
        );
        assert_eq!(
            vm_liveness_from_qmp_probe(QmpProbe::TimedOut),
            VmLiveness::Unknown
        );
    }

    #[test]
    fn qemu_img_snapshot_delete_command() {
        let d = Path::new("/s/vms/a/disk.qcow2");
        assert_eq!(
            qemu_img_snapshot_delete("qemu-img", d, "verify-1"),
            vec![
                "qemu-img",
                "snapshot",
                "-d",
                "verify-1",
                "/s/vms/a/disk.qcow2"
            ]
        );
    }

    #[test]
    fn data_disk_carries_the_qmp_device_id() {
        let cmd = qemu_command(&opts());
        let s = joined(&cmd);
        // QMP addresses the live disk by this id (blockdev-snapshot-internal-sync).
        assert!(
            s.contains("cache=writeback,id=disk0"),
            "data disk must carry id=disk0: {s}"
        );
        // The seed disk stays id-less (never snapshotted, never addressed by QMP).
        assert!(!s.contains("seed.img,if=virtio,format=raw,read-only=on,id="));
    }
}
