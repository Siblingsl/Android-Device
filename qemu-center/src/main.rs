//! qemu-center — standalone QEMU/WHPX track for the Redroid Device Center.
//!
//! One VM (Ubuntu cloud image under QEMU with WHPX acceleration) = one
//! "node" hosting N redroid containers; adb reaches every container on the
//! host via QEMU user-mode port forwards. This crate is a pure addition to
//! the repository: it imports nothing from `src-tauri` and touches no
//! existing file. See README.md for the honest runtime-verification status:
//! all logic here is unit-tested as pure functions; actual QEMU/SSH/docker
//! execution needs a real WHPX-capable host (`doctor` / `verify`).

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Parser, Subcommand};

use qemu_center::exec::{self, argv_to_display};
use qemu_center::vm::{Accel, Detach, LaunchOptions, PortError, VmEntry};
use qemu_center::{cloudinit, doctor, fat, guest, qmp, redroid, setup, verify, vm};

#[derive(Parser)]
#[command(
    name = "qemu-center",
    version,
    about = "QEMU/WHPX redroid node manager (standalone track; runtime unverified — see README)"
)]
struct Cli {
    /// State directory (registry, VM disks, keys, images, portable QEMU).
    /// Resolution order: this flag > `QEMU_CENTER_STATE_DIR` env var >
    /// platform config dir + /QemuCenter.
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Diagnose the host: WHPX feature, QEMU install, disk space, tools.
    Doctor {
        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// One-shot host preparation (WHPX / QEMU / cloud image). UAC once, reboot once.
    Setup {
        #[command(subcommand)]
        cmd: SetupCmd,
    },
    /// Manage QEMU nodes (one VM = one redroid node).
    Vm {
        #[command(subcommand)]
        cmd: VmCmd,
    },
    /// Guest (VM-internal) operations over SSH.
    Guest {
        #[command(subcommand)]
        cmd: GuestCmd,
    },
    /// Manage redroid containers inside a node's guest.
    Redroid {
        #[command(subcommand)]
        cmd: RedroidCmd,
    },
    /// Show host↔guest ADB port mappings.
    Adb {
        #[command(subcommand)]
        cmd: AdbCmd,
    },
    /// Phase-0 acceptance: the seven checks from README (needs a real host).
    Verify {
        /// VM to verify (default: the first registered one).
        #[arg(long)]
        vm: Option<String>,
        /// redroid instance to probe (default: first assigned on the VM).
        #[arg(long)]
        container: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum SetupCmd {
    /// Enable the WHPX Windows feature (self-elevates; needs one reboot).
    Whpx,
    /// Install QEMU portably into <state-dir>/qemu (default — all artifacts
    /// stay inside the project). `--machine` opts into the machine-wide
    /// winget → scoop → choco → NSIS ladder instead (needs UAC once).
    Qemu {
        /// Machine-wide install (winget/scoop/choco) instead of portable.
        #[arg(long)]
        machine: bool,
    },
    /// Download + SHA256-verify an Ubuntu cloud image into the state dir.
    Image {
        /// Ubuntu release: jammy (22.04) or noble (24.04).
        #[arg(long, default_value = "noble")]
        distro: String,
    },
    /// Run image → qemu → whpx in order, skipping what is already ready.
    All {
        #[arg(long, default_value = "noble")]
        distro: String,
    },
}

#[derive(Subcommand)]
enum VmCmd {
    /// Create a node: overlay disk over the cloud image + seed image + ports.
    Create {
        /// Node name: lowercase [a-z0-9-], used as a path component.
        name: String,
        /// Ubuntu cloud image (qcow2) to use as the read-only backing file.
        #[arg(long)]
        image: PathBuf,
        #[arg(long, default_value_t = 4)]
        cpus: u16,
        /// Guest RAM. 3072 MiB is the balanced default; use 4096+ for a
        /// full single-instance profile after measuring the host budget.
        #[arg(long, default_value_t = 3072)]
        mem: u32,
        /// Virtual disk size (the qcow2 overlay grows on demand).
        #[arg(long, default_value_t = 40)]
        disk_gib: u32,
        /// Accelerator: whpx (default) or tcg (slow software fallback).
        #[arg(long, default_value = "whpx")]
        accel: String,
        /// SSH host port (default: first free at/above 22300).
        #[arg(long)]
        ssh_host_port: Option<u16>,
        /// First ADB host port of this node's forward block.
        #[arg(long, default_value_t = vm::DEFAULT_ADB_PORT_BASE)]
        adb_port_base: u16,
        /// How many ADB forwards to reserve (= max redroid instances).
        #[arg(long, default_value_t = vm::DEFAULT_ADB_PORT_COUNT)]
        adb_port_count: u16,
        /// Docker install channel in the guest: get-docker | apt.
        #[arg(long, default_value = "get-docker")]
        docker_install: String,
        /// SSH public key to inject (default: generate a node-bound key).
        #[arg(long)]
        ssh_pubkey: Option<String>,
        /// Run the matching `setup` steps automatically when prerequisites are
        /// missing (image/qemu/whpx). Without it, missing prerequisites exit 3.
        #[arg(long)]
        auto_setup: bool,
    },
    /// Launch the VM (detached; no console).
    Start { name: String },
    /// Change guest RAM for the next start; the VM must be stopped.
    SetMemory { name: String, mem: u32 },
    /// Graceful ACPI shutdown via the VM's QMP endpoint.
    Stop { name: String },
    /// List registered nodes.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Forget a node (add --purge to also delete its disk and keys).
    Delete {
        name: String,
        #[arg(long)]
        purge: bool,
    },
    /// Take an internal qcow2 snapshot (VM should be stopped).
    Snapshot { name: String, tag: String },
    /// Restore an internal qcow2 snapshot (VM MUST be stopped).
    Restore { name: String, tag: String },
    /// Clone a node as a qcow2 backing-file overlay (fast, CoW).
    Clone { name: String, new_name: String },
}

#[derive(Subcommand)]
enum GuestCmd {
    /// Wait until the guest is provisioned and ready for redroid.
    Wait {
        vm: String,
        #[arg(long, default_value_t = 300)]
        timeout_secs: u64,
    },
    /// Re-apply kernel/docker provisioning inside the guest (recovery path).
    Provision { vm: String },
}

#[derive(Subcommand)]
enum RedroidCmd {
    /// Create a redroid instance on the node (picks a port from its block).
    Create {
        vm: String,
        /// Instance name: lowercase [a-z0-9-] (container becomes qc-<name>).
        name: String,
        /// Optional CPU override; omitted values come from `--profile`.
        #[arg(long)]
        cpus: Option<f64>,
        /// Optional memory override in MiB; omitted values come from `--profile`.
        #[arg(long)]
        memory: Option<u32>,
        /// Resource profile used for validation/metadata: lean, standard, or full.
        #[arg(long, default_value = "standard")]
        profile: String,
        #[arg(long, default_value_t = 720)]
        width: u32,
        #[arg(long, default_value_t = 1280)]
        height: u32,
        #[arg(long, default_value_t = 320)]
        dpi: u32,
        /// guest (SwiftShader, default) or host (needs GPU in the VM).
        #[arg(long, default_value = "guest")]
        gpu_mode: String,
        /// Override the redroid image tag.
        #[arg(long)]
        image: Option<String>,
        /// Read-only guest bind mount, source:target:ro.
        #[arg(long)]
        bind: Vec<String>,
        #[arg(long)]
        cgroup_parent: Option<String>,
    },
    Start {
        vm: String,
        name: String,
    },
    Stop {
        vm: String,
        name: String,
    },
    /// List instances registered on the node.
    List {
        vm: String,
        #[arg(long)]
        json: bool,
    },
    /// Read-only memory, CPU, OOM and boot measurements from the guest.
    Stats {
        vm: String,
        /// Restrict the report to one instance.
        instance: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum AdbCmd {
    /// Print the serial(s) for a node: `127.0.0.1:<port> <instance>`.
    Map {
        vm: String,
        /// Restrict to one instance.
        #[arg(long)]
        name: Option<String>,
    },
    /// List every mapped serial across all nodes.
    List {
        #[arg(long)]
        json: bool,
    },
}

fn main() {
    // Hidden elevated dispatch runs before clap parsing: `setup whpx`
    // relaunches this same binary elevated with `__elevated whpx`; the child
    // runs DISM and writes its exit code into a marker file the parent reads.
    let raw_args: Vec<String> = std::env::args().collect();
    if raw_args.len() >= 3 && raw_args[1] == "__elevated" {
        let state_dir = resolve_state_dir(elevated_state_dir_arg(&raw_args[3..]));
        let code = match raw_args[2].as_str() {
            "whpx" => cmd_elevated_whpx(&state_dir),
            other => {
                eprintln!("unknown elevated action: {other}");
                1
            }
        };
        std::process::exit(code);
    }
    let cli = Cli::parse();
    let state_dir = resolve_state_dir(cli.state_dir);
    let code = match cli.cmd {
        Cmd::Doctor { json } => cmd_doctor(&state_dir, json),
        Cmd::Setup { cmd } => match cmd {
            SetupCmd::Whpx => cmd_setup_whpx(&state_dir),
            SetupCmd::Qemu { machine } => cmd_setup_qemu(&state_dir, machine),
            SetupCmd::Image { distro } => cmd_setup_image(&state_dir, &distro),
            SetupCmd::All { distro } => cmd_setup_all(&state_dir, &distro),
        },
        Cmd::Verify {
            vm,
            container,
            json,
        } => cmd_verify(&state_dir, vm, container, json),
        Cmd::Vm { cmd } => match cmd {
            VmCmd::Create {
                name,
                image,
                cpus,
                mem,
                disk_gib,
                accel,
                ssh_host_port,
                adb_port_base,
                adb_port_count,
                docker_install,
                ssh_pubkey,
                auto_setup,
            } => cmd_vm_create(
                &state_dir,
                &name,
                &image,
                cpus,
                mem,
                disk_gib,
                &accel,
                ssh_host_port,
                adb_port_base,
                adb_port_count,
                &docker_install,
                ssh_pubkey,
                auto_setup,
            ),
            VmCmd::Start { name } => cmd_vm_start(&state_dir, &name),
            VmCmd::SetMemory { name, mem } => cmd_vm_set_memory(&state_dir, &name, mem),
            VmCmd::Stop { name } => cmd_vm_stop(&state_dir, &name),
            VmCmd::List { json } => cmd_vm_list(&state_dir, json),
            VmCmd::Delete { name, purge } => cmd_vm_delete(&state_dir, &name, purge),
            VmCmd::Snapshot { name, tag } => cmd_vm_snapshot(&state_dir, &name, &tag),
            VmCmd::Restore { name, tag } => cmd_vm_restore(&state_dir, &name, &tag),
            VmCmd::Clone { name, new_name } => cmd_vm_clone(&state_dir, &name, &new_name),
        },
        Cmd::Guest { cmd } => match cmd {
            GuestCmd::Wait { vm, timeout_secs } => cmd_guest_wait(&state_dir, &vm, timeout_secs),
            GuestCmd::Provision { vm } => cmd_guest_provision(&state_dir, &vm),
        },
        Cmd::Redroid { cmd } => match cmd {
            RedroidCmd::Create {
                vm,
                name,
                cpus,
                memory,
                profile,
                width,
                height,
                dpi,
                gpu_mode,
                image,
                bind,
                cgroup_parent,
            } => cmd_redroid_create(
                &state_dir,
                &vm,
                &name,
                cpus,
                memory,
                &profile,
                width,
                height,
                dpi,
                &gpu_mode,
                image,
                bind,
                cgroup_parent,
            ),
            RedroidCmd::Start { vm, name } => {
                cmd_redroid_lifecycle(&state_dir, &vm, &name, "start")
            }
            RedroidCmd::Stop { vm, name } => cmd_redroid_lifecycle(&state_dir, &vm, &name, "stop"),
            RedroidCmd::List { vm, json } => cmd_redroid_list(&state_dir, &vm, json),
            RedroidCmd::Stats { vm, instance, json } => {
                cmd_redroid_stats(&state_dir, &vm, instance.as_deref(), json)
            }
        },
        Cmd::Adb { cmd } => match cmd {
            AdbCmd::Map { vm, name } => cmd_adb_map(&state_dir, &vm, name),
            AdbCmd::List { json } => cmd_adb_list(&state_dir, json),
        },
    };
    std::process::exit(code);
}

// ----------------------------------------------------------------- helpers ---

/// State-dir resolution order: explicit CLI `--state-dir` >
/// `QEMU_CENTER_STATE_DIR` environment variable > platform config dir
/// (`%APPDATA%\QemuCenter`). The elevated child resolves the same way so the
/// marker file lands where the parent looks.
fn resolve_state_dir(cli_dir: Option<PathBuf>) -> PathBuf {
    cli_dir
        .or_else(|| std::env::var_os("QEMU_CENTER_STATE_DIR").map(PathBuf::from))
        .unwrap_or_else(vm::default_state_dir)
}

/// `--state-dir <path>` passthrough the elevated child received after its
/// action token (parent forwards it; see `cmd_setup_whpx`).
fn elevated_state_dir_arg(rest: &[String]) -> Option<PathBuf> {
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        if arg == "--state-dir" {
            if let Some(value) = it.next() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

fn err_exit(msg: &str) -> i32 {
    eprintln!("error: {msg}");
    1
}

fn ssh_cmd_for(entry: &VmEntry, state_dir: &Path, remote: &str) -> Vec<String> {
    guest::ssh_command(
        &vm::vm_ssh_key_path(state_dir, &entry.name),
        &vm::vm_known_hosts_path(state_dir, &entry.name),
        entry.ssh_host_port,
        remote,
    )
}

/// Run a docker command inside the guest over ssh.
fn guest_docker(entry: &VmEntry, state_dir: &Path, docker_args: &[String]) -> exec::RunOutcome {
    let remote = guest::docker_command(docker_args);
    let argv = ssh_cmd_for(entry, state_dir, &remote);
    let cmd = argv_to_display(&argv);
    println!("$ {cmd}");
    exec::run_command(&argv, Duration::from_secs(180))
}

fn parse_accel(s: &str) -> Option<Accel> {
    match s.to_ascii_lowercase().as_str() {
        "whpx" => Some(Accel::Whpx),
        "tcg" => Some(Accel::Tcg),
        _ => None,
    }
}

fn parse_gpu_mode(s: &str) -> Option<redroid::GpuMode> {
    match s.to_ascii_lowercase().as_str() {
        "guest" => Some(redroid::GpuMode::Guest),
        "host" => Some(redroid::GpuMode::Host),
        _ => None,
    }
}

// ----------------------------------------------------------------- doctor ---

fn cmd_doctor(state_dir: &Path, json: bool) -> i32 {
    let report = doctor::run_doctor(state_dir);
    if json {
        match report.to_json() {
            Ok(s) => println!("{s}"),
            Err(e) => return err_exit(&format!("serialize report: {e}")),
        }
    } else {
        print!("{}", report.to_text());
        let _ = std::io::stdout().flush();
    }
    if report
        .checks
        .iter()
        .any(|c| c.status == doctor::CheckStatus::Fail)
    {
        2
    } else {
        0
    }
}

// ----------------------------------------------------------------- verify ---

fn cmd_verify(
    state_dir: &Path,
    vm_name: Option<String>,
    container: Option<String>,
    json: bool,
) -> i32 {
    let vm_name = match vm_name {
        Some(n) => n,
        None => match vm::load_registry(state_dir) {
            Ok(r) if !r.vms.is_empty() => r.vms[0].name.clone(),
            Ok(_) => {
                let report = verify::untested_report(
                    "(none)",
                    container.as_deref(),
                    "no VMs registered (run `vm create` first)",
                );
                return finish_verify(report, json);
            }
            Err(e) => return err_exit(&format!("read state: {e}")),
        },
    };
    finish_verify(
        verify::run_verify(state_dir, &vm_name, container.as_deref()),
        json,
    )
}

fn finish_verify(report: verify::VerifyReport, json: bool) -> i32 {
    if json {
        match report.to_json() {
            Ok(s) => println!("{s}"),
            Err(e) => return err_exit(&format!("serialize report: {e}")),
        }
    } else {
        print!("{}", report.to_text());
        let _ = std::io::stdout().flush();
    }
    if report.all_pass() {
        0
    } else if report.counts().1 > 0 {
        1
    } else {
        3
    }
}

// ----------------------------------------------------------------- setup ---

const MARKER_WHPX: &str = "setup-whpx.marker";

fn default_self_exe() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "qemu-center.exe".to_string())
}

fn cmd_setup_whpx(state_dir: &Path) -> i32 {
    let argv = doctor::powershell_feature_command("HypervisorPlatform");
    let out = exec::run_command(&argv, Duration::from_secs(30));
    match doctor::parse_feature_state(&out.stdout) {
        doctor::FeatureState::Enabled => {
            println!("WHPX (HypervisorPlatform) is already enabled — nothing to do.");
            return 0;
        }
        _ => {}
    }
    if cfg!(windows) {
        // Forward the resolved state dir so the elevated child writes its
        // marker where THIS process looks for it (otherwise a custom
        // --state-dir would make the marker land in %APPDATA% and the parent
        // would report a bogus "UAC declined?").
        let state_dir_value = state_dir.to_string_lossy().into_owned();
        let marker_body = setup::run_elevated_capture(
            state_dir,
            &default_self_exe(),
            &["__elevated", "whpx", "--state-dir", &state_dir_value],
            MARKER_WHPX,
        );
        match marker_body {
            Ok(body) => {
                // The elevated child writes "<exit_code>\n<dism stdout>".
                let mut parts = body.splitn(2, '\n');
                let exit_code: i32 = parts.next().unwrap_or("-1").trim().parse().unwrap_or(-1);
                let dism_stdout = parts.next().unwrap_or("");
                match setup::classify_dism_output(exit_code, dism_stdout) {
                    setup::DismOutcome::AlreadyEnabled => {
                        println!("WHPX is already enabled (DISM said so). Nothing to do.");
                        0
                    }
                    setup::DismOutcome::Completed | setup::DismOutcome::NeedsRestart => {
                        println!("WHPX enable completed. A REBOOT is required for it to take effect.");
                        println!("After rebooting, rerun: qemu-center doctor");
                        0
                    }
                    setup::DismOutcome::Unknown => err_exit(&format!(
                        "DISM ended with an unrecognized result (exit {exit_code}); rerun `qemu-center doctor` to check the feature state."
                    )),
                }
            }
            Err(e) => err_exit(&e),
        }
    } else {
        // POSIX has no WHPX; keep the command surface symmetric.
        err_exit("setup whpx is Windows-only (WHPX does not exist on this platform)")
    }
}

/// `setup qemu` — idempotency gate, then the channel: portable into
/// `<state-dir>/qemu` by default, machine-wide only with `--machine`.
fn cmd_setup_qemu(state_dir: &Path, machine: bool) -> i32 {
    if doctor::discover_qemu_bin_with(Some(state_dir)).is_some() {
        println!("QEMU is already installed — nothing to do.");
        return 0;
    }
    if machine {
        cmd_setup_qemu_machine(state_dir)
    } else {
        cmd_setup_qemu_portable(state_dir)
    }
}

/// Default channel: portable NSIS install into `<state-dir>/qemu`. Nothing
/// lands outside the project, nothing touches PATH; uninstalling = deleting
/// the folder.
fn cmd_setup_qemu_portable(state_dir: &Path) -> i32 {
    let target = setup::portable_qemu_dir(state_dir);
    match setup::portable_qemu_plan(&target, target.join(vm::qemu_binary_name()).is_file()) {
        setup::PortableQemuPlan::AlreadyInstalled => {
            println!(
                "portable QEMU already present at {} — nothing to do.",
                target.display()
            );
            return 0;
        }
        setup::PortableQemuPlan::BlockedByWhitespace => {
            let e = setup::validate_portable_target(&target).unwrap_err();
            eprintln!("error: {e}");
            return 1;
        }
        setup::PortableQemuPlan::PortableInstall => {}
    }
    let installer = match download_latest_weilnetz_installer(state_dir) {
        Ok(p) => p,
        Err(e) => {
            return err_exit(&format!(
                "{e} — install QEMU manually, or use `setup qemu --machine` (winget/scoop/choco ladder, machine-wide)"
            ));
        }
    };
    println!("installing QEMU portably into {} ...", target.display());
    println!("note: the NSIS installer may ask for UAC once (its manifest requests elevation) — the files still land only inside the project.");
    let argv = setup::nsis_portable_command(&installer, &target);
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(1800));
    let exe = target.join(vm::qemu_binary_name());
    if !exe.is_file() {
        return err_exit(&format!(
            "portable install did not produce {} (NSIS exit {}) — see the installer output above",
            exe.display(),
            out.exit_code
        ));
    }
    cleanup_setup_tmp(state_dir);
    println!(
        "portable QEMU installed at {} — nothing was installed machine-wide.",
        target.display()
    );
    println!("next: qemu-center doctor");
    0
}

/// `--machine` channel: winget → scoop → choco ladder, with the machine-wide
/// NSIS download now automated as the last resort (`/S`, default install dir
/// — needs an elevated shell).
fn cmd_setup_qemu_machine(state_dir: &Path) -> i32 {
    let channel = setup::qemu_channel_plan(
        exec::where_exists("winget"),
        exec::where_exists("scoop"),
        exec::where_exists("choco"),
    );
    println!("installing QEMU machine-wide via {}:", channel.label());
    match channel {
        setup::QemuChannel::NsisDownload => {
            let installer = match download_latest_weilnetz_installer(state_dir) {
                Ok(p) => p,
                Err(e) => return err_exit(&e),
            };
            let argv = setup::nsis_install_command(&installer);
            println!("$ {}", argv_to_display(&argv));
            let out = exec::run_command(&argv, Duration::from_secs(1800));
            if !out.success {
                return err_exit(&format!(
                    "QEMU install failed ({}): {} (machine-wide NSIS needs an elevated shell)",
                    channel.label(),
                    out.stderr_last_line()
                ));
            }
        }
        _ => {
            let argv = match channel {
                setup::QemuChannel::Winget => setup::winget_install_command(),
                setup::QemuChannel::Scoop => setup::scoop_install_command(),
                setup::QemuChannel::Choco => setup::choco_install_command(),
                setup::QemuChannel::NsisDownload => unreachable!("handled above"),
            };
            println!("$ {}", argv_to_display(&argv));
            let out = exec::run_command(&argv, Duration::from_secs(1800));
            if !out.success {
                return err_exit(&format!(
                    "QEMU install failed ({}): {}",
                    channel.label(),
                    out.stderr_last_line()
                ));
            }
        }
    }
    cleanup_setup_tmp(state_dir);
    println!("QEMU installed machine-wide. If `qemu-center doctor` still cannot find it, open a NEW terminal (PATH refresh) — known Windows limitation.");
    0
}

/// Runtime half shared by both NSIS channels: fetch the Weilnetz w64 listing,
/// parse the newest installer, download it into `<state-dir>/tmp/`. The pure
/// halves (`download_command` / `parse_weilnetz_listing`) are unit-tested;
/// this shell-out flow is runtime-unverified by construction.
fn download_latest_weilnetz_installer(state_dir: &Path) -> Result<PathBuf, String> {
    let tmp = state_dir.join(setup::TMP_DIR_NAME);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("mkdir {}: {e}", tmp.display()))?;
    let listing_path = tmp.join("w64-listing.html");
    let argv = setup::download_command(setup::WEILNETZ_LISTING_URL, &listing_path);
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(300));
    if !out.success {
        return Err(format!(
            "could not fetch the QEMU Windows builds listing ({}): {}",
            setup::WEILNETZ_LISTING_URL,
            out.stderr_last_line()
        ));
    }
    let body = std::fs::read_to_string(&listing_path)
        .map_err(|e| format!("read {}: {e}", listing_path.display()))?;
    let Some(file_name) = setup::parse_weilnetz_listing(&body) else {
        return Err(
            "no qemu-w64-setup-*.exe entry found in the builds listing (site layout changed?)"
                .into(),
        );
    };
    println!("newest installer: {file_name}");
    let installer = tmp.join(&file_name);
    let url = setup::weilnetz_installer_url(&file_name);
    let argv = setup::download_command(&url, &installer);
    println!("$ {}", argv_to_display(&argv));
    println!("downloading (~300 MiB, this can take a while)...");
    let out = exec::run_command(&argv, Duration::from_secs(3600));
    if !out.success {
        return Err(format!(
            "installer download failed: {}",
            out.stderr_last_line()
        ));
    }
    Ok(installer)
}

/// Remove the `<state-dir>/tmp` scratch space left behind by installer
/// downloads (best effort).
fn cleanup_setup_tmp(state_dir: &Path) {
    let tmp = state_dir.join(setup::TMP_DIR_NAME);
    if let Err(e) = std::fs::remove_dir_all(&tmp) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("warn: could not clean {}: {e}", tmp.display());
        }
    }
}

fn cmd_setup_image(state_dir: &Path, distro: &str) -> i32 {
    let Some(url) = setup::image_url(distro) else {
        return err_exit("distro must be 'jammy' or 'noble'");
    };
    let Some(file_name) = setup::image_file_name(distro) else {
        return err_exit("cannot derive image file name");
    };
    let images_dir = state_dir.join(setup::IMAGES_DIR_NAME);
    let dest = images_dir.join(file_name);
    let sums_path = images_dir.join(format!("SHA256SUMS-{distro}"));

    // Expected digest: fetch SHA256SUMS first (tiny), then compare.
    let sums_url = setup::sha256sums_url(distro);
    let expected: Option<String> = sums_url.and_then(|surl| {
        let argv = setup::download_command(surl, &sums_path);
        println!("$ {}", argv_to_display(&argv));
        let out = exec::run_command(&argv, Duration::from_secs(300));
        if !out.success {
            eprintln!(
                "warn: could not fetch SHA256SUMS ({}); image will be kept unverifiable",
                out.stderr_last_line()
            );
            return None;
        }
        std::fs::read_to_string(&sums_path)
            .ok()
            .and_then(|body| setup::expected_sha256_from_sums(&body, file_name))
    });

    let existing = dest.exists().then_some(dest.clone());
    let existing_sha = existing.as_ref().and_then(|p| {
        let argv = setup::get_file_hash_command(p);
        let out = exec::run_command(&argv, Duration::from_secs(120));
        out.success.then_some(out.stdout.trim().to_string())
    });
    match setup::image_download_plan(
        existing.as_deref(),
        existing_sha.as_deref(),
        expected.as_deref(),
    ) {
        setup::ImagePlan::SkipVerified(p) => {
            println!("image already present and SHA256-verified: {}", p.display());
            return 0;
        }
        setup::ImagePlan::SkipUnverifiable(p) => {
            println!(
                "image already present (no upstream digest available to verify): {}",
                p.display()
            );
            return 0;
        }
        setup::ImagePlan::Download => {}
    }

    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err_exit(&format!("mkdir {}: {e}", parent.display()));
        }
    }
    let argv = setup::download_command(url, &dest);
    println!("$ {}", argv_to_display(&argv));
    println!("downloading (~600 MiB, this can take a while)...");
    let out = exec::run_command(&argv, Duration::from_secs(7200));
    if !out.success {
        return err_exit(&format!("download failed: {}", out.stderr_last_line()));
    }
    // Verify after download when a digest is known; keep the file either way
    // (idempotent re-run will flag mismatch — see image_download_plan).
    if let Some(expected) = &expected {
        let argv = setup::get_file_hash_command(&dest);
        let out = exec::run_command(&argv, Duration::from_secs(120));
        let actual = out.stdout.trim().to_string();
        if !setup::sha_matches(&actual, expected) {
            return err_exit(&format!(
                "SHA256 mismatch for {}: expected {expected}, got {actual} — delete the file and rerun `setup image`",
                dest.display()
            ));
        }
        println!("SHA256 verified: {}", dest.display());
    }
    println!(
        "next: qemu-center vm create node1 --image {}",
        dest.display()
    );
    0
}

fn cmd_setup_all(state_dir: &Path, distro: &str) -> i32 {
    println!("== setup all: image (no elevation) -> qemu (UAC) -> whpx (UAC) ==");
    let mut needs_reboot = false;
    let image_code = cmd_setup_image(state_dir, distro);
    println!("\n-- image: {}", status_word(image_code));
    let qemu_code = cmd_setup_qemu(state_dir, false);
    println!("\n-- qemu: {}", status_word(qemu_code));
    let whpx_code = cmd_setup_whpx(state_dir);
    println!("\n-- whpx: {}", status_word(whpx_code));
    if whpx_code == 0 {
        // Distinguish "already enabled" from "just enabled, reboot needed".
        let argv = doctor::powershell_feature_command("HypervisorPlatform");
        let out = exec::run_command(&argv, Duration::from_secs(30));
        if !matches!(
            doctor::parse_feature_state(&out.stdout),
            doctor::FeatureState::Enabled
        ) {
            needs_reboot = true;
        }
    }
    println!();
    if needs_reboot {
        println!("ONE REBOOT is required to finish enabling WHPX. After rebooting: qemu-center doctor (should be all-green).");
    }
    let failed = [image_code, qemu_code, whpx_code].iter().any(|&c| c != 0);
    if failed {
        1
    } else {
        0
    }
}

fn status_word(code: i32) -> &'static str {
    if code == 0 {
        "done"
    } else {
        "FAILED (see above)"
    }
}

/// The elevated child half of `setup whpx`: runs DISM, writes its exit code
/// into the marker file the non-elevated parent reads.
fn cmd_elevated_whpx(state_dir: &Path) -> i32 {
    if !cfg!(windows) {
        return 1;
    }
    let argv = setup::dism_enable_command();
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(1800));
    setup::write_marker(
        state_dir,
        MARKER_WHPX,
        &format!("{}\n{}", out.exit_code, out.stdout),
    );
    if out.success || out.exit_code == 1168 {
        0
    } else {
        1
    }
}

// ---------------------------------------------------------------- vm create -

/// Create the parent directory of `path` and return it. `vm create` mints the
/// node key at `<state>/keys/<name>_ed25519`, but nothing ever made `<state>/keys`
/// (keys predate the portable state dir, where they lived in %APPDATA%) — the
/// first node created after the switch failed with ssh-keygen's
/// "Saving key ... failed: No such file or directory".
fn ensure_parent_dir(path: &Path) -> Result<PathBuf, String> {
    let Some(parent) = path.parent() else {
        return Err(format!("{} has no parent directory", path.display()));
    };
    if parent.as_os_str().is_empty() {
        // Bare filename relative to the CWD: nothing to create.
        return Ok(parent.to_path_buf());
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    Ok(parent.to_path_buf())
}

#[allow(clippy::too_many_arguments)]
fn cmd_vm_create(
    state_dir: &Path,
    name: &str,
    base_image: &Path,
    cpus: u16,
    mem: u32,
    disk_gib: u32,
    accel: &str,
    ssh_host_port: Option<u16>,
    adb_port_base: u16,
    adb_port_count: u16,
    docker_install: &str,
    ssh_pubkey: Option<String>,
    auto_setup: bool,
) -> i32 {
    // ---- prerequisite precheck (whpx feature, qemu binary, image file).
    let pre = setup::precheck(state_dir, base_image);
    let missing = setup::missing_prereqs(&pre);
    if !missing.is_empty() {
        if auto_setup {
            println!(
                "missing prerequisites: {} — running setup automatically (--auto-setup)",
                missing
                    .iter()
                    .map(|p| p.id())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            for p in &missing {
                let code = match p {
                    setup::Prereq::WhpxFeature => cmd_setup_whpx(state_dir),
                    setup::Prereq::QemuBinary => cmd_setup_qemu(state_dir, false),
                    setup::Prereq::CloudImage => {
                        // Reuse the default distro; explicit `setup image` for others.
                        cmd_setup_image(state_dir, "noble")
                    }
                };
                if code != 0 {
                    return err_exit(&format!(
                        "auto-setup of {} failed (exit {code}); fix it and rerun vm create",
                        p.id()
                    ));
                }
            }
            // Re-check after setup (whpx may need a reboot we cannot do).
            let pre2 = setup::precheck(state_dir, base_image);
            let still = setup::missing_prereqs(&pre2);
            if !still.is_empty() {
                for p in &still {
                    eprintln!("still missing after setup: {} ({})", p.id(), p.setup_hint());
                }
                return 3;
            }
        } else {
            eprintln!("missing prerequisites — run one of:");
            for p in &missing {
                eprintln!("  {}", p.setup_hint());
            }
            eprintln!("or rerun with --auto-setup to fix them automatically.");
            return 3;
        }
    }
    if let Err(e) = vm::validate_vm_name(name) {
        return err_exit(&e);
    }
    let Some(accel) = parse_accel(accel) else {
        return err_exit("accel must be 'whpx' or 'tcg'");
    };
    if !base_image.is_file() {
        return err_exit(&format!(
            "base cloud image {} not found (download an Ubuntu cloud image first — see README)",
            base_image.display()
        ));
    }
    if adb_port_count == 0 {
        return err_exit("adb_port_count must be > 0");
    }
    if !(1536..=16384).contains(&mem) {
        return err_exit("mem must be between 1536 MiB and 16384 MiB");
    }
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    if registry.contains(name) {
        return err_exit(&format!("VM {name:?} already exists in state.json"));
    }

    // ---- ports: ssh, qmp, then the consecutive adb block.
    let mut used = registry.used_ports();
    let ssh_port = match ssh_host_port {
        Some(p) if !used.contains(&p) && !vm::port_is_reserved(p) => p,
        Some(p) => return err_exit(&format!("ssh host port {p} is already in use/reserved")),
        None => match vm::next_free_port(&used, vm::DEFAULT_SSH_PORT_BASE) {
            Some(p) => p,
            None => return err_exit("no free ssh host port"),
        },
    };
    used.insert(ssh_port);
    let qmp_port = match vm::next_free_port(&used, vm::DEFAULT_QMP_PORT_BASE) {
        Some(p) => p,
        None => return err_exit("no free qmp host port"),
    };
    used.insert(qmp_port);
    let adb_ports = match vm::allocate_port_block(&used, adb_port_base, adb_port_count) {
        Ok(p) => p,
        Err(PortError::ZeroCount) => return err_exit("adb_port_count must be > 0"),
        Err(e @ PortError::Exhausted { .. }) => return err_exit(&e.to_string()),
    };

    // ---- SSH key: mint one for this node unless the operator supplies a key.
    let key_path = vm::vm_ssh_key_path(state_dir, name);
    let pubkey = match ssh_pubkey {
        Some(k) => k.trim().to_string(),
        None => {
            if !key_path.exists() {
                // ssh-keygen does not mkdir -p; <state>/keys must exist first
                // (the vm_dir mkdir below happens later, and only covers vm/).
                if let Err(e) = ensure_parent_dir(&key_path) {
                    return err_exit(&e);
                }
                let argv = guest::ssh_keygen_command(&key_path, &format!("qemu-center-{name}"));
                println!("$ {}", argv_to_display(&argv));
                let out = exec::run_command(&argv, Duration::from_secs(30));
                if !out.success {
                    return err_exit(&format!(
                        "ssh-keygen failed: {} (install the Windows OpenSSH client — see `doctor`)",
                        out.stderr_last_line()
                    ));
                }
            }
            match std::fs::read_to_string(vm::vm_ssh_key_pub_path(state_dir, name)) {
                Ok(k) => k.trim().to_string(),
                Err(e) => return err_exit(&format!("read {}: {e}", key_path.display())),
            }
        }
    };

    // ---- cloud-init seed → self-built FAT16 image (CIDATA label + LFN
    // lowercase names). Carrier history, every step pinned down on the user's
    // real node1: the self-built ISO stored names uppercase (`USER-DATA.;1`),
    // QEMU VVFAT hard-wires its volume label to `QEMU VVFAT` so ds-identify's
    // `LABEL=cidata` scan found nothing and cloud-init never activated (guest
    // console: zero cloud-init logs), and this FAT16 image is the one that
    // validated end-to-end (cloud-init done / Docker active / SSH pubkey OK).
    // See crate::fat and README.
    let cfg = cloudinit::CloudInitConfig {
        hostname: name.to_string(),
        ssh_pubkey: pubkey,
        docker_install: docker_install.to_string(),
    };
    let files = match cloudinit::seed_image_files(&cfg) {
        Ok(f) => f,
        Err(e) => return err_exit(&e),
    };
    let dir = vm::vm_dir(state_dir, name);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return err_exit(&format!("mkdir {}: {e}", dir.display()));
    }
    let seed_image = fat::build_fat16_image(&files);
    let seed_image = match seed_image {
        Ok(b) => b,
        Err(e) => return err_exit(&format!("build FAT16 seed image: {e}")),
    };
    let seed_path = vm::vm_seed_image(state_dir, name);
    if let Err(e) = std::fs::write(&seed_path, &seed_image) {
        return err_exit(&format!("write {}: {e}", seed_path.display()));
    }

    // ---- disk: qcow2 overlay over the (read-only) cloud image.
    let disk = vm::vm_disk_path(state_dir, name);
    let qemu_img = match doctor::discover_qemu_img_with(Some(state_dir)) {
        Some(p) => p.display().to_string(),
        None => {
            return err_exit(
                "qemu-img not found — install QEMU or run `qemu-center doctor` for hints",
            )
        }
    };
    let argv = vm::qemu_img_create_overlay(&qemu_img, &disk, base_image, Some(disk_gib));
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(120));
    if !out.success {
        return err_exit(&format!(
            "qemu-img create failed: {}",
            out.stderr_last_line()
        ));
    }

    let adb_block_display = match (adb_ports.first(), adb_ports.last()) {
        (Some(f), Some(l)) => format!("{} ports ({}..={})", adb_ports.len(), f, l),
        _ => "-".to_string(),
    };
    let entry = VmEntry {
        name: name.to_string(),
        base_image: Some(base_image.to_path_buf()),
        disk,
        vcpus: cpus,
        mem_mib: mem,
        accel,
        ssh_host_port: ssh_port,
        qmp_host_port: qmp_port,
        adb_ports,
        adb_assignments: Default::default(),
        snapshots: Vec::new(),
        created_at_unix: vm::now_unix(),
        cloud_init: cfg,
        redroid_image: vm::default_redroid_image(),
    };
    registry.vms.push(entry);
    if let Err(e) = vm::save_registry(state_dir, &registry) {
        return err_exit(&e);
    }

    println!("VM {name} created.");
    println!(
        "  disk:        {}",
        vm::vm_disk_path(state_dir, name).display()
    );
    println!("  base image:  {}", base_image.display());
    println!(
        "  seed image:  {}",
        vm::vm_seed_image(state_dir, name).display()
    );
    println!("  ssh:         host port {ssh_port} -> guest 22");
    println!("  adb block:   {adb_block_display}");
    println!("  next:        qemu-center vm start {name} && qemu-center guest wait {name}");
    0
}

// ----------------------------------------------------------------- vm start -

fn cmd_vm_start(state_dir: &Path, name: &str) -> i32 {
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let Some(entry) = registry.get(name) else {
        return err_exit(&format!("VM {name:?} not registered (run `vm create`)"));
    };
    match probe_vm_liveness(entry.qmp_host_port) {
        vm::VmLiveness::Running => return err_exit(&format!("VM {name:?} is already running")),
        vm::VmLiveness::Unknown => {
            return err_exit(&format!(
                "cannot start VM {name:?} while QMP state is unknown"
            ));
        }
        vm::VmLiveness::Stopped => {}
    }
    let host_available_bytes = doctor::host_available_memory_bytes();
    if vm::should_block_vm_start(host_available_bytes, entry.mem_mib) {
        let available_mib = host_available_bytes.unwrap_or_default() / (1024 * 1024);
        let required_mib = vm::vm_start_required_memory_mib(entry.mem_mib);
        return err_exit(&format!(
            "host available memory is too low to start VM {name:?}: current {available_mib} MiB, required at least {required_mib} MiB (VM {mem} MiB + 1024 MiB headroom); release idle instances or choose a smaller node",
            mem = entry.mem_mib
        ));
    }
    if host_available_bytes.is_none() {
        eprintln!(
            "warning: host available memory could not be verified; proceeding with this explicit single VM start"
        );
    }
    let opts = LaunchOptions {
        qemu_bin: doctor::discover_qemu_bin_with(Some(state_dir))
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| vm::qemu_binary_name().to_string()),
        name: entry.name.clone(),
        vcpus: entry.vcpus,
        mem_mib: entry.mem_mib,
        accel: entry.accel,
        detach: Detach::platform_default(),
        disk: entry.disk.clone(),
        seed_image: {
            let img = vm::vm_seed_image(state_dir, name);
            img.exists().then_some(img)
        },
        ssh_host_port: entry.ssh_host_port,
        adb_ports: entry.adb_ports.clone(),
        qmp_host_port: entry.qmp_host_port,
    };
    let argv = vm::qemu_command(&opts);
    println!("$ {}", argv_to_display(&argv));
    let log_path = vm::vm_qemu_log_path(state_dir, name);
    // Windows: spawn fully detached (QEMU's -daemonize is POSIX-only; the
    // argv therefore carries no -daemonize — see vm::Detach docs). The child's
    // stdout/stderr go to vms/<name>/qemu.log and never inherit ours, so this
    // process (and its own caller's pipe) is released the moment we return.
    // POSIX: -daemonize makes QEMU fork, so the parent exits quickly.
    let pid = if cfg!(windows) {
        exec::spawn_detached(&argv, Some(&log_path))
            .map(|p| p.to_string())
            .map_err(|e| e.to_string())
    } else {
        let out = exec::run_command(&argv, Duration::from_secs(30));
        if out.success {
            Ok("(daemonized)".to_string())
        } else {
            Err(out.stderr_last_line())
        }
    };
    match pid {
        Ok(p) => {
            if cfg!(windows) {
                let pid = match p.parse::<u32>() {
                    Ok(pid) => pid,
                    Err(e) => return err_exit(&format!("invalid QEMU PID {p:?}: {e}")),
                };
                if let Err(e) = std::fs::write(vm::vm_pid_path(state_dir, name), format!("{pid}\n"))
                {
                    return err_exit(&format!("record QEMU PID for {name}: {e}"));
                }
            }
            println!("QEMU started ({p}).");
            println!(
                "  ssh:  ssh -p {} -i {} rdc@127.0.0.1",
                entry.ssh_host_port,
                vm::vm_ssh_key_path(state_dir, name).display()
            );
            println!("  log:  {}", log_path.display());
            println!(
                "  console: {}",
                vm::vm_console_log_path(state_dir, name).display()
            );
            println!("  next: qemu-center guest wait {name}");
            0
        }
        Err(e) => err_exit(&format!("QEMU failed to start: {e}")),
    }
}

// --------------------------------------------------------- vm set-memory -

fn cmd_vm_set_memory(state_dir: &Path, name: &str, memory_mib: u32) -> i32 {
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let Some(entry) = registry.get(name).cloned() else {
        return err_exit(&format!("VM {name:?} not registered"));
    };
    let liveness = probe_vm_liveness(entry.qmp_host_port);
    if let Err(error) = vm::validate_memory_reconfiguration(liveness, memory_mib) {
        return err_exit(&error);
    }
    let old_memory_mib = entry.mem_mib;
    let Some(updated) = registry.get_mut(name) else {
        return err_exit(&format!("VM {name:?} disappeared from state.json"));
    };
    updated.mem_mib = memory_mib;
    if let Err(error) = vm::save_registry(state_dir, &registry) {
        return err_exit(&error);
    }
    println!("VM {name} memory changed from {old_memory_mib} MiB to {memory_mib} MiB.");
    println!("The new value takes effect on the next graceful VM start.");
    0
}

// ------------------------------------------------------------------ vm stop -

fn cmd_vm_stop(state_dir: &Path, name: &str) -> i32 {
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let Some(entry) = registry.get(name) else {
        return err_exit(&format!("VM {name:?} not registered"));
    };
    match stop_via_qmp(entry.qmp_host_port) {
        Ok(()) => {
            println!(
                "ACPI powerdown requested via QMP (QEMU will exit once the guest powers off)."
            );
            println!("If the guest ignores ACPI, inspect guest/QEMU logs and wait; do not force-kill a QEMU that may still own its qcow2 disk.");
            0
        }
        Err(e) => err_exit(&format!(
            "QMP connect to 127.0.0.1:{} failed: {e} (is the VM running?)",
            entry.qmp_host_port
        )),
    }
}

/// QMP graceful shutdown: connect, read the greeting, negotiate, powerdown.
fn stop_via_qmp(qmp_port: u16) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    let addr = format!("127.0.0.1:{qmp_port}");
    let stream = std::net::TcpStream::connect(&addr).map_err(|e| format!("connect {addr}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read greeting: {e}"))?;
    if !vm::qmp_greeting_received(&line) {
        return Err("no QMP greeting — endpoint is not a QEMU QMP socket".into());
    }
    let mut writer = stream;
    for frame in vm::qmp_stop_frames() {
        writeln!(writer, "{frame}").map_err(|e| format!("write: {e}"))?;
        let mut reply = String::new();
        reader
            .read_line(&mut reply)
            .map_err(|e| format!("read: {e}"))?;
        if !vm::qmp_reply_is_ok(&reply) {
            return Err(format!("QMP rejected {frame}: {}", reply.trim()));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ vm list -

fn cmd_vm_list(state_dir: &Path, json: bool) -> i32 {
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    if json {
        match serde_json::to_string_pretty(&registry) {
            Ok(s) => println!("{s}"),
            Err(e) => return err_exit(&format!("serialize: {e}")),
        }
        return 0;
    }
    if registry.vms.is_empty() {
        println!("no VMs registered (run `qemu-center vm create`)");
        return 0;
    }
    println!(
        "{:<12} {:<6} {:<7} {:<9} {:<7} {}",
        "NAME", "VCPUS", "MEM", "ACCEL", "SSH", "ADB BLOCK"
    );
    for v in &registry.vms {
        let block = match (v.adb_ports.first(), v.adb_ports.last()) {
            (Some(f), Some(l)) => format!("{}..={}", f, l),
            _ => "-".to_string(),
        };
        println!(
            "{:<12} {:<6} {:<7} {:<9} {:<7} {}",
            v.name,
            v.vcpus,
            v.mem_mib,
            format!("{:?}", v.accel).to_lowercase(),
            v.ssh_host_port,
            block
        );
    }
    0
}

// ---------------------------------------------------------------- vm delete -

fn purge_vm_artifacts(state_dir: &Path, name: &str) -> Result<(), String> {
    let dir = vm::vm_dir(state_dir, name);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => println!("removed {}", dir.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove {}: {e}", dir.display())),
    }
    for key in [
        vm::vm_ssh_key_path(state_dir, name),
        vm::vm_ssh_key_pub_path(state_dir, name),
    ] {
        match std::fs::remove_file(&key) {
            Ok(()) => println!("removed {}", key.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove {}: {e}", key.display())),
        }
    }
    Ok(())
}

/// A backing-file clone contains the source guest's authorized SSH key. Keep
/// the host-side key path aligned with that guest identity; cloud-init is not
/// re-run for a clone, so generating a fresh host key here would make the
/// cloned VM unreachable. The caller removes these exact copied files if a
/// later clone-registration step fails.
fn copy_clone_ssh_identity(
    state_dir: &Path,
    source_name: &str,
    clone_name: &str,
) -> Result<(), String> {
    let pairs = [
        (
            vm::vm_ssh_key_path(state_dir, source_name),
            vm::vm_ssh_key_path(state_dir, clone_name),
        ),
        (
            vm::vm_ssh_key_pub_path(state_dir, source_name),
            vm::vm_ssh_key_pub_path(state_dir, clone_name),
        ),
    ];
    if let Some((_, destination)) = pairs.iter().find(|(_, destination)| destination.exists()) {
        return Err(format!(
            "refusing to overwrite existing clone SSH key {}",
            destination.display()
        ));
    }
    for (source, _destination) in &pairs {
        if !source.is_file() {
            return Err(format!(
                "source VM SSH key is missing: {}",
                source.display()
            ));
        }
    }
    if let Err(error) = std::fs::copy(&pairs[0].0, &pairs[0].1) {
        return Err(format!(
            "copy source VM SSH private key to {} failed: {error}",
            pairs[0].1.display()
        ));
    }
    if let Err(error) = std::fs::copy(&pairs[1].0, &pairs[1].1) {
        let _ = std::fs::remove_file(&pairs[0].1);
        return Err(format!(
            "copy source VM SSH public key to {} failed: {error}",
            pairs[1].1.display()
        ));
    }
    Ok(())
}

/// A local bind is an independent check that no listener currently owns the
/// QMP port. It complements the recorded QEMU PID when a proxy swallows the
/// connection-refused signal and the normal QMP probe can only say unknown.
fn qmp_port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Probe VM liveness with a conservative host-wide fallback for Windows
/// setups where a stopped QEMU port can remain black-holed instead of
/// returning connection refused.  A host process probe is consulted only
/// after QMP times out; any positive or failed process probe stays unknown.
fn probe_vm_liveness(qmp_port: u16) -> vm::VmLiveness {
    let probe = qmp::probe(qmp_port, qmp::PROBE_TIMEOUT);
    let host_has_qemu_process = if probe == vm::QmpProbe::TimedOut {
        match exec::host_has_qemu_process() {
            Ok(value) => Some(value),
            Err(error) => {
                eprintln!("warning: host QEMU process probe failed: {error}");
                None
            }
        }
    } else {
        None
    };
    vm::vm_liveness_from_qmp_probe_with_host_process_check(probe, host_has_qemu_process)
}

fn cmd_vm_delete(state_dir: &Path, name: &str, purge: bool) -> i32 {
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let Some(entry) = registry.get(name).cloned() else {
        return err_exit(&format!("VM {name:?} not registered"));
    };
    let liveness = probe_vm_liveness(entry.qmp_host_port);
    let delete_check = if liveness == vm::VmLiveness::Unknown {
        let pid = std::fs::read_to_string(vm::vm_pid_path(state_dir, name))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        let process_alive = pid.and_then(|pid| exec::pid_is_alive(pid).ok());
        vm::delete_plan_with_shutdown_proof(
            liveness,
            pid.is_some(),
            process_alive,
            qmp_port_is_free(entry.qmp_host_port),
        )
    } else {
        vm::delete_plan(liveness)
    };
    if let Err(reason) = delete_check {
        return err_exit(&format!("refusing to delete {name}: {reason}"));
    }
    registry.vms.retain(|v| v.name != name);
    if let Err(e) = vm::save_registry(state_dir, &registry) {
        return err_exit(&e);
    }
    if purge {
        if let Err(e) = purge_vm_artifacts(state_dir, name) {
            return err_exit(&e);
        }
    } else {
        let _ = std::fs::remove_file(vm::vm_pid_path(state_dir, name));
    }
    println!("VM {name} deleted (registry updated).");
    0
}

// --------------------------------------------------------------- vm snapshot

fn cmd_vm_snapshot(state_dir: &Path, name: &str, tag: &str) -> i32 {
    if let Err(e) = vm::validate_snapshot_tag(tag) {
        return err_exit(&e);
    }
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let entry = match registry.get(name) {
        Some(e) => e.clone(),
        None => return err_exit(&format!("VM {name:?} not registered")),
    };
    let disk = entry.disk.clone();
    let qemu_img = match doctor::discover_qemu_img_with(Some(state_dir)) {
        Some(p) => p.display().to_string(),
        None => return err_exit("qemu-img not found — run `qemu-center doctor`"),
    };

    // Bug A: `qemu-img snapshot -c` against a disk a running QEMU has open
    // corrupts the qcow2 (invalid snapshot table entry; the image then fails to
    // open at all). Resolve liveness first and pick the only legal writer.
    let liveness = probe_vm_liveness(entry.qmp_host_port);
    match vm::snapshot_plan(liveness, true) {
        vm::SnapshotPlan::Skip(why) => {
            return err_exit(&format!("refusing to snapshot {name}: {why}"));
        }
        vm::SnapshotPlan::QmpInternal => {
            let device = match qmp::device_for_disk(entry.qmp_host_port, &disk, qmp::PROBE_TIMEOUT)
            {
                Ok(d) => d,
                Err(e) => {
                    return err_exit(&format!(
                    "cannot address the live disk over QMP ({e}) — no qemu-img write was attempted"
                ))
                }
            };
            println!(
                "$ QMP blockdev-snapshot-internal-sync device={device} name={tag} (live VM, port {})",
                entry.qmp_host_port
            );
            if let Err(e) =
                qmp::internal_snapshot(entry.qmp_host_port, &device, tag, qmp::COMMAND_TIMEOUT)
            {
                return err_exit(&format!(
                    "QMP internal snapshot failed: {e} — no qemu-img write was attempted"
                ));
            }
            if let Err(e) = register_snapshot(state_dir, &mut registry, name, tag) {
                return err_exit(&e);
            }
            println!(
                "snapshot {tag:?} created on the running VM {name} via QMP (device {device}, {})",
                disk.display()
            );
            return 0;
        }
        vm::SnapshotPlan::QemuImg => {}
    }

    let argv = vm::qemu_img_snapshot_create(&qemu_img, &disk, tag);
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(300));
    if !out.success {
        return err_exit(&format!(
            "qemu-img snapshot failed: {}",
            out.stderr_last_line()
        ));
    }
    if let Err(e) = register_snapshot(state_dir, &mut registry, name, tag) {
        return err_exit(&e);
    }
    println!(
        "snapshot {tag:?} created on {} (VM was stopped).",
        disk.display()
    );
    0
}

/// Record a freshly created snapshot tag in `state.json` (idempotent).
fn register_snapshot(
    state_dir: &Path,
    registry: &mut vm::Registry,
    name: &str,
    tag: &str,
) -> Result<(), String> {
    let Some(e) = registry.get_mut(name) else {
        return Err("VM disappeared from registry".into());
    };
    if !e.snapshots.iter().any(|s| s == tag) {
        e.snapshots.push(tag.to_string());
    }
    vm::save_registry(state_dir, registry)
}

// ------------------------------------------------------------------ vm restore

fn cmd_vm_restore(state_dir: &Path, name: &str, tag: &str) -> i32 {
    if let Err(e) = vm::validate_snapshot_tag(tag) {
        return err_exit(&e);
    }
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let disk = match registry.get(name) {
        Some(e) => e.disk.clone(),
        None => return err_exit(&format!("VM {name:?} not registered")),
    };
    let qmp_port = match registry.get(name) {
        Some(e) => e.qmp_host_port,
        None => return err_exit(&format!("VM {name:?} not registered")),
    };
    // Bug A, hard guard: `qemu-img snapshot -a` writes to the image, so it is
    // only legal while nothing owns the disk. A running (or unprovable) VM is
    // refused instead of corrupted — there is no QMP equivalent here, because
    // applying a snapshot under a live guest would leave it running on stale
    // in-memory state.
    let liveness = probe_vm_liveness(qmp_port);
    match vm::snapshot_plan(liveness, true) {
        vm::SnapshotPlan::QemuImg => {}
        vm::SnapshotPlan::QmpInternal => {
            return err_exit(&format!(
                "VM {name} is running — `vm restore` writes the image with qemu-img and cannot be \
                 done safely on a live disk (would corrupt the qcow2). Run `vm stop {name}` first."
            ))
        }
        vm::SnapshotPlan::Skip(why) => {
            return err_exit(&format!("refusing to restore {name}: {why}"))
        }
    }
    // Refuse unknown tags early: qemu-img would fail too, but its error is
    // cryptic ("could not find snapshot") — the registry knows the valid set.
    let known = registry
        .get(name)
        .map(|e| e.snapshots.iter().any(|s| s == tag))
        .unwrap_or(false);
    if !known {
        return err_exit(&format!(
            "snapshot {tag:?} is not registered on VM {name:?} (create it with `vm snapshot`)"
        ));
    }
    let qemu_img = match doctor::discover_qemu_img_with(Some(state_dir)) {
        Some(p) => p.display().to_string(),
        None => return err_exit("qemu-img not found — run `qemu-center doctor`"),
    };
    let argv = vm::qemu_img_snapshot_apply(&qemu_img, &disk, tag);
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(300));
    if !out.success {
        return err_exit(&format!(
            "qemu-img restore failed (is the VM stopped?): {}",
            out.stderr_last_line()
        ));
    }
    println!(
        "snapshot {tag:?} restored onto {} (disk state rolled back; VM must stay stopped until restarted).",
        disk.display()
    );
    0
}

// ------------------------------------------------------------------ vm clone

fn cmd_vm_clone(state_dir: &Path, name: &str, new_name: &str) -> i32 {
    if let Err(e) = vm::validate_vm_name(new_name) {
        return err_exit(&e);
    }
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    if registry.contains(new_name) {
        return err_exit(&format!("VM {new_name:?} already exists"));
    }
    let Some(src) = registry.get(name).cloned() else {
        return err_exit(&format!("VM {name:?} not registered"));
    };
    let liveness = probe_vm_liveness(src.qmp_host_port);
    if let Err(reason) = vm::clone_plan(liveness) {
        return err_exit(&format!("refusing to clone {name}: {reason}"));
    }
    let qemu_img = match doctor::discover_qemu_img_with(Some(state_dir)) {
        Some(p) => p.display().to_string(),
        None => return err_exit("qemu-img not found — run `qemu-center doctor`"),
    };
    let clone_dir = vm::vm_dir(state_dir, new_name);
    if clone_dir.exists() {
        return err_exit(&format!(
            "refusing to clone into existing VM artifact directory {}",
            clone_dir.display()
        ));
    }
    if let Err(error) = std::fs::create_dir_all(&clone_dir) {
        return err_exit(&format!(
            "cannot create clone directory {}: {error}",
            clone_dir.display()
        ));
    }
    let clone_disk = vm::vm_disk_path(state_dir, new_name);
    let argv = vm::qemu_img_create_overlay(&qemu_img, &clone_disk, &src.disk, None);
    println!("$ {}", argv_to_display(&argv));
    let t0 = std::time::Instant::now();
    let out = exec::run_command(&argv, Duration::from_secs(300));
    if !out.success {
        let _ = std::fs::remove_dir_all(&clone_dir);
        return err_exit(&format!(
            "qemu-img clone failed: {}",
            out.stderr_last_line()
        ));
    }
    if let Err(error) = copy_clone_ssh_identity(state_dir, name, new_name) {
        let _ = std::fs::remove_dir_all(&clone_dir);
        return err_exit(&format!("cannot prepare clone SSH identity: {error}"));
    }
    println!(
        "clone written in {} ms (qcow2 backing file — no data copied).",
        t0.elapsed().as_millis()
    );

    // Ports: a clone is a *second node* — its own ssh/qmp ports and its own
    // adb block. Cloud-init does not re-run on a clone (the guest is already
    // provisioned); the seed is simply not attached at start.
    let mut used = registry.used_ports();
    let ssh_port = match vm::next_free_port(&used, vm::DEFAULT_SSH_PORT_BASE) {
        Some(p) => p,
        None => {
            let _ = purge_vm_artifacts(state_dir, new_name);
            return err_exit("no free ssh host port");
        }
    };
    used.insert(ssh_port);
    let qmp_port = match vm::next_free_port(&used, vm::DEFAULT_QMP_PORT_BASE) {
        Some(p) => p,
        None => {
            let _ = purge_vm_artifacts(state_dir, new_name);
            return err_exit("no free qmp host port");
        }
    };
    used.insert(qmp_port);
    let adb_ports = match vm::allocate_port_block(
        &used,
        vm::DEFAULT_ADB_PORT_BASE,
        src.adb_ports.len().max(1) as u16,
    ) {
        Ok(p) => p,
        Err(e) => {
            let _ = purge_vm_artifacts(state_dir, new_name);
            return err_exit(&e.to_string());
        }
    };
    let entry = VmEntry {
        name: new_name.to_string(),
        base_image: None, // backing chain: clone -> source disk -> cloud image
        disk: clone_disk,
        vcpus: src.vcpus,
        mem_mib: src.mem_mib,
        accel: src.accel,
        ssh_host_port: ssh_port,
        qmp_host_port: qmp_port,
        adb_ports,
        adb_assignments: Default::default(),
        snapshots: Vec::new(),
        created_at_unix: vm::now_unix(),
        cloud_init: src.cloud_init.clone(),
        redroid_image: src.redroid_image.clone(),
    };
    registry.vms.push(entry);
    if let Err(e) = vm::save_registry(state_dir, &registry) {
        let _ = purge_vm_artifacts(state_dir, new_name);
        return err_exit(&e);
    }
    println!("VM {new_name} cloned from {name} (ssh port {ssh_port}).");
    0
}

// -------------------------------------------------------------- guest ops ---

fn get_vm(state_dir: &Path, name: &str) -> Result<VmEntry, i32> {
    let registry = vm::load_registry(state_dir).map_err(|e| err_exit(&e))?;
    registry
        .get(name)
        .cloned()
        .ok_or_else(|| err_exit(&format!("VM {name:?} not registered")))
}

fn cmd_guest_wait(state_dir: &Path, name: &str, timeout_secs: u64) -> i32 {
    let entry = match get_vm(state_dir, name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    let argv = ssh_cmd_for(&entry, state_dir, "true");
    let cmd = argv_to_display(&argv);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let out = exec::run_command(&argv, Duration::from_secs(15));
        if out.success {
            println!("guest SSH reachable after {attempt} attempt(s).");
            break;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "error: guest not reachable within {timeout_secs}s (last: {})",
                out.stderr_last_line()
            );
            eprintln!("  poll: {cmd}");
            return 1;
        }
        std::thread::sleep(Duration::from_secs(2));
    }

    let readiness_argv = ssh_cmd_for(&entry, state_dir, guest::cmd_guest_bootstrap_ready());
    let readiness_cmd = argv_to_display(&readiness_argv);
    let mut readiness_attempt = 0u32;
    loop {
        readiness_attempt += 1;
        let out = exec::run_command(&readiness_argv, Duration::from_secs(15));
        if out.success {
            println!("guest provisioning ready after {readiness_attempt} readiness attempt(s).");
            return 0;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "error: guest SSH is reachable but provisioning was not ready within {timeout_secs}s (last: {})",
                out.stderr_last_line()
            );
            eprintln!("  poll: {readiness_cmd}");
            return 1;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn cmd_guest_provision(state_dir: &Path, name: &str) -> i32 {
    let entry = match get_vm(state_dir, name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    let argv = ssh_cmd_for(&entry, state_dir, &guest::render_provision_script());
    println!("$ {}", argv_to_display(&argv));
    let out = exec::run_command(&argv, Duration::from_secs(600));
    println!("{}", out.stdout);
    if !out.stdout.contains(guest::PROVISION_DONE_MARKER) {
        return err_exit(&format!(
            "provision did not complete (exit {}): {}",
            out.exit_code,
            out.stderr_last_line()
        ));
    }
    println!("provision script completed (binder prep + docker ensured).");
    // Follow up with the readiness report so the operator sees the real
    // guest state, not just "script exited".
    let argv = ssh_cmd_for(&entry, state_dir, &guest::render_readiness_script());
    let out = exec::run_command(&argv, Duration::from_secs(60));
    let binder = guest::judge_readiness_line(&out.stdout, "BINDERFS");
    let docker = guest::judge_readiness_line(&out.stdout, "DOCKER");
    println!("readiness: binderfs={binder:?} docker={docker:?}");
    match (binder, docker) {
        (guest::Readiness::Ok, guest::Readiness::Ok) => {
            println!("guest is ready for redroid instances.");
            0
        }
        _ => {
            eprintln!("guest is NOT fully ready — see the readiness values above.");
            1
        }
    }
}

// ------------------------------------------------------------- redroid ops --

#[allow(clippy::too_many_arguments)]
fn cmd_redroid_create(
    state_dir: &Path,
    vm_name: &str,
    inst: &str,
    cpus_override: Option<f64>,
    memory_override: Option<u32>,
    profile: &str,
    width: u32,
    height: u32,
    dpi: u32,
    gpu_mode: &str,
    image: Option<String>,
    binds: Vec<String>,
    cgroup_parent: Option<String>,
) -> i32 {
    for bind in &binds {
        let parts: Vec<_> = bind.split(':').collect();
        if parts.len() != 3
            || !parts[0].starts_with('/')
            || !parts[1].starts_with('/')
            || parts[2] != "ro"
            || bind.contains([',', '\n', '\r'])
        {
            return err_exit(
                "bind must be an absolute guest source:target:ro without commas/newlines",
            );
        }
    }
    if let Err(e) = redroid::validate_instance_name(inst) {
        return err_exit(&e);
    }
    let Some(gpu) = parse_gpu_mode(gpu_mode) else {
        return err_exit("gpu-mode must be 'guest' or 'host'");
    };
    let profile = match redroid::ResourceProfile::parse(profile) {
        Ok(profile) => profile,
        Err(e) => return err_exit(&e),
    };
    let mut registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    let Some(entry) = registry.get(vm_name) else {
        return err_exit(&format!("VM {vm_name:?} not registered"));
    };
    let (cpus, memory) = match redroid::resolve_instance_resources(
        profile,
        entry.vcpus,
        entry.mem_mib,
        cpus_override,
        memory_override,
    ) {
        Ok(resources) => resources,
        Err(error) => return err_exit(&error),
    };
    let container = redroid::container_name(inst);
    if entry.adb_assignments.contains_key(inst) {
        return err_exit(&format!(
            "instance {inst:?} already assigned on VM {vm_name:?}"
        ));
    }

    // A stopped container keeps its ADB assignment and data volume, but it no
    // longer competes for the node's runtime memory. Prefer a fresh, read-only
    // Docker status count so idle release can make room for a new instance.
    // If the guest is down or the status output is incomplete, stay
    // conservative and charge every registered assignment as before.
    let registered_instances = entry.adb_assignments.len() as u32;
    let running_instances = {
        let live = guest_docker(entry, state_dir, &redroid::docker_ps_args());
        if live.success {
            guest::parse_running_redroid_count(&live.stdout).unwrap_or(registered_instances)
        } else {
            registered_instances
        }
    };
    if let Err(error) = redroid::validate_resource_budget(
        entry.mem_mib,
        memory,
        running_instances.saturating_add(1),
    ) {
        return err_exit(&format!(
            "resource profile {} cannot fit this VM: {error:?}",
            profile.as_str()
        ));
    }
    let Some(port) = entry.next_free_adb_port() else {
        return err_exit(&format!(
            "VM {vm_name:?} adb block exhausted ({} ports) — create a new VM or recreate with a larger block",
            entry.adb_ports.len()
        ));
    };
    let image = image.unwrap_or_else(vm::default_redroid_image);
    let spec = redroid::RedroidSpec {
        name: inst.to_string(),
        adb_port: port,
        cpus,
        memory_mib: memory,
        width,
        height,
        dpi,
        gpu_mode: gpu,
        image: image.clone(),
    };
    let entry = registry.get(vm_name).expect("checked above");
    let vol = guest_docker(entry, state_dir, &redroid::docker_volume_create_args(inst));
    if !vol.success {
        println!(
            "note: volume create failed (continuing; docker run -v will retry): {}",
            vol.stderr_last_line()
        );
    }
    let run = guest_docker(
        entry,
        state_dir,
        &redroid::redroid_create_args_with_mounts(&spec, &binds, cgroup_parent.as_deref()),
    );
    if !run.success {
        return err_exit(&format!(
            "docker run failed in guest: {}",
            run.stderr_last_line()
        ));
    }
    let Some(e) = registry.get_mut(vm_name) else {
        return err_exit("VM disappeared from registry");
    };
    e.adb_assignments.insert(inst.to_string(), port);
    if let Err(err) = vm::save_registry(state_dir, &registry) {
        return err_exit(&err);
    }
    println!("instance {inst} created on VM {vm_name} (container {container}).");
    println!("  adb serial: {}", verify::adb_serial(port));
    println!("  next: wait for boot (a few minutes), then `qemu-center verify --vm {vm_name}` or `adb connect {}`", verify::adb_serial(port));
    0
}

fn cmd_redroid_lifecycle(state_dir: &Path, vm_name: &str, inst: &str, action: &str) -> i32 {
    let entry = match get_vm(state_dir, vm_name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    if action != "start" && action != "stop" {
        return err_exit("action must be start|stop");
    }
    let out = guest_docker(
        &entry,
        state_dir,
        &redroid::docker_lifecycle_args(action, inst),
    );
    if out.success {
        println!("{action} {} ok.", redroid::container_name(inst));
        0
    } else {
        err_exit(&format!(
            "docker {action} failed: {}",
            out.stderr_last_line()
        ))
    }
}

fn cmd_redroid_list(state_dir: &Path, vm_name: &str, json: bool) -> i32 {
    let entry = match get_vm(state_dir, vm_name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    // Live status from the guest (best effort — a stopped VM just means no
    // status column data).
    let argv = ssh_cmd_for(&entry, state_dir, guest::cmd_docker_ps_qc());
    let live = exec::run_command(&argv, Duration::from_secs(60));
    let mut status_by_name = std::collections::BTreeMap::new();
    if live.success {
        for line in live.stdout.lines() {
            if let Some((name, status, _ports)) = guest::parse_docker_ps_line(line) {
                status_by_name.insert(name, status);
            }
        }
    }
    if json {
        let rows: Vec<serde_json::Value> = entry
            .adb_assignments
            .iter()
            .map(|(name, port)| {
                serde_json::json!({
                    "instance": name,
                    "container": redroid::container_name(name),
                    "port": port,
                    "serial": verify::adb_serial(*port),
                    "status": status_by_name
                        .get(&redroid::container_name(name))
                        .cloned()
                        .unwrap_or_else(|| "unknown".into()),
                })
            })
            .collect();
        match serde_json::to_string_pretty(&rows) {
            Ok(s) => println!("{s}"),
            Err(e) => return err_exit(&format!("serialize: {e}")),
        }
        return 0;
    }
    if entry.adb_assignments.is_empty() {
        println!("no instances assigned on VM {vm_name}");
        return 0;
    }
    println!(
        "{:<16} {:<10} {:<22} {}",
        "INSTANCE", "PORT", "SERIAL", "STATUS"
    );
    for (name, port) in &entry.adb_assignments {
        let status = status_by_name
            .get(&redroid::container_name(name))
            .map(String::as_str)
            .unwrap_or(if live.success {
                "not found"
            } else {
                "unknown (vm down?)"
            });
        println!(
            "{:<16} {:<10} {:<22} {}",
            name,
            port,
            verify::adb_serial(*port),
            status
        );
    }
    0
}

fn optional_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
}

fn optional_metric(raw: &str) -> Option<u64> {
    let value = raw.trim();
    if value.is_empty() || value == "max" {
        None
    } else {
        value.parse().ok()
    }
}

fn parse_guest_redroid_stats(raw: &str) -> Result<Vec<redroid::RedroidRuntimeStats>, String> {
    let mut rows = BTreeMap::<String, redroid::RedroidRuntimeStats>::new();
    let mut cgroups = BTreeMap::<String, (Option<u64>, Option<u64>, Option<u64>)>::new();
    let mut cpus = BTreeMap::<String, Option<f64>>::new();
    let mut boots = BTreeMap::<String, Option<bool>>::new();

    for line in raw.lines() {
        if let Some(json) = line.strip_prefix("QC_INSPECT\t") {
            let value: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| format!("invalid Docker inspect row: {e}"))?;
            let id = value
                .get("Id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "Docker inspect row has no Id".to_string())?
                .to_string();
            let container = value
                .get("Name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_string();
            let Some(instance) = container.strip_prefix("qc-") else {
                continue;
            };
            let status = value
                .pointer("/State/Status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let memory_limit_bytes =
                optional_u64(value.pointer("/HostConfig/Memory")).filter(|limit| *limit > 0);
            rows.insert(
                id,
                redroid::RedroidRuntimeStats {
                    instance: instance.to_string(),
                    container,
                    status,
                    memory_limit_bytes,
                    memory_current_bytes: None,
                    memory_peak_bytes: None,
                    oom_kills: None,
                    cpu_usage_percent: None,
                    boot_completed: None,
                },
            );
        } else if let Some(fields) = line.strip_prefix("QC_CGROUP\t") {
            let mut parts = fields.splitn(2, '\t');
            let Some(id) = parts.next() else { continue };
            let values: Vec<_> = parts.next().unwrap_or_default().split('|').collect();
            if values.len() == 3 {
                cgroups.insert(
                    id.to_string(),
                    (
                        optional_metric(values[0]),
                        optional_metric(values[1]),
                        optional_metric(values[2]),
                    ),
                );
            }
        } else if let Some(fields) = line.strip_prefix("QC_CPU\t") {
            let mut parts = fields.splitn(2, '\t');
            let Some(id) = parts.next() else { continue };
            let value = parts
                .next()
                .unwrap_or_default()
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value >= 0.0);
            cpus.insert(id.to_string(), value);
        } else if let Some(fields) = line.strip_prefix("QC_BOOT\t") {
            let mut parts = fields.splitn(2, '\t');
            let Some(id) = parts.next() else { continue };
            let value = match parts.next().unwrap_or_default().trim() {
                "1" => Some(true),
                "0" => Some(false),
                _ => None,
            };
            boots.insert(id.to_string(), value);
        }
    }

    // `docker inspect` returns the full 64-character ID, while `docker ps
    // --format '{{.ID}}'` returns the short 12-character ID. Accept either
    // form so the independently collected metrics can be joined reliably.
    fn metric_for_id<'a, T>(metrics: &'a BTreeMap<String, T>, id: &str) -> Option<&'a T> {
        metrics.get(id).or_else(|| {
            metrics.iter().find_map(|(metric_id, value)| {
                (id.starts_with(metric_id) || metric_id.starts_with(id)).then_some(value)
            })
        })
    }

    for (id, row) in &mut rows {
        if let Some((current, peak, oom)) = metric_for_id(&cgroups, id) {
            row.memory_current_bytes = *current;
            row.memory_peak_bytes = *peak;
            row.oom_kills = *oom;
        }
        if let Some(cpu) = metric_for_id(&cpus, id) {
            row.cpu_usage_percent = *cpu;
        }
        if let Some(boot) = metric_for_id(&boots, id) {
            row.boot_completed = *boot;
        }
    }

    Ok(rows.into_values().collect())
}

fn cmd_redroid_stats(state_dir: &Path, vm_name: &str, instance: Option<&str>, json: bool) -> i32 {
    if let Some(instance) = instance {
        if let Err(e) = redroid::validate_instance_name(instance) {
            return err_exit(&e);
        }
    }
    let entry = match get_vm(state_dir, vm_name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    let argv = ssh_cmd_for(&entry, state_dir, &guest::cmd_redroid_stats(instance));
    let out = exec::run_command(&argv, Duration::from_secs(90));
    if !out.success {
        return err_exit(&format!("redroid stats failed: {}", out.stderr_last_line()));
    }
    let mut rows = match parse_guest_redroid_stats(&out.stdout) {
        Ok(rows) => rows,
        Err(e) => return err_exit(&e),
    };
    // Keep registry assignments visible even if Docker was removed or the
    // guest command could not inspect a particular container.
    for name in entry.adb_assignments.keys() {
        if instance.is_some_and(|wanted| wanted != name) {
            continue;
        }
        if rows.iter().any(|row| row.instance == *name) {
            continue;
        }
        rows.push(redroid::RedroidRuntimeStats {
            instance: name.clone(),
            container: redroid::container_name(name),
            status: "unknown".into(),
            memory_limit_bytes: None,
            memory_current_bytes: None,
            memory_peak_bytes: None,
            oom_kills: None,
            cpu_usage_percent: None,
            boot_completed: None,
        });
    }
    rows.sort_by(|left, right| left.instance.cmp(&right.instance));
    if json {
        match serde_json::to_string_pretty(&rows) {
            Ok(text) => println!("{text}"),
            Err(e) => return err_exit(&format!("serialize redroid stats: {e}")),
        }
        return 0;
    }
    println!(
        "{:<16} {:<12} {:>14} {:>14} {:>10} {:>8}",
        "INSTANCE", "STATUS", "CURRENT", "PEAK", "OOM KILLS", "BOOT"
    );
    for row in rows {
        println!(
            "{:<16} {:<12} {:>14} {:>14} {:>10} {:>8}",
            row.instance,
            row.status,
            format_stat_bytes(row.memory_current_bytes),
            format_stat_bytes(row.memory_peak_bytes),
            row.oom_kills
                .map(|value| value.to_string())
                .unwrap_or_else(|| "n/a".into()),
            match row.boot_completed {
                Some(true) => "yes",
                Some(false) => "no",
                None => "n/a",
            }
        );
    }
    0
}

fn format_stat_bytes(value: Option<u64>) -> String {
    value
        .map(|bytes| format!("{:.1} MiB", bytes as f64 / 1_048_576.0))
        .unwrap_or_else(|| "n/a".into())
}

// ------------------------------------------------------------------ adb ops -

fn cmd_adb_map(state_dir: &Path, vm_name: &str, inst: Option<String>) -> i32 {
    let entry = match get_vm(state_dir, vm_name) {
        Ok(v) => v,
        Err(c) => return c,
    };
    let matches: Vec<(&String, &u16)> = entry
        .adb_assignments
        .iter()
        .filter(|(n, _)| inst.as_ref().map(|i| n == &i).unwrap_or(true))
        .collect();
    if matches.is_empty() {
        return err_exit(&format!(
            "no matching instance on VM {vm_name:?} (try `redroid list {vm_name}`)"
        ));
    }
    for (n, p) in matches {
        println!("{} {}", verify::adb_serial(*p), n);
    }
    0
}

fn cmd_adb_list(state_dir: &Path, json: bool) -> i32 {
    let registry = match vm::load_registry(state_dir) {
        Ok(r) => r,
        Err(e) => return err_exit(&e),
    };
    // serial -> (vm, instance) — ports are globally unique by construction.
    let mut rows: Vec<(String, String, String)> = Vec::new();
    for v in &registry.vms {
        for (n, p) in &v.adb_assignments {
            rows.push((verify::adb_serial(*p), v.name.clone(), n.clone()));
        }
    }
    if json {
        match serde_json::to_string_pretty(&rows) {
            Ok(s) => println!("{s}"),
            Err(e) => return err_exit(&format!("serialize: {e}")),
        }
        return 0;
    }
    if rows.is_empty() {
        println!("no adb mappings registered");
        return 0;
    }
    for (serial, vm, inst) in rows {
        println!("{serial} (vm {vm}, instance {inst})");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::{
        copy_clone_ssh_identity, ensure_parent_dir, parse_guest_redroid_stats, purge_vm_artifacts,
    };
    use std::path::{Path, PathBuf};

    /// Unique scratch dir per test (no external dev-deps — same pattern as the
    /// lib tests in vm.rs).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qc-ensure-parent-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn ensure_parent_dir_creates_the_missing_keys_directory() {
        let dir = scratch("creates");
        let key_path = dir.join("keys").join("probe-test_ed25519");
        let parent = ensure_parent_dir(&key_path).expect("parent dir must be creatable");
        assert_eq!(parent, dir.join("keys"));
        assert!(
            dir.join("keys").is_dir(),
            "keys/ must exist before ssh-keygen"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ensure_parent_dir_error_names_the_uncreatable_path() {
        let dir = scratch("error");
        // A plain file where the parent directory should go: create_dir_all
        // cannot win, and the error must carry the offending path.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("blocker"), b"not a directory").unwrap();
        let key_path = dir.join("blocker").join("n1_ed25519");
        let err = ensure_parent_dir(&key_path).expect_err("file-in-the-path must fail");
        assert!(err.contains("blocker"), "error must name the path: {err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ensure_parent_dir_accepts_a_bare_filename_with_no_directory_to_make() {
        // "n1_ed25519" in the CWD has an empty parent — nothing to create.
        let parent = ensure_parent_dir(Path::new("n1_ed25519")).unwrap();
        assert!(parent.as_os_str().is_empty());
    }

    #[test]
    fn guest_stats_parser_joins_inspect_cgroup_cpu_and_boot_rows() {
        let raw = concat!(
            "QC_INSPECT\t{\"Id\":\"abc\",\"Name\":\"/qc-r13\",\"State\":{\"Status\":\"running\"},\"HostConfig\":{\"Memory\":2147483648}}\n",
            "QC_CGROUP\tabc\t123|456|7\n",
            "QC_CPU\tabc\t0.25\n",
            "QC_BOOT\tabc\t1\n"
        );
        let rows = parse_guest_redroid_stats(raw).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].instance, "r13");
        assert_eq!(rows[0].memory_limit_bytes, Some(2_147_483_648));
        assert_eq!(rows[0].memory_current_bytes, Some(123));
        assert_eq!(rows[0].memory_peak_bytes, Some(456));
        assert_eq!(rows[0].oom_kills, Some(7));
        assert_eq!(rows[0].cpu_usage_percent, Some(0.25));
        assert_eq!(rows[0].boot_completed, Some(true));
    }

    #[test]
    fn guest_stats_parser_joins_short_docker_ids_to_full_inspect_ids() {
        let raw = concat!(
            "QC_INSPECT\t{\"Id\":\"abcdef1234567890\",\"Name\":\"/qc-r13\",\"State\":{\"Status\":\"running\"},\"HostConfig\":{\"Memory\":2147483648}}\n",
            "QC_CGROUP\tabcdef123456\t123|456|7\n",
            "QC_CPU\tabcdef123456\t2.19\n",
            "QC_BOOT\tabcdef123456\t1\n"
        );
        let rows = parse_guest_redroid_stats(raw).unwrap();
        assert_eq!(rows[0].memory_current_bytes, Some(123));
        assert_eq!(rows[0].memory_peak_bytes, Some(456));
        assert_eq!(rows[0].oom_kills, Some(7));
        assert_eq!(rows[0].cpu_usage_percent, Some(2.19));
        assert_eq!(rows[0].boot_completed, Some(true));
    }

    #[test]
    fn purge_vm_artifacts_removes_node_directory_and_ssh_keys() {
        let dir = scratch("purge");
        std::fs::create_dir_all(dir.join("vms/matrix3072")).unwrap();
        std::fs::create_dir_all(dir.join("keys")).unwrap();
        std::fs::write(dir.join("vms/matrix3072/disk.qcow2"), b"test disk").unwrap();
        std::fs::write(dir.join("keys/matrix3072_ed25519"), b"private").unwrap();
        std::fs::write(dir.join("keys/matrix3072_ed25519.pub"), b"public").unwrap();

        purge_vm_artifacts(&dir, "matrix3072").expect("purge should remove all node artifacts");

        assert!(!dir.join("vms/matrix3072").exists());
        assert!(!dir.join("keys/matrix3072_ed25519").exists());
        assert!(!dir.join("keys/matrix3072_ed25519.pub").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clone_copies_the_source_ssh_identity_for_the_cloned_disk() {
        let dir = scratch("clone-ssh");
        std::fs::create_dir_all(dir.join("keys")).unwrap();
        std::fs::write(dir.join("keys/source_ed25519"), b"private-key").unwrap();
        std::fs::write(dir.join("keys/source_ed25519.pub"), b"public-key").unwrap();

        copy_clone_ssh_identity(&dir, "source", "clone").expect("identity copy should succeed");

        assert_eq!(
            std::fs::read(dir.join("keys/clone_ed25519")).unwrap(),
            b"private-key"
        );
        assert_eq!(
            std::fs::read(dir.join("keys/clone_ed25519.pub")).unwrap(),
            b"public-key"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
