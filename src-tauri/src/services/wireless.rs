use std::time::Duration;

use crate::models::{ShellResult, WirelessDiscovery};
use crate::services::{adb, util};

pub fn parse_wireless_address(value: &str) -> Result<(String, u16), String> {
    let trimmed = value.trim();
    let (host, port_text, display_host) = if let Some(rest) = trimmed.strip_prefix('[') {
        let Some((host, port_text)) = rest.split_once("]:") else {
            return Err("IPv6 地址应使用 [地址]:端口格式".into());
        };
        (host, port_text, format!("[{host}]"))
    } else {
        let Some((host, port_text)) = trimmed.rsplit_once(':') else {
            return Err("地址格式应为 IP:端口".into());
        };
        if host.contains(':') {
            return Err("IPv6 地址应使用 [地址]:端口格式".into());
        }
        (host, port_text, host.to_string())
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err("地址包含不允许的字符".into());
    }
    let port = port_text
        .parse::<u16>()
        .map_err(|_| "端口必须是 1-65535".to_string())?;
    if port == 0 {
        return Err("端口必须是 1-65535".into());
    }
    Ok((display_host, port))
}

pub fn validate_pair_code(value: &str) -> Result<(), String> {
    let code = value.trim();
    if (4..=16).contains(&code.len()) && code.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err("配对码应为 4-16 位数字".into())
    }
}

pub fn parse_mdns_services(output: &str) -> Vec<String> {
    let mut services = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if !parts.iter().any(|part| part.contains("_adb-tls-")) {
            continue;
        }
        let Some(address) = parts
            .iter()
            .find(|part| parse_wireless_address(part).is_ok())
        else {
            continue;
        };
        let value = (*address).to_string();
        if !services.contains(&value) {
            services.push(value);
        }
    }
    services
}

pub fn pair(address: &str, code: &str) -> ShellResult {
    let (host, port) = match parse_wireless_address(address) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    if let Err(error) = validate_pair_code(code) {
        return failed(error);
    }
    util::run_command(
        &adb::adb_bin(),
        &["pair", &format!("{}:{}", host, port), code.trim()],
    )
}

pub fn tcpip(serial: &str, port: u16) -> ShellResult {
    if serial.trim().is_empty() || port == 0 {
        return failed("Serial 和端口不能为空");
    }
    util::run_command(&adb::adb_bin(), &["-s", serial, "tcpip", &port.to_string()])
}

pub fn discover() -> WirelessDiscovery {
    let result = util::run_command_timeout(
        &adb::adb_bin(),
        &["mdns", "services"],
        Duration::from_secs(8),
    );
    let services = parse_mdns_services(&result.stdout);
    WirelessDiscovery {
        status: if result.success {
            "found".into()
        } else {
            "error".into()
        },
        services,
        message: if result.success {
            result.stdout.trim().into()
        } else {
            result.stderr.trim().into()
        },
    }
}

fn failed(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: false,
        stderr: message.into(),
        exit_code: -1,
        ..ShellResult::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mdns_services, parse_wireless_address, validate_pair_code};

    #[test]
    fn validates_wireless_addresses_and_pair_codes() {
        assert_eq!(
            parse_wireless_address("192.168.5.12:5555").unwrap(),
            ("192.168.5.12".into(), 5555)
        );
        assert_eq!(
            parse_wireless_address("[fe80::1]:5555").unwrap(),
            ("[fe80::1]".into(), 5555)
        );
        assert!(parse_wireless_address("192.168.5.12:0").is_err());
        assert!(parse_wireless_address("192.168.5.12:5555;whoami").is_err());
        assert!(parse_wireless_address("fe80::1:5555").is_err());
        assert!(validate_pair_code("123456").is_ok());
        assert!(validate_pair_code("12-34").is_err());
    }

    #[test]
    fn extracts_adb_mdns_services_only() {
        let output = "List of discovered services\n192.168.5.12:5555 _adb-tls-connect._tcp device-a\n192.168.5.13:37123 _adb-tls-pairing._tcp device-b\nnot-an-adb-service";
        assert_eq!(
            parse_mdns_services(output),
            vec!["192.168.5.12:5555", "192.168.5.13:37123"]
        );
    }
}
