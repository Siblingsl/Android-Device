//! Guest-side access: SSH command assembly (Windows OpenSSH) and the
//! provision/readiness scripts executed *inside* the Ubuntu guest.
//!
//! The guest user is `rdc` (created by cloud-init, see [`crate::cloudinit`]);
//! the VM's :22 is forwarded to the host by QEMU slirp, so every SSH call is
//! `ssh -p <ssh_host_port> -i <state>/keys/<vm>_ed25519 rdc@127.0.0.1`.

use std::path::Path;

/// Guest login user (baked into the cloud-init seed).
pub const GUEST_USER: &str = "rdc";

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
    s.push_str("set +e\n");
    s.push_str(crate::cloudinit::BINDER_PREP_SNIPPET);
    s.push_str("\n");
    s.push_str("command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh\n");
    s.push_str("systemctl enable --now docker || true\n");
    for line in crate::cloudinit::docker_proxy_dropin_lines() {
        s.push_str(&line);
        s.push('\n');
    }
    s.push_str("usermod -aG docker rdc || true\n");
    s.push_str("getent group binder >/dev/null || groupadd binder || true\n");
    s.push_str(&format!("echo {PROVISION_DONE_MARKER}\n"));
    s
}

/// Guest-side one-shot readiness report: every line is `KEY=ok` or `KEY=missing`
/// so `verify` can judge with simple substring checks (pure-string contract).
pub fn render_readiness_script() -> String {
    "echo BINDERFS=$(grep -qw binder /proc/filesystems && echo ok || echo missing)
echo DOCKER=$(docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && echo ok || echo missing)
"
    .to_string()
}

/// `cat /proc/filesystems` — the binderfs check target (verify item 3).
pub fn cmd_cat_proc_filesystems() -> &'static str {
    "cat /proc/filesystems"
}

/// `docker version` server-side, printable (verify item 4).
pub fn cmd_docker_server_version() -> &'static str {
    "docker version --format '{{.Server.Version}}'"
}

/// `docker exec <c> getprop <prop>` — redroid boot progress (verify item 5).
pub fn cmd_docker_exec_getprop(container: &str, prop: &str) -> String {
    format!("docker exec {container} getprop {prop}")
}

/// List this node's redroid containers with their published ports.
pub fn cmd_docker_ps_qc() -> &'static str {
    "docker ps -a --filter name=^qc- --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}'"
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
    output
        .lines()
        .any(|l| l.split_whitespace().any(|w| w == "binder" || w == "binderfs"))
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
        assert_eq!(cmd.iter().position(|a| a == "-N").map(|i| &cmd[i + 1][..]), Some(""));
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
        assert!(s.contains("get.docker.com"));
        assert!(s.contains("systemctl enable --now docker"));
        assert!(s.contains("Environment=HTTP_PROXY=http://10.0.2.2:10808"));
        assert!(s.contains("> /etc/systemd/system/docker.service.d/proxy.conf"));
        assert!(s.contains("systemctl daemon-reload && systemctl restart docker || true"));
        assert!(s.contains("usermod -aG docker rdc"));
        assert!(s.contains(PROVISION_DONE_MARKER));
        // Failure tolerance first: no set -e.
        assert!(s.starts_with("set +e\n"));
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
            "docker version --format '{{.Server.Version}}'"
        );
        assert_eq!(
            cmd_docker_exec_getprop("qc-r1", "sys.boot_completed"),
            "docker exec qc-r1 getprop sys.boot_completed"
        );
        assert!(cmd_docker_ps_qc().contains("--filter name=^qc-"));
        assert!(cmd_docker_ps_qc().contains("{{.Names}}"));
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
    fn readiness_judge_parses_ok_missing_and_unknown() {
        let out = "BINDERFS=ok\nDOCKER=missing\n";
        assert_eq!(judge_readiness_line(out, "BINDERFS"), Readiness::Ok);
        assert_eq!(judge_readiness_line(out, "DOCKER"), Readiness::Missing);
        assert_eq!(judge_readiness_line(out, "NOPE"), Readiness::Unknown);
        assert_eq!(judge_readiness_line("BINDERFS=weird\n", "BINDERFS"), Readiness::Unknown);
        // CRLF-tolerant.
        assert_eq!(judge_readiness_line("BINDERFS=ok\r\n", "BINDERFS"), Readiness::Ok);
    }

    #[test]
    fn binder_filesystem_judgement() {
        assert!(judge_proc_filesystems_binder("nodev\tsysfs\nnodev\tbinderfs\next3\n"));
        assert!(judge_proc_filesystems_binder("nodev\tbinder\n"));
        assert!(!judge_proc_filesystems_binder("nodev\tbpf\next4\n"));
        assert!(!judge_proc_filesystems_binder(""));
        // "binderfs" must not match as a substring of another word.
        assert!(!judge_proc_filesystems_binder("nodev\tbinderfake\n"));
    }
}
