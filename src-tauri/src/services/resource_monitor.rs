use serde::{Deserialize, Serialize};
use std::time::Duration;

use chrono::Utc;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryPressure {
    Normal,
    Caution,
    Critical,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceSnapshotSource {
    Host,
    Qemu,
    Guest,
    Container,
    Adb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessMemory {
    pub pid: u32,
    pub private_bytes: u64,
    pub working_set_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceSnapshot {
    pub captured_at: String,
    pub host_total_bytes: Option<u64>,
    pub host_available_bytes: Option<u64>,
    pub qemu_private_bytes: Option<u64>,
    pub qemu_working_set_bytes: Option<u64>,
    pub wsl_private_bytes: Option<u64>,
    pub vm_memory_mib: Option<u32>,
    pub vm_vcpus: Option<u16>,
    pub instance_memory_limit_bytes: Option<u64>,
    pub instance_memory_current_bytes: Option<u64>,
    pub instance_memory_peak_bytes: Option<u64>,
    pub instance_oom_kills: Option<u64>,
    pub boot_completed: Option<bool>,
    pub app_ready_ms: Option<u64>,
    pub source: ResourceSnapshotSource,
}

impl Default for RuntimeResourceSnapshot {
    fn default() -> Self {
        Self {
            captured_at: String::new(),
            host_total_bytes: None,
            host_available_bytes: None,
            qemu_private_bytes: None,
            qemu_working_set_bytes: None,
            wsl_private_bytes: None,
            vm_memory_mib: None,
            vm_vcpus: None,
            instance_memory_limit_bytes: None,
            instance_memory_current_bytes: None,
            instance_memory_peak_bytes: None,
            instance_oom_kills: None,
            boot_completed: None,
            app_ready_ms: None,
            source: ResourceSnapshotSource::Host,
        }
    }
}

#[cfg(test)]
impl RuntimeResourceSnapshot {
    fn empty_for_test() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryThresholds {
    pub caution_available_bytes: u64,
    pub critical_available_bytes: u64,
}

impl Default for MemoryThresholds {
    fn default() -> Self {
        Self {
            caution_available_bytes: 2 * GIB,
            critical_available_bytes: GIB,
        }
    }
}

pub fn classify_memory_pressure(available_bytes: Option<u64>) -> MemoryPressure {
    classify_memory_pressure_with(available_bytes, MemoryThresholds::default())
}

pub fn classify_memory_pressure_with(
    available_bytes: Option<u64>,
    thresholds: MemoryThresholds,
) -> MemoryPressure {
    let Some(available) = available_bytes else {
        return MemoryPressure::Unknown;
    };
    if available < thresholds.critical_available_bytes {
        MemoryPressure::Critical
    } else if available < thresholds.caution_available_bytes {
        MemoryPressure::Caution
    } else {
        MemoryPressure::Normal
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceProbeError {
    InvalidValue(String),
    Unavailable(String),
    Timeout(String),
}

impl std::fmt::Display for ResourceProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidValue(detail) => write!(f, "invalid resource value: {detail}"),
            Self::Unavailable(detail) => write!(f, "resource probe unavailable: {detail}"),
            Self::Timeout(detail) => write!(f, "resource probe timed out: {detail}"),
        }
    }
}

impl std::error::Error for ResourceProbeError {}

pub fn parse_process_memory(raw: &str) -> Result<ProcessMemory, ResourceProbeError> {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| ResourceProbeError::InvalidValue("empty process row".into()))?;
    let mut fields = line.split('|');
    let pid = parse_u32(fields.next(), "pid")?;
    let private_bytes = parse_u64(fields.next(), "private bytes")?;
    let working_set_bytes = parse_u64(fields.next(), "working-set bytes")?;
    if fields.next().is_some() {
        return Err(ResourceProbeError::InvalidValue(
            "process row has too many fields".into(),
        ));
    }
    Ok(ProcessMemory {
        pid,
        private_bytes,
        working_set_bytes,
    })
}

/// Parse the two KiB values emitted by Win32_OperatingSystem. The public
/// snapshot stores bytes so callers never need to remember the WMI unit.
pub fn parse_host_memory(raw: &str) -> Result<(u64, u64), ResourceProbeError> {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| ResourceProbeError::InvalidValue("empty host memory row".into()))?;
    let mut fields = line.split('|');
    let total_kib = parse_u64(fields.next(), "total memory")?;
    let available_kib = parse_u64(fields.next(), "available memory")?;
    if fields.next().is_some() {
        return Err(ResourceProbeError::InvalidValue(
            "host memory row has too many fields".into(),
        ));
    }
    Ok((
        total_kib
            .checked_mul(1024)
            .ok_or_else(|| ResourceProbeError::InvalidValue("total memory overflow".into()))?,
        available_kib
            .checked_mul(1024)
            .ok_or_else(|| ResourceProbeError::InvalidValue("available memory overflow".into()))?,
    ))
}

/// Pick the exact QEMU process whose `-name` value belongs to a VM. Keeping
/// this parser separate from the PowerShell probe prevents a prefix match such
/// as `node1` selecting `node10`.
pub fn qemu_pid_for_vm(raw: &str, vm: &str) -> Option<u32> {
    let vm = vm.trim();
    if vm.is_empty() {
        return None;
    }
    let expected_name = format!("qemu-center-{vm}");
    raw.lines().find_map(|line| {
        let (pid, command_line) = line.trim().split_once('|')?;
        let pid = pid.trim().parse::<u32>().ok()?;
        let args: Vec<&str> = command_line
            .split_whitespace()
            .map(|arg| arg.trim_matches('"'))
            .collect();
        args.windows(2)
            .any(|pair| pair[0] == "-name" && pair[1] == expected_name)
            .then_some(pid)
    })
}

fn parse_u32(value: Option<&str>, label: &str) -> Result<u32, ResourceProbeError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ResourceProbeError::InvalidValue(format!("missing {label}")))?;
    value
        .parse::<u32>()
        .map_err(|_| ResourceProbeError::InvalidValue(format!("invalid {label}: {value:?}")))
}

fn parse_u64(value: Option<&str>, label: &str) -> Result<u64, ResourceProbeError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ResourceProbeError::InvalidValue(format!("missing {label}")))?;
    value
        .parse::<u64>()
        .map_err(|_| ResourceProbeError::InvalidValue(format!("invalid {label}: {value:?}")))
}

const POWERSHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

fn run_powershell(script: &str) -> crate::models::ShellResult {
    let args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ];
    crate::services::util::run_command_timeout("powershell.exe", &args, POWERSHELL_PROBE_TIMEOUT)
}

fn optional_process_memory(script: &str) -> Option<ProcessMemory> {
    let result = run_powershell(script);
    if !result.success {
        return None;
    }
    parse_process_memory(&result.stdout).ok()
}

fn current_qemu_pid(vm: &str) -> Option<u32> {
    let result = run_powershell(
        "Get-CimInstance Win32_Process -Filter \"Name = 'qemu-system-x86_64.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
    );
    result
        .success
        .then(|| qemu_pid_for_vm(&result.stdout, vm))
        .flatten()
}

/// Collect only host-level values. Guest/container fields are intentionally
/// left unknown until the QEMU guest stats command supplies them.
pub fn collect_host_snapshot(
    qemu_pid: Option<u32>,
) -> Result<RuntimeResourceSnapshot, ResourceProbeError> {
    let host = run_powershell(
        "$o = Get-CimInstance Win32_OperatingSystem; \"$($o.TotalVisibleMemorySize)|$($o.FreePhysicalMemory)\"",
    );
    if !host.success {
        return Err(ResourceProbeError::Unavailable(
            host.stderr.trim().to_string(),
        ));
    }
    let (host_total_bytes, host_available_bytes) = parse_host_memory(&host.stdout)?;

    let qemu = qemu_pid.and_then(|pid| {
        optional_process_memory(&format!(
            "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($null -ne $p) {{ \"$($p.Id)|$($p.PrivateMemorySize64)|$($p.WorkingSet64)\" }}",
        ))
    });
    let wsl = optional_process_memory(
        "$p = Get-Process -Name vmmemWSL -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $p) { \"$($p.Id)|$($p.PrivateMemorySize64)|$($p.WorkingSet64)\" }",
    );

    Ok(RuntimeResourceSnapshot {
        captured_at: Utc::now().to_rfc3339(),
        host_total_bytes: Some(host_total_bytes),
        host_available_bytes: Some(host_available_bytes),
        qemu_private_bytes: qemu.map(|memory| memory.private_bytes),
        qemu_working_set_bytes: qemu.map(|memory| memory.working_set_bytes),
        wsl_private_bytes: wsl.map(|memory| memory.private_bytes),
        vm_memory_mib: None,
        vm_vcpus: None,
        instance_memory_limit_bytes: None,
        instance_memory_current_bytes: None,
        instance_memory_peak_bytes: None,
        instance_oom_kills: None,
        boot_completed: None,
        app_ready_ms: None,
        source: ResourceSnapshotSource::Host,
    })
}

pub fn read_runtime_resource_snapshot(
    vm: Option<&str>,
    _instance: Option<&str>,
) -> Result<RuntimeResourceSnapshot, String> {
    let qemu_pid = vm
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .and_then(current_qemu_pid);
    collect_host_snapshot(qemu_pid).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_memory_pressure, parse_host_memory, parse_process_memory, qemu_pid_for_vm,
        MemoryPressure, RuntimeResourceSnapshot,
    };

    #[test]
    fn classifies_pressure_from_available_memory_without_treating_unknown_as_safe() {
        assert_eq!(
            classify_memory_pressure(Some(3 * 1024 * 1024 * 1024)),
            MemoryPressure::Normal
        );
        assert_eq!(
            classify_memory_pressure(Some(1500 * 1024 * 1024)),
            MemoryPressure::Caution
        );
        assert_eq!(
            classify_memory_pressure(Some(700 * 1024 * 1024)),
            MemoryPressure::Critical
        );
        assert_eq!(classify_memory_pressure(None), MemoryPressure::Unknown);
    }

    #[test]
    fn serializes_missing_measurements_as_null() {
        let snapshot = RuntimeResourceSnapshot::empty_for_test();
        let json = serde_json::to_value(snapshot).unwrap();
        assert!(json["hostAvailableBytes"].is_null());
        assert!(json["instanceOomKills"].is_null());
    }

    #[test]
    fn parses_process_private_and_working_set_bytes() {
        let process = parse_process_memory("11704|4654596096|639070208").unwrap();
        assert_eq!(process.private_bytes, 4_654_596_096);
        assert_eq!(process.working_set_bytes, 639_070_208);
    }

    #[test]
    fn rejects_malformed_or_negative_process_values() {
        assert!(parse_process_memory("11704|-1|10").is_err());
        assert!(parse_process_memory("not-a-process").is_err());
    }

    #[test]
    fn parses_total_and_available_host_memory_bytes() {
        let memory = parse_host_memory("16493364|3941820").unwrap();
        assert_eq!(memory, (16_493_364 * 1024, 3_941_820 * 1024));
    }

    #[test]
    fn finds_the_exact_qemu_vm_process_without_prefix_collisions() {
        let rows = "11704|-name qemu-center-node10 -m 4096\n11705|-name qemu-center-node1 -m 4096";
        assert_eq!(qemu_pid_for_vm(rows, "node1"), Some(11705));
        assert_eq!(qemu_pid_for_vm(rows, "node"), None);
    }
}
