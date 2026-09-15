//! cloud-init NoCloud seed renderers (pure functions → deterministic YAML).
//!
//! The three files are baked into the VM's **self-built FAT16 seed image** at
//! `vm create` time ([`crate::fat::build_fat16_image`] via
//! [`seed_image_files`]); at `vm start` the image is attached as an ordinary
//! read-only virtio disk. The volume label `CIDATA` is what cloud-init's
//! `ds-identify` blkid scan matches, and VFAT long-file-name entries store the
//! file names verbatim in lowercase — exactly what NoCloud requires.
//!
//! Carrier history, each step falsified on the user's real WHPX host (node1):
//! * **Self-built ISO9660** ([`crate::iso`] + [`seed_files`]): the spec stores
//!   directory-record names uppercase (`USER-DATA.;1`) and the expected
//!   kernel-side lowercasing never happened — cloud-init ignored the seed
//!   entirely (correct `CIDATA` label, port reachable, public-key auth still
//!   refused). Retired to a library API / test asset.
//! * **QEMU VVFAT** (`-drive file=fat:<dir>`): preserves lowercase names but
//!   **hard-wires the volume label to `QEMU VVFAT`, not configurable** —
//!   `ds-identify` found no `LABEL=cidata` device, so cloud-init never
//!   activated (guest console: zero cloud-init log lines).
//! * **Self-built FAT16** (current): validated end-to-end on the same machine
//!   (cloud-init `done`, Docker active, SSH public-key auth OK).
//!
//! * `user-data` — #cloud-config: hostname, `rdc` user with the VM-bound SSH
//!   public key, password auth off, docker.io install, and redroid's kernel
//!   preparation as `runcmd` per the redroid docs
//!   (<https://redroid-doc.readthedocs.io/en/latest/devel/kernel/>). The four
//!   fixes verified by hand on the user's real node1 and baked back in here:
//!   install `linux-modules-extra-$(uname -r)` (cloud images ship without it —
//!   without it `modprobe binder_linux` fails), autoload `binder_linux` at
//!   boot via `/etc/modules-load.d/`, **no** binderfs mount / fstab entry
//!   (the container mounts binderfs itself; the fstab line once hung a whole
//!   boot in emergency mode), and a docker-daemon proxy drop-in pointing at
//!   the host through the QEMU user-net gateway ([`GUEST_DOCKER_PROXY`]).
//! * `meta-data` — instance id + local hostname.
//! * `network-config` — netplan v2: DHCP4 on every `en*` interface (QEMU
//!   user-mode networking hands out 10.0.2.15).
//!
//! All renderers are pure: same config in, byte-identical string out (tests
//! enforce this). YAML is written with fixed 2-space indentation and no tabs;
//! `ssh_pubkey` is inserted verbatim on its own list line (a public key can
//! contain no YAML-hostile characters — ` `, `+`, `/`, `=`, base64 body — so
//! no escaping is needed; a leading/trailing trim guards against pasted
//! newlines).

/// Guest-side setup parameters baked into the seed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CloudInitConfig {
    /// Guest hostname (also the instance-id suffix). Lowercase alnum + `-`.
    pub hostname: String,
    /// OpenSSH public key (single line, `ssh-ed25519 AAAA... comment`).
    pub ssh_pubkey: String,
    /// Docker install channel: `"get-docker"` (get.docker.com) or `"apt"`.
    #[serde(default = "default_docker_install")]
    pub docker_install: String,
}

fn default_docker_install() -> String {
    "get-docker".to_string()
}

impl Default for CloudInitConfig {
    fn default() -> Self {
        Self {
            hostname: "qemu-redroid".to_string(),
            ssh_pubkey: String::new(),
            docker_install: default_docker_install(),
        }
    }
}

/// Docker daemon proxy inside the guest, baked into user-data as a systemd
/// drop-in. QEMU user-mode networking pins the host side of the tunnel at
/// `10.0.2.2`, and `10808` is the operator's v2rayN mixed port — a personal
/// tool, so this is a compile-time constant by design (README §5): if the
/// host proxy port differs, edit this and rebuild. Without it `docker pull`
/// from CN networks is blocked.
pub const GUEST_DOCKER_PROXY: &str = "http://10.0.2.2:10808";

/// The shell fragment shared by user-data `runcmd` and the `guest provision`
/// recovery path ([`crate::guest::render_provision_script`]). Every step
/// tolerates failure (`|| true`) so a partially-prepared kernel never wedges
/// cloud-init; `verify` reports the real state afterwards.
///
/// Real-machine (node1) lessons baked in: Ubuntu cloud images ship **no**
/// `linux-modules-extra-<kernel>`, so `binder_linux` must be apt-installed
/// first; boot-time autoload goes through `/etc/modules-load.d/` (the
/// argument-free default load) while the *current* boot also gets the
/// argument-carrying `modprobe`. There is deliberately **no** binderfs mount
/// and **no** fstab entry: the redroid container mounts binderfs itself, and
/// an fstab entry for a missing module hung a whole boot in emergency mode.
pub const BINDER_PREP_SNIPPET: &str = "\
# --- redroid kernel preparation (see redroid docs: devel/kernel) ---
apt-get install -y linux-modules-extra-$(uname -r) || true
printf 'binder_linux\\n' | tee /etc/modules-load.d/binder.conf > /dev/null
modprobe binder_linux devices=\"binder,hwbinder,vndbinder\" || true";

/// The three lines wiring the guest docker daemon to the host proxy — shared
/// verbatim by user-data `runcmd` and the recovery script so the two paths
/// cannot drift. Written as a per-line `printf` (heredocs do not survive
/// cloud-init's runcmd quoting); real-machine verified on node1.
pub fn docker_proxy_dropin_lines() -> Vec<String> {
    vec![
        "mkdir -p /etc/systemd/system/docker.service.d".to_string(),
        format!(
            "printf '%s\\n' '[Service]' \
             'Environment=HTTP_PROXY={GUEST_DOCKER_PROXY}' \
             'Environment=HTTPS_PROXY={GUEST_DOCKER_PROXY}' \
             'Environment=NO_PROXY=localhost,127.0.0.1' \
             > /etc/systemd/system/docker.service.d/proxy.conf"
        ),
        "systemctl daemon-reload && systemctl restart docker || true".to_string(),
    ]
}

fn runcmd_lines(cfg: &CloudInitConfig) -> Vec<String> {
    // Kernel prep: BINDER_PREP_SNIPPET is a shell fragment; runcmd items are
    // one shell line each, so take it line-by-line minus the leading comment.
    let mut lines: Vec<String> = BINDER_PREP_SNIPPET
        .lines()
        .skip(1) // drop the leading comment; runcmd carries its own markers
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    // Docker engine.
    match cfg.docker_install.as_str() {
        "apt" => {
            lines.push("DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io".to_string());
        }
        // Default (and any unexpected value): the get.docker.com convenience
        // script, tolerant of a missing network mirror via `|| true`.
        _ => {
            lines.push("curl -fsSL https://get.docker.com | sh || true".to_string());
        }
    }
    lines.push("systemctl enable --now docker || true".to_string());
    lines.extend(docker_proxy_dropin_lines());
    lines.push("usermod -aG docker rdc || true".to_string());
    lines.push("getent group binder >/dev/null || groupadd binder || true".to_string());
    lines
}

/// Render `user-data` (#cloud-config YAML).
pub fn render_user_data(cfg: &CloudInitConfig) -> String {
    let key = cfg.ssh_pubkey.trim();
    let mut s = String::new();
    s.push_str("#cloud-config\n");
    s.push_str(&format!("hostname: {}\n", cfg.hostname));
    s.push_str("manage_etc_hosts: true\n");
    s.push_str("users:\n");
    s.push_str("  - name: rdc\n");
    s.push_str("    gecos: QemuCenter node user\n");
    s.push_str("    sudo: ALL=(ALL) NOPASSWD:ALL\n");
    s.push_str("    groups: [adm, sudo, dip, plugdev]\n");
    s.push_str("    lock_passwd: true\n");
    s.push_str("    shell: /bin/bash\n");
    s.push_str("    ssh_authorized_keys:\n");
    if !key.is_empty() {
        s.push_str(&format!("      - {key}\n"));
    } else {
        // No key bound yet: keep the file valid; `guest wait` will fail until
        // the operator re-creates with a key (documented in README).
        s.push_str("      - ssh-ed25519 PLACEHOLDER-recreate-seed-with-a-real-key\n");
    }
    s.push_str("ssh_pwauth: false\n");
    s.push_str("chpasswd:\n");
    s.push_str("  expire: false\n");
    s.push_str("package_update: true\n");
    s.push_str("packages:\n");
    s.push_str("  - docker.io\n");
    s.push_str("runcmd:\n");
    for line in runcmd_lines(cfg) {
        // Quote each item so shell metacharacters survive cloud-init's YAML
        // parse into a single /bin/sh -c invocation per list entry.
        s.push_str(&format!("  - {}\n", yaml_single_quoted(&line)));
    }
    s.push_str("final_message: \"qemu-center guest ready after $UPTIME seconds\"\n");
    s
}

/// YAML single-quote escaping: double the single quotes (YAML 1.1 rule).
fn yaml_single_quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Render `meta-data` (instance-id + local hostname).
pub fn render_meta_data(cfg: &CloudInitConfig) -> String {
    format!(
        "instance-id: iid-qemu-center-{}\nlocal-hostname: {}\n",
        cfg.hostname, cfg.hostname
    )
}

/// Render `network-config` (netplan config v2: DHCP4 on all `en*` NICs).
pub fn render_network_config(cfg: &CloudInitConfig) -> String {
    let _ = &cfg.hostname; // reserved for future static-IP node configs
    "\
version: 2
ethernets:
  all-eth:
    match:
      name: \"en*\"
    dhcp4: true
    optional: true
"
    .to_string()
}

/// All three seed files in the order `iso::build_iso` expects.
///
/// **Superseded by [`seed_dir_files`] / VVFAT, kept as a library API** (and as
/// the renderer-equivalence baseline in tests): `build_iso` uppercases these
/// names per ISO9660, which a real guest's cloud-init never saw through — see
/// the module docs.
pub fn seed_files(
    cfg: &CloudInitConfig,
) -> Result<Vec<(String, Vec<u8>)>, crate::iso::IsoError> {
    Ok(vec![
        ("user-data".to_string(), render_user_data(cfg).into_bytes()),
        ("meta-data".to_string(), render_meta_data(cfg).into_bytes()),
        (
            "network-config".to_string(),
            render_network_config(cfg).into_bytes(),
        ),
    ])
}

/// The same three seed files as [`seed_files`], named for a **FAT carrier**:
/// the names are stored verbatim — lowercase, no ISO9660 uppercase mapping, no
/// `.;1` version suffix. This is the shared renderer behind
/// [`seed_image_files`]; the name predates the current carrier (it used to
/// write a host directory for QEMU VVFAT) and is kept for history + tests.
pub fn seed_dir_files(cfg: &CloudInitConfig) -> Result<Vec<(String, Vec<u8>)>, String> {
    Ok(vec![
        ("user-data".to_string(), render_user_data(cfg).into_bytes()),
        ("meta-data".to_string(), render_meta_data(cfg).into_bytes()),
        (
            "network-config".to_string(),
            render_network_config(cfg).into_bytes(),
        ),
    ])
}

/// The three seed files in the shape [`crate::fat::build_fat16_image`]
/// consumes: names land in the image as VFAT long-file-name entries verbatim
/// (lowercase `user-data` / `meta-data` / `network-config` — what NoCloud
/// looks up) inside a volume labeled `CIDATA` (what `ds-identify` scans for).
pub fn seed_image_files(cfg: &CloudInitConfig) -> Result<Vec<(String, Vec<u8>)>, String> {
    seed_dir_files(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> CloudInitConfig {
        CloudInitConfig {
            hostname: "qc-node-1".to_string(),
            ssh_pubkey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey qc-test".to_string(),
            docker_install: "get-docker".to_string(),
        }
    }

    #[test]
    fn user_data_starts_with_cloud_config_directive() {
        assert!(render_user_data(&cfg()).starts_with("#cloud-config\n"));
    }

    #[test]
    fn user_data_contains_hostname_and_user() {
        let u = render_user_data(&cfg());
        assert!(u.contains("hostname: qc-node-1"));
        assert!(u.contains("- name: rdc\n"));
        assert!(u.contains("ssh_pwauth: false"));
        assert!(u.contains("lock_passwd: true"));
    }

    #[test]
    fn pubkey_is_injected_verbatim() {
        let u = render_user_data(&cfg());
        assert!(u.contains("      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey qc-test\n"));
        // The metadata default key must NOT appear when a key is provided.
        assert!(!u.contains("PLACEHOLDER"));
    }

    #[test]
    fn missing_pubkey_renders_placeholder_not_empty_list_item() {
        let mut c = cfg();
        c.ssh_pubkey = "  ".to_string();
        let u = render_user_data(&c);
        assert!(u.contains("PLACEHOLDER"));
    }

    #[test]
    fn binder_kernel_prep_installs_modules_extra_and_never_touches_fstab() {
        let u = render_user_data(&cfg());
        // Cloud images ship no linux-modules-extra: without it modprobe
        // binder_linux fails. `|| true`: a failed apt must not block
        // provisioning (verify item 3 reports the real binder state).
        assert!(u.contains("apt-get install -y linux-modules-extra-$(uname -r) || true"));
        // Boot-time autoload (argument-free default load) survives reboots.
        assert!(u.contains("printf ''binder_linux\\n'' | tee /etc/modules-load.d/binder.conf"));
        // The current boot still gets the argument-carrying modprobe.
        assert!(u.contains("modprobe binder_linux devices=\"binder,hwbinder,vndbinder\" || true"));
        // The fstab append once hung a whole boot in emergency mode — gone for
        // good, along with the host-side binderfs mount (the redroid container
        // mounts binderfs itself).
        assert!(!u.contains("/etc/fstab"));
        assert!(!u.contains("mount -t binder"));
        assert!(!u.contains("mkdir -p /dev/binderfs"));
    }

    #[test]
    fn docker_daemon_gets_the_guest_proxy_drop_in() {
        let u = render_user_data(&cfg());
        assert!(u.contains("mkdir -p /etc/systemd/system/docker.service.d"));
        let line = u
            .lines()
            .find(|l| l.contains("docker.service.d/proxy.conf"))
            .expect("proxy drop-in printf line present");
        // Per-line printf (heredocs break in runcmd) — real-machine verified.
        // Inner single quotes are YAML-escaped (doubled) in the scalar.
        assert!(line.trim_start().starts_with("- '"));
        assert!(line.trim_end().ends_with('\''));
        assert!(line.contains("printf ''%s\\n'' ''[Service]''"));
        assert!(line.contains("''Environment=HTTP_PROXY=http://10.0.2.2:10808''"));
        assert!(line.contains("''Environment=HTTPS_PROXY=http://10.0.2.2:10808''"));
        assert!(line.contains("''Environment=NO_PROXY=localhost,127.0.0.1''"));
        assert!(u.contains("systemctl daemon-reload && systemctl restart docker || true"));
    }

    #[test]
    fn docker_install_channels_switch() {
        let u = render_user_data(&cfg());
        assert!(u.contains("get.docker.com"));
        assert!(u.contains("systemctl enable --now docker"));

        let mut c = cfg();
        c.docker_install = "apt".to_string();
        let u2 = render_user_data(&c);
        assert!(u2.contains("apt-get install -y docker.io"));
        assert!(!u2.contains("get.docker.com"));
    }

    #[test]
    fn runcmd_items_are_single_quoted() {
        let u = render_user_data(&cfg());
        // Every runcmd list item is quoted; e.g. the modprobe line with its
        // inner double quotes stays a single YAML scalar.
        let line = u
            .lines()
            .find(|l| l.contains("modprobe binder_linux"))
            .expect("modprobe line present");
        assert!(line.trim_start().starts_with("- '"));
        assert!(line.trim_end().ends_with('\''));
        assert!(line.contains("devices=\"binder,hwbinder,vndbinder\""));
    }

    #[test]
    fn renders_are_deterministic() {
        for _ in 0..3 {
            assert_eq!(render_user_data(&cfg()), render_user_data(&cfg()));
            assert_eq!(render_meta_data(&cfg()), render_meta_data(&cfg()));
            assert_eq!(
                render_network_config(&cfg()),
                render_network_config(&cfg())
            );
        }
        let mut other = cfg();
        other.hostname = "qc-node-2".to_string();
        assert_ne!(render_user_data(&other), render_user_data(&cfg()));
    }

    #[test]
    fn yaml_has_no_tabs() {
        let u = render_user_data(&cfg());
        assert!(!u.contains('\t'), "tabs would break YAML indentation");
    }

    #[test]
    fn meta_data_contains_instance_and_hostname() {
        let m = render_meta_data(&cfg());
        assert!(m.contains("instance-id: iid-qemu-center-qc-node-1"));
        assert!(m.contains("local-hostname: qc-node-1"));
    }

    #[test]
    fn network_config_is_netplan_v2_with_dhcp() {
        let n = render_network_config(&cfg());
        assert!(n.starts_with("version: 2\n"));
        assert!(n.contains("dhcp4: true"));
        assert!(n.contains("en*"));
    }

    #[test]
    fn seed_files_shapes_and_names() {
        let files = seed_files(&cfg()).unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].0, "user-data");
        assert_eq!(files[1].0, "meta-data");
        assert_eq!(files[2].0, "network-config");
        for (_, bytes) in &files {
            assert!(!bytes.is_empty());
        }
    }

    #[test]
    fn seed_files_feed_the_iso_roundtrip() {
        let files = seed_files(&cfg()).unwrap();
        let refs: Vec<(&str, &[u8])> =
            files.iter().map(|(n, c)| (n.as_str(), c.as_slice())).collect();
        let img = crate::iso::build_iso(&refs).unwrap();
        let parsed = crate::iso::parse_iso(&img).unwrap();
        assert_eq!(parsed.volume_id, crate::iso::CIDATA_VOLUME_ID);
        let mut got: Vec<(String, String)> = parsed
            .files
            .iter()
            .map(|(n, c)| (n.clone(), String::from_utf8_lossy(c).to_string()))
            .collect();
        got.sort();
        assert_eq!(got[2].1, render_user_data(&cfg())); // sorted last: user-data
    }

    #[test]
    fn seed_dir_files_render_identical_content_to_seed_files() {
        // Same cfg in, byte-identical files out: the VVFAT carrier changes
        // only how names reach the guest (verbatim FAT vs ISO9660-uppercase),
        // never the rendered YAML.
        for c in [
            cfg(),
            CloudInitConfig::default(),
            CloudInitConfig {
                docker_install: "apt".to_string(),
                ..cfg()
            },
        ] {
            assert_eq!(
                seed_dir_files(&c).unwrap(),
                seed_files(&c).unwrap(),
                "renderer drift between the ISO and directory carriers"
            );
        }
    }

    #[test]
    fn seed_dir_file_names_are_lowercase_verbatim_fat_safe() {
        let files = seed_dir_files(&cfg()).unwrap();
        assert_eq!(files.len(), 3);
        for (name, bytes) in &files {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
                "names must be stored verbatim lowercase (cloud-init NoCloud looks up exactly user-data/meta-data/network-config): {name:?}"
            );
            // No ISO9660 version/extension suffix may leak into a FAT name.
            assert!(!name.contains('.') && !name.contains(';'), "{name:?}");
            assert!(!bytes.is_empty());
        }
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["user-data", "meta-data", "network-config"]);
    }

    #[test]
    fn seed_image_files_are_the_fat16_carrier_shape() {
        // The image carrier consumes exactly what the (historical) directory
        // renderer produced: same files, same order, same bytes.
        for c in [cfg(), CloudInitConfig::default()] {
            assert_eq!(seed_image_files(&c).unwrap(), seed_dir_files(&c).unwrap());
        }
        // And they are the three exact lowercase names NoCloud looks up on a
        // volume labeled CIDATA (see crate::fat for the label side).
        let files = seed_image_files(&cfg()).unwrap();
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["user-data", "meta-data", "network-config"]);
    }

    #[test]
    fn config_serializes_to_state_json_shape() {
        let c = cfg();
        let json = serde_json::to_string(&c).unwrap();
        let back: CloudInitConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
        // docker_install defaults when absent (state files from older builds).
        let v: CloudInitConfig =
            serde_json::from_str(r#"{"hostname":"h","ssh_pubkey":""}"#).unwrap();
        assert_eq!(v.docker_install, "get-docker");
    }
}
