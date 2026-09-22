//! Guest-side access: SSH command assembly (Windows OpenSSH) and the
//! provision/readiness scripts executed *inside* the Ubuntu guest.
//!
//! The guest user is `rdc` (created by cloud-init, see [`crate::cloudinit`]);
//! the VM's :22 is forwarded to the host by QEMU slirp, so every SSH call is
//! `ssh -p <ssh_host_port> -i <state>/keys/<vm>_ed25519 rdc@127.0.0.1`.

use std::path::Path;

/// Guest login user (baked into the cloud-init seed).
pub const GUEST_USER: &str = "rdc";

/// Docker is invoked through non-interactive sudo because cloud-init adds the
/// `rdc` user to the docker group only after the first SSH connection can
/// already succeed. This keeps the CLI usable during that short bootstrap
/// window without weakening the guest's passwordless-SSH boundary.
pub const DOCKER_COMMAND: &str = "sudo -n docker";

/// Assemble a shell-safe Docker command for the guest. Pure.
pub fn docker_command(docker_args: &[String]) -> String {
    if docker_args.is_empty() {
        return DOCKER_COMMAND.to_string();
    }
    format!(
        "{DOCKER_COMMAND} {}",
        docker_args
            .iter()
            .map(|s| format!("'{}'", s.replace('\'', "'\"'\"'")))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

/// Assemble an ssh argv running `remote_cmd` on the guest. Pure.
///
/// Options chosen for a headless automation tool:
/// * `BatchMode=yes` — never prompt (a missing key must fail fast, not hang).
/// * `StrictHostKeyChecking=accept-new` — first connect auto-trusts the
///   freshly created VM host key; later key changes still fail loudly.
/// * `UserKnownHostsFile=<per-vm file>` — keys live in the state dir, not the
///   operator's personal known_hosts.
/// * `ConnectTimeout=8` — a stopped VM fails in seconds, not TCP eternity.
pub fn ssh_command(
    key_path: &Path,
    known_hosts: &Path,
    ssh_host_port: u16,
    remote_cmd: &str,
) -> Vec<String> {
    vec![
        "ssh".into(),
        "-p".into(),
        format!("{ssh_host_port}"),
        "-i".into(),
        key_path.display().to_string(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".into(),
        "ConnectTimeout=8".into(),
        format!("{GUEST_USER}@127.0.0.1"),
        remote_cmd.to_string(),
    ]
}

/// `ssh-keygen` argv that mints the VM-bound login key (ed25519, no
/// passphrase — the key is single-purpose and lives in the state dir).
pub fn ssh_keygen_command(key_path: &Path, comment: &str) -> Vec<String> {
    vec![
        "ssh-keygen".into(),
        "-t".into(),
        "ed25519".into(),
        "-N".into(),
        String::new(),
        "-f".into(),
        key_path.display().to_string(),
        "-C".into(),
        comment.to_string(),
    ]
}

/// Marker echoed by the provision script; `guest provision` greps for it.
pub const PROVISION_DONE_MARKER: &str = "QC_PROVISION_DONE";

/// Guest-side recovery script: re-apply the redroid kernel preparation and
/// ensure docker is installed/enabled (incl. the host-proxy drop-in) — the
/// same steps cloud-init's `runcmd` performs, for VMs whose first boot
/// partially failed.
pub fn render_provision_script() -> String {
    let mut s = String::new();
    // SSH logs in as `rdc`; run the recovery body as root so apt, module
    // loading, systemd drop-ins, and user/group repair are effective.
    s.push_str("sudo -n bash -s <<'QC_PROVISION_ROOT'\n");
    s.push_str("set +e\n");
    s.push_str(crate::cloudinit::BINDER_PREP_SNIPPET);
    s.push_str("\n");
    s.push_str(
        "command -v docker >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io\n",
    );
    s.push_str("systemctl enable --now docker || true\n");
    for line in crate::cloudinit::docker_proxy_dropin_lines() {
        s.push_str(&line);
        s.push('\n');
    }
    s.push_str("usermod -aG docker rdc || true\n");
    s.push_str("install -d -o rdc -g rdc -m 700 /run/rdc-presets\n");
    s.push_str("getent group binder >/dev/null || groupadd binder || true\n");
    s.push_str(&format!("echo {PROVISION_DONE_MARKER}\n"));
    s.push_str("QC_PROVISION_ROOT\n");
    s
}

/// Read-only bootstrap gate used by `guest wait`. SSH can accept connections
/// before provisioning has installed Docker or loaded binder; instance
/// creation must wait for both operational prerequisites instead of treating
/// SSH alone as ready. Cloud-init may be intentionally disabled after
/// provisioning, especially on a stopped-node clone, so its status is not a
/// durable readiness signal.
pub fn cmd_guest_bootstrap_ready() -> &'static str {
    "grep -qw binder /proc/filesystems && sudo -n docker version --format '{{.Server.Version}}' >/dev/null 2>&1"
}

/// Guest-side one-shot readiness report: every line is `KEY=ok` or `KEY=missing`
/// so `verify` can judge with simple substring checks (pure-string contract).
pub fn render_readiness_script() -> String {
    format!(
        "echo BINDERFS=$(grep -qw binder /proc/filesystems && echo ok || echo missing)\n\
echo DOCKER=$({DOCKER_COMMAND} version --format '{{{{.Server.Version}}}}' >/dev/null 2>&1 && echo ok || echo missing)\n"
    )
}

/// `cat /proc/filesystems` — the binderfs check target (verify item 3).
pub fn cmd_cat_proc_filesystems() -> &'static str {
    "cat /proc/filesystems"
}

/// `docker version` server-side, printable (verify item 4).
pub fn cmd_docker_server_version() -> &'static str {
    "sudo -n docker version --format '{{.Server.Version}}'"
}

/// Check the per-operation marker written by the guest runner after the
/// server has consumed the activation grant. The caller validates the marker
/// path is below `/run/rdc-presets` before using this command.
pub fn cmd_execution_authorization_check(marker: &str) -> String {
    let marker = shell_quote(marker);
    format!("test -f {marker} && cat {marker}")
}

/// `docker exec <c> getprop <prop>` — redroid boot progress (verify item 5).
pub fn cmd_docker_exec_getprop(container: &str, prop: &str) -> String {
    format!("{DOCKER_COMMAND} exec {container} getprop {prop}")
}

/// List this node's redroid containers with their published ports.
pub fn cmd_docker_ps_qc() -> &'static str {
    "sudo -n docker ps -a --filter name=^qc- --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}'"
}

/// Read-only machine-readable collection for redroid runtime stats.
///
/// Each line has a fixed prefix so the CLI can safely combine Docker inspect
/// JSON with nullable cgroup/CPU/boot measurements without parsing human
/// tables. The command deliberately uses `ps -a`, so exited containers remain
/// visible and can be reported with their last known status.
pub fn cmd_redroid_stats(instance: Option<&str>) -> String {
    let filter = match instance {
        Some(name) => format!("^qc-{name}$"),
        None => "^qc-".to_string(),
    };
    format!(
        r#"set +e
for id in $(sudo -n docker ps -a --filter 'name={filter}' --format '{{{{.ID}}}}'); do
  status=$(sudo -n docker inspect "$id" --format '{{{{.State.Status}}}}' 2>/dev/null)
  sudo -n docker inspect "$id" --format 'QC_INSPECT	{{{{json .}}}}'
  if [ "$status" = "running" ]; then
  metrics=$(sudo -n docker exec "$id" sh -c '
    current=
    peak=
    oom=
    if [ -r /sys/fs/cgroup/memory.current ]; then current=$(cat /sys/fs/cgroup/memory.current); elif [ -r /sys/fs/cgroup/memory.usage_in_bytes ]; then current=$(cat /sys/fs/cgroup/memory.usage_in_bytes); fi
    if [ -r /sys/fs/cgroup/memory.peak ]; then peak=$(cat /sys/fs/cgroup/memory.peak); elif [ -r /sys/fs/cgroup/memory.max_usage_in_bytes ]; then peak=$(cat /sys/fs/cgroup/memory.max_usage_in_bytes); fi
    if [ -r /sys/fs/cgroup/memory.events ]; then oom=$(grep ^oom_kill /sys/fs/cgroup/memory.events | tr -s " " | cut -d" " -f2); fi
    printf "%s|%s|%s" "$current" "$peak" "$oom"
  ' 2>/dev/null)
  printf 'QC_CGROUP\t%s\t%s\n' "$id" "$metrics"
  cpu=$(sudo -n docker stats --no-stream --format '{{{{.CPUPerc}}}}' "$id" 2>/dev/null | tr -d '%')
  printf 'QC_CPU\t%s\t%s\n' "$id" "$cpu"
  boot=$(sudo -n docker exec "$id" getprop sys.boot_completed 2>/dev/null | tr -d '\r\n')
  printf 'QC_BOOT\t%s\t%s\n' "$id" "$boot"
  fi
done"#
    )
}

/// Parse one line of [`cmd_docker_ps_qc`] output (Name\\tStatus\\tPorts).
/// Lines for non-`qc-` containers yield `None`.
pub fn parse_docker_ps_line(line: &str) -> Option<(String, String, String)> {
    let mut it = line.split('\t');
    let name = it.next()?.trim().to_string();
    if !name.starts_with("qc-") {
        return None;
    }
    let status = it.next().unwrap_or("").trim().to_string();
    let ports = it.next().unwrap_or("").trim().to_string();
    Some((name, status, ports))
}

/// Count redroid containers that Docker explicitly reports as running.
///
/// The create budget must not keep charging memory for an exited container,
/// but a missing status is not evidence that the container is stopped. Treat
/// an incomplete `qc-*` row as an error so callers can conservatively fall back
/// to the registered-instance count.
pub fn parse_running_redroid_count(stdout: &str) -> Result<u32, String> {
    let mut running = std::collections::BTreeSet::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let Some((name, status, _ports)) = parse_docker_ps_line(line) else {
            continue;
        };
        if status.is_empty() {
            return Err(format!("docker ps row has no status for {name}"));
        }
        let status = status.to_ascii_lowercase();
        if status == "running" || status == "up" || status.starts_with("up ") {
            running.insert(name);
        }
    }
    u32::try_from(running.len()).map_err(|_| "too many redroid containers".into())
}

/// Judge the readiness script output (pure; shared by verify and CLI output).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ok,
    Missing,
    Unknown,
}

pub fn judge_readiness_line(output: &str, key: &str) -> Readiness {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(v) = rest.strip_prefix('=') {
                return match v.trim() {
                    "ok" => Readiness::Ok,
                    "missing" => Readiness::Missing,
                    _ => Readiness::Unknown,
                };
            }
        }
    }
    Readiness::Unknown
}

/// Judge `cat /proc/filesystems`: binder support is present when any line
/// names `binder` or `binderfs` (the kernel reports `nodev\tbinderfs`).
pub fn judge_proc_filesystems_binder(output: &str) -> bool {
    output.lines().any(|l| {
        l.split_whitespace()
            .any(|w| w == "binder" || w == "binderfs")
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_command_shape() {
        let cmd = ssh_command(
            Path::new("C:/qc/keys/node1_ed25519"),
            Path::new("C:/qc/vms/node1/known_hosts"),
            22300,
            "true",
        );
        assert_eq!(cmd[0], "ssh");
        let s = cmd.join(" ");
        for expect in [
            "-p 22300",
            "-i C:/qc/keys/node1_ed25519",
            "-o BatchMode=yes",
            "-o StrictHostKeyChecking=accept-new",
            "-o UserKnownHostsFile=C:/qc/vms/node1/known_hosts",
            "-o ConnectTimeout=8",
            "rdc@127.0.0.1",
            "true",
        ] {
            assert!(s.contains(expect), "missing {expect:?} in {s}");
        }
        // The remote command is the LAST argv element (single string).
        assert_eq!(cmd.last().unwrap(), "true");
    }

    #[test]
    fn ssh_command_carries_remote_command_verbatim() {
        let cmd = ssh_command(Path::new("k"), Path::new("h"), 2222, "docker ps -a");
        assert_eq!(cmd.last().unwrap(), "docker ps -a");
    }

    #[test]
    fn ssh_keygen_shape_mints_ed25519_no_passphrase() {
        let cmd = ssh_keygen_command(Path::new("C:/qc/keys/n1_ed25519"), "qemu-center-n1");
        assert_eq!(cmd[0], "ssh-keygen");
        let s = cmd.join(" ");
        assert!(s.contains("-t ed25519"));
        assert!(s.contains("-N "), "empty passphrase arg present");
        assert_eq!(
            cmd.iter().position(|a| a == "-N").map(|i| &cmd[i + 1][..]),
            Some("")
        );
        assert!(s.contains("-f C:/qc/keys/n1_ed25519"));
        assert!(s.contains("-C qemu-center-n1"));
    }

    #[test]
    fn provision_script_has_binder_docker_and_marker() {
        let s = render_provision_script();
        // Kernel prep mirrors the cloud-init runcmd (modules-extra install +
        // modules-load.d autoload) and carries NO fstab append — the old
        // recovery path would have re-introduced the emergency-mode brick.
        assert!(s.contains("apt-get install -y linux-modules-extra-$(uname -r) || true"));
        assert!(s.contains("printf 'binder_linux\\n' | tee /etc/modules-load.d/binder.conf"));
        assert!(s.contains("modprobe binder_linux"));
        assert!(!s.contains("/etc/fstab"));
        assert!(!s.contains("mount -t binder"));
        assert!(s.contains("apt-get install -y docker.io"));
        assert!(s.contains("systemctl enable --now docker"));
        assert!(s.contains("Environment=HTTP_PROXY=http://10.0.2.2:10808"));
        assert!(s.contains("> /etc/systemd/system/docker.service.d/proxy.conf"));
        assert!(s.contains("systemctl daemon-reload && systemctl restart docker || true"));
        assert!(s.contains("usermod -aG docker rdc"));
        assert!(s.contains("install -d -o rdc -g rdc -m 700 /run/rdc-presets"));
        assert!(s.contains(PROVISION_DONE_MARKER));
        // Failure tolerance first: no set -e.
        assert!(s.contains("set +e\n"));
    }

    #[test]
    fn provision_script_elevates_the_recovery_body() {
        let s = render_provision_script();
        assert!(
            s.starts_with("sudo -n bash -s <<'QC_PROVISION_ROOT'\n"),
            "recovery commands need root even while SSH logs in as rdc"
        );
        assert!(s.ends_with("QC_PROVISION_ROOT\n"));
    }

    #[test]
    fn provision_script_is_deterministic() {
        assert_eq!(render_provision_script(), render_provision_script());
        assert_eq!(render_readiness_script(), render_readiness_script());
    }

    #[test]
    fn readiness_script_lines_are_key_value() {
        let s = render_readiness_script();
        assert!(s.contains("BINDERFS="));
        assert!(s.contains("DOCKER="));
        assert!(s.contains("grep -qw binder /proc/filesystems"));
    }

    #[test]
    fn guest_command_helpers() {
        assert_eq!(cmd_cat_proc_filesystems(), "cat /proc/filesystems");
        assert_eq!(
            cmd_docker_server_version(),
            "sudo -n docker version --format '{{.Server.Version}}'"
        );
        assert_eq!(
            cmd_docker_exec_getprop("qc-r1", "sys.boot_completed"),
            "sudo -n docker exec qc-r1 getprop sys.boot_completed"
        );
        assert!(cmd_docker_ps_qc().contains("--filter name=^qc-"));
        assert!(cmd_docker_ps_qc().contains("{{.Names}}"));
    }

    #[test]
    fn execution_authorization_check_reads_a_signed_receipt_marker() {
        let command =
            cmd_execution_authorization_check("/run/rdc-presets/job-1/execution-authorized");
        assert_eq!(
            command,
            "test -f '/run/rdc-presets/job-1/execution-authorized' && cat '/run/rdc-presets/job-1/execution-authorized'"
        );
    }

    #[test]
    fn docker_commands_are_usable_before_group_membership_refreshes() {
        let commands = [
            render_readiness_script(),
            cmd_docker_server_version().to_string(),
            cmd_docker_exec_getprop("qc-r1", "sys.boot_completed"),
            cmd_docker_ps_qc().to_string(),
            cmd_redroid_stats(Some("r1")),
            docker_command(&["ps".into(), "-a".into()]),
        ];
        for command in commands {
            assert!(
                command.contains("sudo -n docker"),
                "docker command must work during the cloud-init group-refresh window: {command}"
            );
        }
    }

    #[test]
    fn guest_wait_probe_uses_operational_readiness_after_cloud_init_is_disabled() {
        let command = cmd_guest_bootstrap_ready();
        assert!(!command.contains("cloud-init status --long"));
        assert!(!command.contains("^status: done$"));
        assert!(command.contains("grep -qw binder /proc/filesystems"));
        assert!(command.contains("sudo -n docker version"));
    }

    #[test]
    fn redroid_stats_only_execs_into_running_containers() {
        let command = cmd_redroid_stats(Some("r13"));
        assert!(command.contains("--format '{{.State.Status}}'"));
        assert!(command.contains("if [ \"$status\" = \"running\" ]; then"));
        assert!(command.contains("docker exec \"$id\""));
    }

    #[test]
    fn redroid_stats_command_is_read_only_and_machine_parseable() {
        let command = cmd_redroid_stats(Some("r13"));
        assert!(command.contains("docker ps -a"));
        assert!(command.contains("QC_INSPECT"));
        assert!(command.contains("QC_CGROUP"));
        assert!(command.contains("memory.current"));
        assert!(command.contains("memory.peak"));
        assert!(command.contains("getprop sys.boot_completed"));
        assert!(command.contains("docker stats --no-stream"));
        assert!(command.contains("^qc-r13$"));
        assert!(!command.contains("docker stop"));
        assert!(!command.contains("docker rm"));
    }

    #[test]
    fn docker_ps_line_parsing() {
        let line = "qc-r1\tUp 3 minutes\t0.0.0.0:24500->5555/tcp";
        let (name, status, ports) = parse_docker_ps_line(line).unwrap();
        assert_eq!(name, "qc-r1");
        assert_eq!(status, "Up 3 minutes");
        assert_eq!(ports, "0.0.0.0:24500->5555/tcp");
        // Exited containers and missing fields still parse.
        assert_eq!(
            parse_docker_ps_line("qc-r2\tExited (0)\t").unwrap().1,
            "Exited (0)"
        );
        assert_eq!(parse_docker_ps_line("other\tUp\t"), None, "qc- filter");
        assert_eq!(parse_docker_ps_line(""), None);
    }

    #[test]
    fn running_redroid_count_excludes_exited_and_unknown_rows() {
        let output = concat!(
            "qc-r1\tUp 3 minutes\t0.0.0.0:24500->5555/tcp\n",
            "qc-r2\tExited (137) 11 hours ago\t\n",
            "qc-r3\tunknown\t\n",
            "other\tUp 2 minutes\t\n",
        );
        assert_eq!(parse_running_redroid_count(output).unwrap(), 1);
    }

    #[test]
    fn running_redroid_count_rejects_incomplete_status_rows() {
        assert!(parse_running_redroid_count("qc-r1\t\t\n").is_err());
    }

    #[test]
    fn readiness_judge_parses_ok_missing_and_unknown() {
        let out = "BINDERFS=ok\nDOCKER=missing\n";
        assert_eq!(judge_readiness_line(out, "BINDERFS"), Readiness::Ok);
        assert_eq!(judge_readiness_line(out, "DOCKER"), Readiness::Missing);
        assert_eq!(judge_readiness_line(out, "NOPE"), Readiness::Unknown);
        assert_eq!(
            judge_readiness_line("BINDERFS=weird\n", "BINDERFS"),
            Readiness::Unknown
        );
        // CRLF-tolerant.
        assert_eq!(
            judge_readiness_line("BINDERFS=ok\r\n", "BINDERFS"),
            Readiness::Ok
        );
    }

    #[test]
    fn binder_filesystem_judgement() {
        assert!(judge_proc_filesystems_binder(
            "nodev\tsysfs\nnodev\tbinderfs\next3\n"
        ));
        assert!(judge_proc_filesystems_binder("nodev\tbinder\n"));
        assert!(!judge_proc_filesystems_binder("nodev\tbpf\next4\n"));
        assert!(!judge_proc_filesystems_binder(""));
        // "binderfs" must not match as a substring of another word.
        assert!(!judge_proc_filesystems_binder("nodev\tbinderfake\n"));
    }
}
