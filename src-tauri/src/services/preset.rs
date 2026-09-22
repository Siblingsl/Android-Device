use std::path::Path;

use crate::models::CreateInstanceRequest;

pub fn prepare(req: &CreateInstanceRequest, base: &str, work: &Path) -> Result<(), String> {
    validate_image(base)?;
    if (req.install_lsposed || req.install_shamiko) && !req.install_magisk {
        return Err("LSPosed / Shamiko 需要预装 Magisk。".into());
    }
    crate::services::docker::prepare_preset_context(req, base, work)
}

pub(crate) fn validate_image(base: &str) -> Result<(), String> {
    if base.is_empty()
        || !base.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !base
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/:@".contains(c))
    {
        return Err("镜像引用无效：仅允许镜像名称、标签或摘要，不能包含空白或命令插值。".into());
    }
    Ok(())
}

pub(crate) fn validate_immutable_image(base: &str) -> Result<(), String> {
    if !base.contains("@sha256:")
        || base
            .split_once("@sha256:")
            .map(|(_, digest)| digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()))
            != Some(true)
    {
        return Err("受保护镜像必须使用完整 SHA-256 digest".into());
    }
    validate_image(base)
}

fn android_major(value: &str) -> Option<u32> {
    value.trim().split(['.', '-']).next()?.parse().ok()
}

#[derive(Default)]
struct Metadata {
    versions: Vec<u32>,
    architectures: Vec<String>,
}

impl Metadata {
    fn named(&mut self, name: &str) {
        let name = name.to_ascii_lowercase();
        if !name.contains("gapps") {
            return;
        }
        if name.contains("x86_64") {
            self.architectures.push("x86_64".into());
        }
        if name.contains("arm64") || name.contains("aarch64") {
            self.architectures.push("arm64".into());
        }
        if name.contains("-arm-") || name.contains("-arm.") {
            self.architectures.push("arm".into());
        }
        if name.contains("-x86-") || name.contains("-x86.") {
            self.architectures.push("x86".into());
        }
        for token in name.split(['-', '_']) {
            let number = token.split('.').next().unwrap_or("");
            if let Ok(major) = number.parse::<u32>() {
                if (5..=30).contains(&major) {
                    self.versions.push(major);
                }
            }
        }
    }

    fn field(&mut self, key: &str, value: &str) {
        let key = key.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
        let value = value
            .trim()
            .trim_matches(['"', '\'', ',', ';'])
            .to_ascii_lowercase();
        match key.as_str() {
            "version_nice"
            | "android_version"
            | "androidversion"
            | "android"
            | "ro.build.version.release"
            | "gapps_android_version" => {
                if let Some(major) = android_major(&value) {
                    self.versions.push(major);
                }
            }
            "arch" | "architecture" | "ro.product.cpu.abi" | "gapps_arch" => {
                self.architectures.push(value)
            }
            _ => {}
        }
    }

    fn text(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        if let Ok(serde_json::Value::Object(fields)) = serde_json::from_str(&text) {
            for (key, value) in fields {
                if let Some(value) = value.as_str() {
                    self.field(&key, value);
                } else if value.is_number() {
                    self.field(&key, &value.to_string());
                }
            }
        }
        for line in text.lines() {
            if let Some((key, value)) = line.trim().split_once('=') {
                self.field(key, value);
            }
        }
    }

    fn validate(&self, version: &str) -> Result<(), String> {
        let expected =
            android_major(version).ok_or_else(|| format!("Android 版本无效: {version}"))?;
        if self.versions.is_empty() || self.architectures.is_empty() {
            return Err("GApps 缺少明确的 Android 版本或架构元数据；请保留 MindTheGapps-13.0.0-x86_64 等原始名称，或提供 gapps.prop / gapps.json（android_version 与 arch）。".into());
        }
        if self.versions.iter().any(|v| *v != expected) {
            return Err(format!(
                "GApps Android 版本 {:?} 与目标 Android {version} 不兼容。",
                self.versions
            ));
        }
        if self
            .architectures
            .iter()
            .any(|arch| arch != "x86_64" && arch != "amd64")
        {
            return Err(format!(
                "GApps 架构 {:?} 不兼容；需要 x86_64。",
                self.architectures
            ));
        }
        Ok(())
    }
}

fn is_metadata(name: &str) -> bool {
    matches!(
        name.rsplit('/')
            .next()
            .unwrap_or(name)
            .to_ascii_lowercase()
            .as_str(),
        "gapps.prop"
            | "gapps.json"
            | "metadata.json"
            | "build.prop"
            | ".gapps-metadata"
            | "installer.sh"
    )
}

fn validate_elf(bytes: &[u8], name: &str) -> Result<(), String> {
    if bytes.len() >= 20 && bytes.starts_with(b"\x7fELF") {
        let machine = if bytes[5] == 2 {
            u16::from_be_bytes([bytes[18], bytes[19]])
        } else {
            u16::from_le_bytes([bytes[18], bytes[19]])
        };
        if machine != 3 && machine != 62 {
            return Err(format!(
                "GApps overlay 包含非 x86/x86_64 原生库: {name} (ELF machine {machine})"
            ));
        }
    }
    Ok(())
}

/// Validate named or explicit GApps metadata and native overlay ELF architecture.
/// Extracted folders may use gapps.prop: android_version=13 and arch=x86_64.
pub fn validate_gapps(path: &Path, version: &str) -> Result<(), String> {
    use std::io::Read;
    let mut metadata = Metadata::default();
    metadata.named(&path.file_name().unwrap_or_default().to_string_lossy());
    // Reject obvious mismatches even when the supplied file no longer exists.
    if !metadata.versions.is_empty() && !metadata.architectures.is_empty() {
        metadata.validate(version)?;
    }
    if path.is_dir() {
        let mut pending = vec![path.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).map_err(|e| format!("读取 GApps 目录失败: {e}"))?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() {
                    return Err("GApps 目录不能包含符号链接。".into());
                }
                if kind.is_dir() {
                    pending.push(entry.path());
                    continue;
                }
                let name = entry
                    .path()
                    .strip_prefix(path)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let mut bytes = Vec::new();
                std::fs::File::open(entry.path())
                    .map_err(|e| e.to_string())?
                    .take(if is_metadata(&name) { 65536 } else { 20 })
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if is_metadata(&name) {
                    metadata.text(&bytes);
                }
                validate_elf(&bytes, &name)?;
            }
        }
    } else {
        let file = std::fs::File::open(path)
            .map_err(|e| format!("GApps 路径无法读取 {}: {e}", path.display()))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("GApps zip 无效: {e}"))?;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| e.to_string())?;
            if entry.enclosed_name().is_none()
                || entry.name().contains('\\')
                || entry
                    .unix_mode()
                    .map(|mode| mode & 0o170000 == 0o120000)
                    .unwrap_or(false)
            {
                return Err(format!(
                    "GApps zip 包含不安全路径或符号链接: {}",
                    entry.name()
                ));
            }
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let mut bytes = Vec::new();
            entry
                .take(if is_metadata(&name) { 65536 } else { 20 })
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if is_metadata(&name) {
                metadata.text(&bytes);
            }
            validate_elf(&bytes, &name)?;
        }
    }
    metadata.validate(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("rdc-preset-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn zip(&self, name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
            let path = self.0.join(name);
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            for (name, bytes) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn request(gapps: &Path) -> CreateInstanceRequest {
        serde_json::from_value(serde_json::json!({
            "name":"test", "androidVersion":"13", "cpu":"2", "ram":"2048",
            "resolution":"720x1280", "dpi":"320", "adbPort":5555, "scrcpyPort":27183,
            "image":"redroid/redroid:13.0.0-latest", "installGapps":true,
            "gappsZip":gapps.to_string_lossy()
        }))
        .unwrap()
    }

    #[test]
    fn prepares_gapps_only_without_magisk_or_docker() {
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-x86_64.zip",
            &[("system/priv-app/GmsCore/GmsCore.apk", b"apk")],
        );
        let work = fixture.0.join("context");
        prepare(&request(&zip), "redroid/redroid:13.0.0-latest", &work).unwrap();
        assert_eq!(
            std::fs::read(work.join("overlay/priv-app/GmsCore/GmsCore.apk")).unwrap(),
            b"apk"
        );
        assert_eq!(
            std::fs::read_to_string(work.join("Dockerfile")).unwrap(),
            "FROM redroid/redroid:13.0.0-latest\nCOPY overlay/ /system/\n"
        );
    }

    #[test]
    fn rejects_gapps_android_version_mismatch() {
        assert!(validate_gapps(Path::new("MindTheGapps-13.0.0-x86_64.zip"), "14").is_err());
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-x86_64.zip",
            &[("system/app/test.apk", b"apk")],
        );
        assert!(validate_gapps(&zip, "14").unwrap_err().contains("版本"));
    }

    #[test]
    fn rejects_arm64_gapps() {
        assert!(validate_gapps(Path::new("MindTheGapps-13.0.0-arm64.zip"), "13").is_err());
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-arm64.zip",
            &[("system/app/test.apk", b"apk")],
        );
        assert!(validate_gapps(&zip, "13").unwrap_err().contains("架构"));
    }

    #[test]
    fn rejects_unknown_extracted_directory_metadata() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(fixture.0.join("system/priv-app")).unwrap();
        assert!(validate_gapps(&fixture.0, "13").is_err());
    }

    #[test]
    fn rejects_arm64_overlay_elf_despite_x86_filename() {
        let fixture = Fixture::new();
        let mut elf = [0u8; 20];
        elf[..4].copy_from_slice(b"\x7fELF");
        elf[4] = 2;
        elf[5] = 1;
        elf[18] = 183;
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-x86_64.zip",
            &[("system/lib64/libgms.so", &elf)],
        );
        assert!(validate_gapps(&zip, "13").is_err());
    }

    #[test]
    fn rejects_dockerfile_and_shell_interpolation_in_image() {
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-x86_64.zip",
            &[("system/app/test.apk", b"apk")],
        );
        for base in [
            "redroid:13\nRUN touch /bad",
            "redroid:$(whoami)",
            "redroid:13;id",
        ] {
            assert!(prepare(&request(&zip), base, &fixture.0.join("context"))
                .unwrap_err()
                .contains("镜像引用"));
        }
    }

    #[test]
    fn accepts_only_immutable_image_references_for_protected_builds() {
        assert!(validate_immutable_image("redroid/redroid@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").is_ok());
        for image in [
            "redroid/redroid:14.0.0-latest",
            "redroid/redroid@sha256:short",
            "redroid/redroid@sha256:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
            "",
        ] {
            assert!(validate_immutable_image(image).is_err(), "{image:?} must be rejected");
        }
    }

    #[test]
    fn prepares_extracted_overlay_with_explicit_metadata() {
        let fixture = Fixture::new();
        let source = fixture.0.join("extracted");
        std::fs::create_dir_all(source.join("system/app/Gms")).unwrap();
        std::fs::write(source.join("system/app/Gms/Gms.apk"), b"apk").unwrap();
        std::fs::write(
            source.join("gapps.json"),
            r#"{"android_version":13,"arch":"x86_64"}"#,
        )
        .unwrap();
        let work = fixture.0.join("context");
        prepare(&request(&source), "redroid/redroid:13.0.0-latest", &work).unwrap();
        assert_eq!(
            std::fs::read(work.join("overlay/app/Gms/Gms.apk")).unwrap(),
            b"apk"
        );
        assert!(validate_gapps(&source, "14").unwrap_err().contains("版本"));
    }

    #[test]
    fn prepares_renamed_zip_with_mindthegapps_build_metadata() {
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "overlay.zip",
            &[
                (
                    "build.prop",
                    b"arch=x86_64\nversion=33\nversion_nice=13.0.0\n",
                ),
                ("system/app/Gms/Gms.apk", b"apk"),
            ],
        );
        let work = fixture.0.join("context");
        prepare(&request(&zip), "redroid/redroid:13.0.0-latest", &work).unwrap();
        assert_eq!(
            std::fs::read(work.join("overlay/app/Gms/Gms.apk")).unwrap(),
            b"apk"
        );
        assert!(validate_gapps(&zip, "14").unwrap_err().contains("版本"));
    }

    #[test]
    fn rejects_conflicting_explicit_metadata() {
        let fixture = Fixture::new();
        let zip = fixture.zip(
            "MindTheGapps-13.0.0-x86_64.zip",
            &[("gapps.prop", b"android_version=14\narch=arm64\n")],
        );
        assert!(validate_gapps(&zip, "13").is_err());
    }

    #[test]
    #[ignore = "requires downloaded local GApps/Magisk assets kept out of Git"]
    fn prepares_downloaded_gapps_magisk_modules_without_docker() {
        let root = crate::services::docker::project_root_dirs()
            .into_iter()
            .find(|root| {
                root.join("vendor/gapps/MindTheGapps-13.0.0-x86_64-20231025_201203.zip")
                    .exists()
            })
            .unwrap();
        let mut req =
            request(&root.join("vendor/gapps/MindTheGapps-13.0.0-x86_64-20231025_201203.zip"));
        req.install_magisk = true;
        req.install_lsposed = true;
        req.install_shamiko = true;
        let fixture = Fixture::new();
        prepare(
            &req,
            "redroid/redroid:13.0.0-latest",
            &fixture.0.join("context"),
        )
        .unwrap();
        let context = fixture.0.join("context");
        for file in [
            "bin/magisk",
            "bin/magiskpolicy",
            "bin/busybox",
            "data/magisk.apk",
            "data/stub.apk",
            "data/spoof.conf",
            "etc/magisk_preset.rc",
        ] {
            assert!(context.join(file).is_file(), "missing {file}");
        }
        assert_eq!(
            std::fs::read_dir(context.join("modules")).unwrap().count(),
            2
        );
        assert!(!std::fs::read(context.join("bin/magisk_preset.sh"))
            .unwrap()
            .contains(&b'\r'));
        assert!(
            std::fs::read_dir(context.join("overlay/priv-app"))
                .unwrap()
                .count()
                > 0
        );
    }
}
