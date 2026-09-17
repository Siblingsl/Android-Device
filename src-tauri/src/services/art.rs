use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::models::ShellResult;
use crate::services::adb;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArtMode {
    VerifyOnly,
    SpeedProfile,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtOptimizationResult {
    pub serial: String,
    pub package: String,
    pub mode: ArtMode,
    pub success: bool,
    pub exit_code: i32,
    pub elapsed_ms: u128,
    pub output: String,
    pub warning: String,
}

fn valid_package(package: &str) -> bool {
    let mut parts = package.split('.');
    let count = parts.clone().count();
    count >= 2
        && parts.all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'_'))
                && part.as_bytes()[0].is_ascii_alphanumeric()
        })
}

pub fn art_args(package: &str, mode: ArtMode) -> Vec<String> {
    match mode {
        ArtMode::VerifyOnly => vec![
            "cmd".into(),
            "package".into(),
            "compile".into(),
            "--check-prof".into(),
            package.into(),
        ],
        ArtMode::SpeedProfile => vec![
            "cmd".into(),
            "package".into(),
            "compile".into(),
            "-m".into(),
            "speed-profile".into(),
            "-f".into(),
            package.into(),
        ],
        ArtMode::Reset => vec![
            "cmd".into(),
            "package".into(),
            "compile".into(),
            "--reset".into(),
            package.into(),
        ],
    }
}

pub fn optimize_app(
    serial: &str,
    package: &str,
    mode: ArtMode,
) -> Result<ArtOptimizationResult, String> {
    if serial.trim().is_empty() {
        return Err("ADB serial must not be empty".into());
    }
    if !valid_package(package) {
        return Err(format!("invalid Android package name: {package:?}"));
    }
    let args = art_args(package, mode);
    let command = args.join(" ");
    let started = Instant::now();
    let shell: ShellResult = adb::shell_timeout(serial, &command, Duration::from_secs(180));
    Ok(ArtOptimizationResult {
        serial: serial.into(),
        package: package.into(),
        mode,
        success: shell.success,
        exit_code: shell.exit_code,
        elapsed_ms: started.elapsed().as_millis(),
        output: if shell.stdout.trim().is_empty() {
            shell.stderr.clone()
        } else {
            shell.stdout.clone()
        },
        warning: "ART compilation may reduce app startup compilation work; it does not remove ARM64 translation cost or guarantee lower memory usage.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_profile_uses_a_profile_guided_compile_command() {
        assert_eq!(
            art_args("com.xingin.xhs", ArtMode::SpeedProfile),
            vec![
                "cmd",
                "package",
                "compile",
                "-m",
                "speed-profile",
                "-f",
                "com.xingin.xhs"
            ]
        );
    }

    #[test]
    fn reset_and_verify_are_distinct_commands() {
        assert_eq!(
            art_args("com.example.app", ArtMode::VerifyOnly),
            vec!["cmd", "package", "compile", "--check-prof", "com.example.app"]
        );
        assert_eq!(
            art_args("com.example.app", ArtMode::Reset),
            vec!["cmd", "package", "compile", "--reset", "com.example.app"]
        );
    }

    #[test]
    fn package_validation_blocks_shell_fragments() {
        assert!(valid_package("com.xingin.xhs"));
        assert!(!valid_package("com.example.app;id"));
        assert!(!valid_package("com..app"));
    }
}
