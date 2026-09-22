//! `verify` — the seven acceptance criteria of the QEMU track, as a runnable
//! report for a real machine.
//!
//! Each item is split in two: a **command assembly** function (pure) and a
//! **judgement** function over the captured output (pure, unit-tested here).
//! The runtime half shells out over SSH / adb / qemu-img and can only report
//! honestly what this machine sees — on a host without a running VM every item
//! reports `UNTESTED` with the reason. That is by design: `verify` is meant to
//! be run by the operator on their own machine, not in CI.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::exec;
use crate::guest;
use crate::qmp;
use crate::redroid;
use crate::vm;

/// Marker printed by the SSH reachability probe.
pub const SSH_OK_MARKER: &str = "__QC_SSH_OK__";

/// The seven acceptance criteria, in order (single source for the table in
/// README.md: item number, id, title).
pub const CHECK_SPECS: &[(&str, &str)] = &[
    ("whpx", "WHPX acceleration available on the host"),
    ("ssh", "guest reachable over SSH (rdc@127.0.0.1:<port>)"),
    (
        "binderfs",
        "binder support visible in the guest (/proc/filesystems)",
    ),
    ("docker", "docker engine usable inside the guest"),
    (
        "boot-completed",
        "redroid container reports sys.boot_completed=1",
    ),
    (
        "adb-connect",
        "host adb connects to 127.0.0.1:<port> and getprop answers",
    ),
    (
        "clone-timing",
        "qcow2 snapshot + clone complete (informational timing)",
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Verdict {
    Pass,
    Fail,
    /// Could not be tested here (no VM, no adb, wrong host) — not a failure.
    Untested,
}

impl Verdict {
    pub fn marker(self) -> &'static str {
        match self {
            Verdict::Pass => "[PASS]",
            Verdict::Fail => "[FAIL]",
            Verdict::Untested => "[UNTESTED]",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyCheck {
    pub id: &'static str,
    pub title: &'static str,
    pub verdict: Verdict,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    pub vm: String,
    pub container: Option<String>,
    pub checks: Vec<VerifyCheck>,
}

impl VerifyReport {
    pub fn counts(&self) -> (usize, usize, usize) {
        let p = self
            .checks
            .iter()
            .filter(|c| c.verdict == Verdict::Pass)
            .count();
        let f = self
            .checks
            .iter()
            .filter(|c| c.verdict == Verdict::Fail)
            .count();
        let u = self.checks.len() - p - f;
        (p, f, u)
    }

    /// All seven passed (used by the CLI exit code).
    pub fn all_pass(&self) -> bool {
        self.checks.len() == CHECK_SPECS.len()
            && self.checks.iter().all(|c| c.verdict == Verdict::Pass)
    }

    pub fn to_text(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "QemuCenter verify — node {}{}\n",
            self.vm,
            self.container
                .as_ref()
                .map(|c| format!(", container {c}"))
                .unwrap_or_default()
        ));
        s.push_str("phase 0 acceptance criteria (run on a real host; see README)\n\n");
        for (i, c) in self.checks.iter().enumerate() {
            s.push_str(&format!(
                "{:<10} {}/{} {:<14} {}\n",
                c.verdict.marker(),
                i + 1,
                CHECK_SPECS.len(),
                c.id,
                c.title
            ));
            if !c.detail.is_empty() {
                s.push_str(&format!("           {}\n", c.detail));
            }
        }
        let (p, f, u) = self.counts();
        s.push_str(&format!("\nsummary: {p} pass / {f} fail / {u} untested\n"));
        if u > 0 {
            s.push_str(
                "note: UNTESTED means the check could not run on this machine \
                 (VM stopped/not created, tool missing) — not a failure.\n",
            );
        }
        s
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

// ------------------------------------------------------------ judgements ----

/// 1. WHPX: map the doctor probe verdict onto an acceptance verdict.
pub fn judge_whpx(probe: &crate::doctor::ProbeVerdict) -> (Verdict, String) {
    use crate::doctor::ProbeVerdict as P;
    match probe {
        P::Available => (
            Verdict::Pass,
            "qemu -accel whpx -machine q35 initialized OK".into(),
        ),
        P::NotAvailable(l) => (Verdict::Fail, l.clone()),
        P::Unknown(l) => (Verdict::Untested, l.clone()),
    }
}

/// 2. SSH: the probe echoes a unique marker, so a lost connection cannot be
/// mistaken for success (empty stdout / banner-only output fails).
pub fn judge_ssh_reachable(success: bool, stdout: &str) -> (Verdict, String) {
    if success && stdout.contains(SSH_OK_MARKER) {
        (Verdict::Pass, "marker echoed back over ssh".into())
    } else {
        let why = if stdout.trim().is_empty() {
            "no output (stopped VM / key not accepted?)".to_string()
        } else {
            format!("unexpected output: {}", first_line(stdout))
        };
        (Verdict::Fail, why)
    }
}

/// 3. binderfs: shared with `guest`.
pub fn judge_binderfs(success: bool, stdout: &str) -> (Verdict, String) {
    if !success {
        return (Verdict::Untested, "could not read /proc/filesystems".into());
    }
    if guest::judge_proc_filesystems_binder(stdout) {
        (Verdict::Pass, "kernel reports binder support".into())
    } else {
        (
            Verdict::Fail,
            "no binder/binderfs in /proc/filesystems (linux-modules-extra missing?)".into(),
        )
    }
}

/// 4. docker: a non-empty server version string means the daemon answered.
pub fn judge_docker(success: bool, stdout: &str) -> (Verdict, String) {
    let v = stdout.trim();
    if !success {
        return (
            Verdict::Fail,
            format!("docker version failed: {}", first_line(stdout)),
        );
    }
    if v.is_empty() || v.to_ascii_lowercase().contains("cannot connect") {
        return (Verdict::Fail, "docker daemon not answering".into());
    }
    (Verdict::Pass, format!("server version {v}"))
}

/// 5. boot_completed: redroid's `getprop sys.boot_completed` must be exactly 1.
pub fn judge_boot(success: bool, stdout: &str) -> (Verdict, String) {
    if success && redroid::judge_boot_completed(stdout) {
        (Verdict::Pass, "sys.boot_completed=1".into())
    } else if !success {
        (
            Verdict::Fail,
            "docker exec failed (container missing?)".into(),
        )
    } else {
        (
            Verdict::Untested,
            format!("still booting (getprop returned {:?})", stdout.trim()),
        )
    }
}
/// 6. host-side adb: `adb connect` must report a connection, then `getprop`
/// over that serial must return a non-empty, non-error answer.
pub fn judge_adb_connect(success: bool, stdout: &str) -> (Verdict, String) {
    let s = stdout.to_ascii_lowercase();
    let connects = s.contains("connected to") || s.contains("already connected to");
    if !success || !connects {
        return (
            Verdict::Fail,
            format!("adb connect said: {}", first_line(stdout)),
        );
    }
    if s.contains("cannot") || s.contains("failed") {
        return (Verdict::Fail, first_line(stdout));
    }
    (Verdict::Pass, first_line(stdout))
}

/// `adb -s <serial> shell getprop <prop>` must yield a non-empty value.
pub fn judge_adb_getprop(success: bool, stdout: &str) -> (Verdict, String) {
    let v = stdout.trim();
    if success && !v.is_empty() && !v.to_ascii_lowercase().contains("error") {
        (Verdict::Pass, format!("getprop -> {v}"))
    } else {
        (
            Verdict::Fail,
            format!("no usable getprop output: {:?}", first_line(stdout)),
        )
    }
}

/// 7. snapshot + clone timing: informational. Both commands must succeed; the
/// measured durations are recorded in the detail for the acceptance notes.
///
/// Thin wrapper over [`judge_clone_timing_probe`] for the stopped-VM path (the
/// original signature is kept so existing callers/tests stay valid).
pub fn judge_clone_timing(
    snapshot_ok: bool,
    clone_ok: bool,
    snapshot_ms: u128,
    clone_ms: u128,
) -> (Verdict, String) {
    judge_clone_timing_probe(&TimingProbe {
        path: SnapshotPath::QemuImg,
        snapshot_ok,
        clone_ok,
        snapshot_ms,
        clone_ms,
        tag: "",
        note: "",
    })
}

/// Which mechanism produced the internal snapshot of item 7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotPath {
    /// VM stopped, image unowned: `qemu-img snapshot -c`.
    QemuImg,
    /// VM running, image open: QMP `blockdev-snapshot-internal-sync`.
    QmpInternal,
}

/// One timing-probe attempt (item 7).
#[derive(Debug, Clone)]
pub struct TimingProbe<'a> {
    pub path: SnapshotPath,
    pub snapshot_ok: bool,
    pub clone_ok: bool,
    pub snapshot_ms: u128,
    pub clone_ms: u128,
    /// Snapshot tag, recorded so a leftover entry can be identified.
    pub tag: &'a str,
    /// Extra context: QMP device, cleanup result, first error line.
    pub note: &'a str,
}

/// Judgement for item 7. The paths differ in *how* the snapshot was taken, not
/// in what counts as success: both snapshot and clone must complete.
pub fn judge_clone_timing_probe(p: &TimingProbe<'_>) -> (Verdict, String) {
    let timing = format!("snapshot {} ms, clone {} ms", p.snapshot_ms, p.clone_ms);
    let how = match p.path {
        SnapshotPath::QemuImg => "qemu-img snapshot",
        SnapshotPath::QmpInternal => "qmp internal snapshot",
    };
    let extra = match (p.tag.is_empty(), p.note.is_empty()) {
        (true, true) => String::new(),
        (false, true) => format!("; {how} {} removed after the probe", p.tag),
        (true, false) => format!("; {}", p.note),
        (false, false) => format!("; {how} {}: {}", p.tag, p.note),
    };
    match (p.path, p.snapshot_ok, p.clone_ok) {
        (SnapshotPath::QemuImg, true, true) => {
            (Verdict::Pass, format!("{timing} (informational){extra}"))
        }
        (SnapshotPath::QemuImg, false, _) => (
            Verdict::Fail,
            format!("qemu-img snapshot failed; {timing}{extra}"),
        ),
        (_, true, false) => (
            Verdict::Fail,
            format!("qemu-img backing clone failed; {timing}{extra}"),
        ),
        (SnapshotPath::QmpInternal, true, true) => (
            Verdict::Pass,
            format!("{timing} (informational, live via QMP){extra}"),
        ),
        (SnapshotPath::QmpInternal, false, _) => (
            Verdict::Fail,
            format!("qmp internal snapshot failed; {timing}{extra}"),
        ),
    }
}

/// Item 7 when the probe refused to touch the disk: honest UNTESTED, never a
/// fake PASS and never a `qemu-img` write against a possibly live image
/// (Bug A — `qemu-img snapshot -c` on a disk a running QEMU has open corrupts
/// the qcow2 beyond repair).
pub fn judge_clone_timing_skipped(why: &str) -> (Verdict, String) {
    (
        Verdict::Untested,
        format!("snapshot step skipped for disk safety: {why}"),
    )
}

fn first_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("(no output)")
        .to_string()
}

// --------------------------------------------------------- command assembly --

/// SSH probe remote command.
pub fn ssh_marker_command() -> &'static str {
    "echo __QC_SSH_OK__"
}

/// `adb connect 127.0.0.1:<port>`.
pub fn adb_connect_command(port: u16) -> Vec<String> {
    vec!["adb".into(), "connect".into(), format!("127.0.0.1:{port}")]
}

/// adb serial for a forwarded port (host port == adb port).
pub fn adb_serial(port: u16) -> String {
    format!("127.0.0.1:{port}")
}

/// `adb -s <serial> shell getprop <prop>`.
pub fn adb_getprop_command(port: u16, prop: &str) -> Vec<String> {
    vec![
        "adb".into(),
        "-s".into(),
        adb_serial(port),
        "shell".into(),
        "getprop".into(),
        prop.into(),
    ]
}

/// Build the not-run report used when a precondition is missing (no such VM,
/// no container): every item is UNTESTED with the same reason, so the operator
/// sees the full seven-item table rather than an empty run.
pub fn untested_report(vm: &str, container: Option<&str>, reason: &str) -> VerifyReport {
    VerifyReport {
        vm: vm.to_string(),
        container: container.map(str::to_string),
        checks: CHECK_SPECS
            .iter()
            .map(|(id, title)| VerifyCheck {
                id,
                title,
                verdict: Verdict::Untested,
                detail: reason.to_string(),
            })
            .collect(),
    }
}

// ----------------------------------------------------------------- runtime --

fn find_qemu_img(state_dir: &Path) -> Option<std::path::PathBuf> {
    crate::doctor::discover_qemu_img_with(Some(state_dir))
}

/// Run all seven checks against the machine as it is right now.
///
/// `container`: which redroid instance to probe for items 5–6; `None` picks the
/// VM's first port assignment (or reports UNTESTED when there is none).
pub fn run_verify(state_dir: &Path, vm_name: &str, container: Option<&str>) -> VerifyReport {
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => {
            return untested_report(vm_name, container, &format!("state.json unreadable: {e}"))
        }
    };
    let Some(entry) = registry.get(vm_name) else {
        return untested_report(
            vm_name,
            container,
            &format!("VM {vm_name:?} is not in state.json (run `vm create` first)"),
        );
    };

    // Resolve the container and its port.
    let (container_name, port) = match container {
        Some(c) => match entry.adb_assignments.get(c) {
            Some(p) => (c.to_string(), *p),
            None => {
                return untested_report(
                    vm_name,
                    container,
                    &format!("instance {c:?} has no port assignment on VM {vm_name:?}"),
                )
            }
        },
        None => match entry.adb_assignments.iter().next() {
            Some((c, p)) => (c.clone(), *p),
            None => {
                return untested_report(
                    vm_name,
                    container,
                    "no redroid instance assigned on this VM (run `redroid create`)",
                )
            }
        },
    };

    let key = vm::vm_ssh_key_path(state_dir, vm_name);
    let known_hosts = vm::vm_known_hosts_path(state_dir, vm_name);
    let ssh = |remote: &str| {
        exec::run_command(
            &guest::ssh_command(&key, &known_hosts, entry.ssh_host_port, remote),
            Duration::from_secs(30),
        )
    };

    let mut checks: Vec<VerifyCheck> = Vec::with_capacity(CHECK_SPECS.len());
    let mut push = |id: &'static str, (verdict, detail): (Verdict, String)| {
        let title = CHECK_SPECS
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, t)| *t)
            .unwrap_or("");
        checks.push(VerifyCheck {
            id,
            title,
            verdict,
            detail,
        });
    };

    // 1. WHPX (host-side).
    match crate::doctor::discover_qemu_bin_with(Some(state_dir)) {
        Some(bin) => {
            // 8 s budget: the q35 probe never exits when WHPX works, so the
            // timeout is its success signature (see doctor::classify_whpx_probe).
            let out = exec::run_command(
                &crate::doctor::qemu_whpx_probe_command(&bin),
                Duration::from_secs(8),
            );
            let kind = if out.timed_out {
                crate::doctor::ProbeOutcomeKind::TimedOut
            } else {
                crate::doctor::ProbeOutcomeKind::Exited
            };
            let verdict = crate::doctor::classify_whpx_probe(kind, out.exit_code, &out.stderr);
            push("whpx", judge_whpx(&verdict));
        }
        None => push(
            "whpx",
            (
                Verdict::Untested,
                "QEMU binary not found (run `doctor`)".into(),
            ),
        ),
    }

    // 2. SSH reachable.
    let out = ssh(ssh_marker_command());
    push("ssh", judge_ssh_reachable(out.success, &out.stdout));

    // 3. binderfs.
    let out = ssh(guest::cmd_cat_proc_filesystems());
    push("binderfs", judge_binderfs(out.success, &out.stdout));

    // 4. docker in guest.
    let out = ssh(guest::cmd_docker_server_version());
    push("docker", judge_docker(out.success, &out.stdout));

    // 5. redroid boot_completed.
    let out = ssh(&guest::cmd_docker_exec_getprop(
        &redroid::container_name(&container_name),
        "sys.boot_completed",
    ));
    push("boot-completed", judge_boot(out.success, &out.stdout));

    // 6. host adb connect + getprop.
    let adb_connect = exec::run_command(&adb_connect_command(port), Duration::from_secs(30));
    let (c_verdict, c_detail) = judge_adb_connect(adb_connect.success, &adb_connect.stdout);
    let getprop = exec::run_command(
        &adb_getprop_command(port, "ro.build.version.release"),
        Duration::from_secs(30),
    );
    let (g_verdict, g_detail) = judge_adb_getprop(getprop.success, &getprop.stdout);
    let verdict = if c_verdict == Verdict::Pass && g_verdict == Verdict::Pass {
        Verdict::Pass
    } else if c_verdict == Verdict::Fail || g_verdict == Verdict::Fail {
        Verdict::Fail
    } else {
        Verdict::Untested
    };
    push("adb-connect", (verdict, format!("{c_detail}; {g_detail}")));

    // 7. snapshot + clone timing (informational).
    let (verdict, detail) = run_clone_timing_probe(state_dir, entry);
    push("clone-timing", (verdict, detail));

    VerifyReport {
        vm: vm_name.to_string(),
        container: Some(container_name),
        checks,
    }
}

/// Item 7's runtime half: resolve the live-disk hazard *first*, then take the
/// snapshot through the only mechanism that is legal for the VM's current
/// state, then time a backing-file clone (read-only on the disk, safe either
/// way) and clean the snapshot up again.
///
/// Bug A, on a real machine: this probe used to run `qemu-img snapshot -c`
/// unconditionally. Against a VM that was up, that wrote an invalid snapshot
/// table entry into the live qcow2 — afterwards `qemu-img` reported "Too much
/// extra metadata in snapshot table entry 0", `vm start` could no longer open
/// the disk, and `qemu-img check -r all` degraded it further until the node had
/// to be deleted. The probe must therefore never be the thing that breaks a
/// disk: when it cannot do the step safely, it says UNTESTED.
fn run_clone_timing_probe(state_dir: &Path, entry: &vm::VmEntry) -> (Verdict, String) {
    let liveness =
        vm::vm_liveness_from_qmp_probe(qmp::probe(entry.qmp_host_port, qmp::PROBE_TIMEOUT));
    // `qmp_usable = true`: an answered probe *is* a working QMP channel. For
    // every other liveness value the plan ignores this flag.
    let plan = vm::snapshot_plan(liveness, true);
    if let vm::SnapshotPlan::Skip(why) = plan {
        return judge_clone_timing_skipped(why);
    }
    let Some(img) = find_qemu_img(state_dir) else {
        return (
            Verdict::Untested,
            "qemu-img not found (run `doctor`)".into(),
        );
    };
    let img_bin = img.display().to_string();
    let tag = format!("verify-{}", vm::now_unix());
    let (path, snapshot_ok, snapshot_ms, note) = match plan {
        vm::SnapshotPlan::QemuImg => {
            let started = std::time::Instant::now();
            let out = exec::run_command(
                &vm::qemu_img_snapshot_create(&img_bin, &entry.disk, &tag),
                Duration::from_secs(120),
            );
            let ms = started.elapsed().as_millis();
            let note = if out.success {
                // Same hygiene as the QMP path: a verify run must not leave
                // snapshot table entries behind on the node's disk.
                let del = exec::run_command(
                    &vm::qemu_img_snapshot_delete(&img_bin, &entry.disk, &tag),
                    Duration::from_secs(120),
                );
                if del.success {
                    String::new()
                } else {
                    format!("left behind (delete failed: {})", del.stderr_last_line())
                }
            } else {
                out.stderr_last_line()
            };
            (SnapshotPath::QemuImg, out.success, ms, note)
        }
        vm::SnapshotPlan::QmpInternal => {
            // The VM is running and owns the disk: QMP is the only legal writer.
            let device =
                match qmp::device_for_disk(entry.qmp_host_port, &entry.disk, qmp::PROBE_TIMEOUT) {
                    Ok(d) => d,
                    Err(e) => {
                        // The channel answered a probe but reconnecting failed:
                        // nothing was written, so this is an honest failure.
                        return (
                            Verdict::Fail,
                            format!(
                                "could not address the live disk over QMP ({e}); \
                             no qemu-img write was attempted"
                            ),
                        );
                    }
                };
            let started = std::time::Instant::now();
            let snap =
                qmp::internal_snapshot(entry.qmp_host_port, &device, &tag, qmp::COMMAND_TIMEOUT);
            let ms = started.elapsed().as_millis();
            let (ok, note) = match snap {
                Ok(()) => {
                    // Timing probe, not a backup: drop it again so repeated
                    // `verify` runs cannot accumulate snapshot table entries.
                    let note = match qmp::delete_internal_snapshot(
                        entry.qmp_host_port,
                        &device,
                        &tag,
                        qmp::COMMAND_TIMEOUT,
                    ) {
                        Ok(()) => format!("on {device}"),
                        Err(e) => format!(
                            "on {device} LEFT BEHIND — delete it with QMP \
                             blockdev-snapshot-delete-internal-sync ({e})"
                        ),
                    };
                    (true, note)
                }
                Err(e) => (false, format!("device {device}: {e}")),
            };
            (SnapshotPath::QmpInternal, ok, ms, note)
        }
        // Handled above; kept exhaustive so the runtime can never reach the
        // qemu-img branch on a live disk.
        vm::SnapshotPlan::Skip(why) => return judge_clone_timing_skipped(why),
    };

    // Backing-file clone: pure metadata + a new file, the disk is only read
    // (read-only backing), so this half is safe for a running VM too.
    let clone_path = entry
        .disk
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!("clone-{tag}.qcow2"));
    let clone_start = std::time::Instant::now();
    let clone = exec::run_command(
        &vm::qemu_img_create_overlay(&img_bin, &clone_path, &entry.disk, None),
        Duration::from_secs(120),
    );
    let clone_ms = clone_start.elapsed().as_millis();
    let _ = std::fs::remove_file(&clone_path); // timing probe, not a real clone

    judge_clone_timing_probe(&TimingProbe {
        path,
        snapshot_ok,
        clone_ok: clone.success,
        snapshot_ms,
        clone_ms,
        tag: &tag,
        note: &note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doctor::ProbeVerdict;

    #[test]
    fn check_specs_are_exactly_seven_unique_items() {
        assert_eq!(CHECK_SPECS.len(), 7);
        let ids: std::collections::BTreeSet<&str> = CHECK_SPECS.iter().map(|(i, _)| *i).collect();
        assert_eq!(ids.len(), 7);
        assert_eq!(ids.iter().next().unwrap(), &"adb-connect"); // sorted first
        for (id, title) in CHECK_SPECS {
            assert!(!id.is_empty() && !title.is_empty());
        }
    }

    #[test]
    fn whpx_judgement_maps_probe_verdicts() {
        assert_eq!(judge_whpx(&ProbeVerdict::Available).0, Verdict::Pass);
        let (v, d) = judge_whpx(&ProbeVerdict::NotAvailable("WHPX is not available".into()));
        assert_eq!(v, Verdict::Fail);
        assert!(d.contains("WHPX is not available"));
        let (v2, _) = judge_whpx(&ProbeVerdict::Unknown("timeout".into()));
        assert_eq!(v2, Verdict::Untested);
    }

    #[test]
    fn ssh_judgement_requires_the_marker() {
        assert_eq!(
            judge_ssh_reachable(true, "__QC_SSH_OK__\n").0,
            Verdict::Pass
        );
        // A banner-only / empty connection is not a pass.
        assert_eq!(judge_ssh_reachable(false, "").0, Verdict::Fail);
        assert_eq!(
            judge_ssh_reachable(true, "Permission denied\n").0,
            Verdict::Fail
        );
        assert_eq!(judge_ssh_reachable(true, "").0, Verdict::Fail);
    }

    #[test]
    fn binderfs_judgement() {
        assert_eq!(
            judge_binderfs(true, "nodev\tsysfs\nnodev\tbinderfs\n").0,
            Verdict::Pass
        );
        assert_eq!(judge_binderfs(true, "nodev\tbpf\n").0, Verdict::Fail);
        assert_eq!(judge_binderfs(false, "").0, Verdict::Untested);
    }

    #[test]
    fn docker_judgement() {
        assert_eq!(judge_docker(true, "27.3.1\n").0, Verdict::Pass);
        assert_eq!(judge_docker(true, "").0, Verdict::Fail);
        assert_eq!(
            judge_docker(true, "Cannot connect to the Docker daemon\n").0,
            Verdict::Fail
        );
        assert_eq!(judge_docker(false, "").0, Verdict::Fail);
    }

    #[test]
    fn boot_judgement_distinguishes_booting_from_missing() {
        assert_eq!(judge_boot(true, "1\n").0, Verdict::Pass);
        // Container exists but Android is still booting: not a failure yet.
        assert_eq!(judge_boot(true, "0\n").0, Verdict::Untested);
        assert_eq!(judge_boot(true, "\n").0, Verdict::Untested);
        // docker exec itself failed: real failure.
        assert_eq!(
            judge_boot(false, "Error: No such container\n").0,
            Verdict::Fail
        );
    }

    #[test]
    fn adb_connect_judgement() {
        assert_eq!(
            judge_adb_connect(true, "connected to 127.0.0.1:24500\n").0,
            Verdict::Pass
        );
        assert_eq!(
            judge_adb_connect(true, "already connected to 127.0.0.1:24500\n").0,
            Verdict::Pass
        );
        assert_eq!(
            judge_adb_connect(true, "cannot connect to 127.0.0.1:24500\n").0,
            Verdict::Fail
        );
        assert_eq!(
            judge_adb_connect(false, "adb: no such file\n").0,
            Verdict::Fail
        );
        assert_eq!(
            judge_adb_connect(true, "* daemon started successfully *\n").0,
            Verdict::Fail
        );
    }

    #[test]
    fn adb_getprop_judgement() {
        assert_eq!(judge_adb_getprop(true, "14\n").0, Verdict::Pass);
        assert_eq!(judge_adb_getprop(true, "\n").0, Verdict::Fail);
        assert_eq!(
            judge_adb_getprop(false, "error: device offline\n").0,
            Verdict::Fail
        );
    }

    #[test]
    fn clone_timing_judgement_records_durations() {
        let (v, d) = judge_clone_timing(true, true, 120, 340);
        assert_eq!(v, Verdict::Pass);
        assert!(d.contains("snapshot 120 ms"));
        assert!(d.contains("clone 340 ms"));
        assert_eq!(judge_clone_timing(false, true, 5, 6).0, Verdict::Fail);
        assert_eq!(judge_clone_timing(true, false, 5, 6).0, Verdict::Fail);
    }

    #[test]
    fn clone_timing_live_path_reports_the_qmp_device_and_tag() {
        let probe = TimingProbe {
            path: SnapshotPath::QmpInternal,
            snapshot_ok: true,
            clone_ok: true,
            snapshot_ms: 44,
            clone_ms: 61,
            tag: "verify-1789462000",
            note: "on disk0",
        };
        let (v, d) = judge_clone_timing_probe(&probe);
        assert_eq!(v, Verdict::Pass);
        assert!(d.contains("snapshot 44 ms"), "{d}");
        assert!(d.contains("clone 61 ms"), "{d}");
        assert!(d.contains("live via QMP"), "{d}");
        assert!(d.contains("qmp internal snapshot verify-1789462000"), "{d}");
        assert!(d.contains("on disk0"), "{d}");
    }

    #[test]
    fn clone_timing_live_path_fails_loudly_when_qmp_rejects_the_snapshot() {
        // A QMP *rejection* is a real failure with an actionable message — not
        // an inconclusive UNTESTED (the channel worked; QEMU said no).
        let probe = TimingProbe {
            path: SnapshotPath::QmpInternal,
            snapshot_ok: false,
            clone_ok: true,
            snapshot_ms: 12,
            clone_ms: 30,
            tag: "verify-1",
            note: "device disk0: qmp rejected: internal snapshots not supported",
        };
        let (v, d) = judge_clone_timing_probe(&probe);
        assert_eq!(v, Verdict::Fail);
        assert!(d.contains("qmp internal snapshot failed"), "{d}");
        assert!(d.contains("internal snapshots not supported"), "{d}");
        // The clone still ran and is reported, so the operator sees both halves.
        assert!(d.contains("clone 30 ms"), "{d}");
    }

    #[test]
    fn clone_timing_skipped_is_untested_and_names_the_hazard() {
        let (v, d) = judge_clone_timing_skipped(
            "the VM is running but its QMP endpoint is unusable: refusing to write \
             to the live disk with qemu-img (that corrupts qcow2 images)",
        );
        assert_eq!(v, Verdict::Untested);
        assert!(d.contains("skipped for disk safety"), "{d}");
        assert!(d.contains("corrupts qcow2"), "{d}");
        // Never a PASS: a skipped probe must not look like a completed one.
        assert_ne!(v, Verdict::Pass);
    }

    /// Item 7 must resolve the live-disk hazard through `snapshot_plan` — the
    /// running case may only ever come out as QMP or Skip (Bug A).
    #[test]
    fn item_seven_never_runs_qemu_img_against_a_running_vm() {
        use crate::vm::{
            snapshot_plan, vm_liveness_from_qmp_probe, QmpProbe, SnapshotPlan, VmLiveness,
        };
        assert_eq!(
            snapshot_plan(vm_liveness_from_qmp_probe(QmpProbe::Answered), true),
            SnapshotPlan::QmpInternal
        );
        assert!(matches!(
            snapshot_plan(vm_liveness_from_qmp_probe(QmpProbe::Answered), false),
            SnapshotPlan::Skip(_)
        ));
        assert!(matches!(
            snapshot_plan(vm_liveness_from_qmp_probe(QmpProbe::TimedOut), true),
            SnapshotPlan::Skip(_)
        ));
        assert_eq!(
            snapshot_plan(vm_liveness_from_qmp_probe(QmpProbe::Refused), true),
            SnapshotPlan::QemuImg,
            "only a proven-stopped VM goes through qemu-img"
        );
        assert_ne!(
            snapshot_plan(VmLiveness::Running, true),
            SnapshotPlan::QemuImg
        );
    }

    #[test]
    fn adb_command_assembly() {
        assert_eq!(
            adb_connect_command(24500),
            vec!["adb", "connect", "127.0.0.1:24500"]
        );
        assert_eq!(adb_serial(24500), "127.0.0.1:24500");
        assert_eq!(
            adb_getprop_command(24500, "ro.build.version.release"),
            vec![
                "adb",
                "-s",
                "127.0.0.1:24500",
                "shell",
                "getprop",
                "ro.build.version.release"
            ]
        );
        assert_eq!(ssh_marker_command(), "echo __QC_SSH_OK__");
    }

    #[test]
    fn untested_report_still_shows_all_seven() {
        let r = untested_report("node1", Some("r1"), "no VM");
        assert_eq!(r.checks.len(), 7);
        assert_eq!(r.counts(), (0, 0, 7));
        assert!(!r.all_pass());
        let text = r.to_text();
        assert!(text.contains("[UNTESTED] 7/7 clone-timing"));
        assert!(text.contains("summary: 0 pass / 0 fail / 7 untested"));
        assert!(text.contains("UNTESTED means"));
    }

    #[test]
    fn report_rendering_and_json_for_mixed_verdicts() {
        let report = VerifyReport {
            vm: "node1".into(),
            container: Some("r1".into()),
            checks: vec![
                VerifyCheck {
                    id: "whpx",
                    title: CHECK_SPECS[0].1,
                    verdict: Verdict::Pass,
                    detail: "ok".into(),
                },
                VerifyCheck {
                    id: "ssh",
                    title: CHECK_SPECS[1].1,
                    verdict: Verdict::Fail,
                    detail: "no output".into(),
                },
                VerifyCheck {
                    id: "boot-completed",
                    title: CHECK_SPECS[4].1,
                    verdict: Verdict::Untested,
                    detail: "still booting".into(),
                },
            ],
        };
        assert_eq!(report.counts(), (1, 1, 1));
        let text = report.to_text();
        assert!(text.contains("[PASS]     1/7 whpx"));
        assert!(text.contains("[FAIL]     2/7 ssh"));
        // Only 3 checks in this report, so the boot item is index 3.
        assert!(text.contains("[UNTESTED] 3/7 boot-completed"));
        let json = report.to_json().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["checks"][0]["verdict"], "PASS");
        assert_eq!(v["checks"][1]["verdict"], "FAIL");
        assert_eq!(v["checks"][2]["verdict"], "UNTESTED");
        assert_eq!(v["container"], "r1");
    }

    #[test]
    fn verdict_markers_are_as_specified() {
        assert_eq!(Verdict::Pass.marker(), "[PASS]");
        assert_eq!(Verdict::Fail.marker(), "[FAIL]");
        assert_eq!(Verdict::Untested.marker(), "[UNTESTED]");
    }
}
