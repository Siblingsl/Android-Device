use std::path::PathBuf;

#[cfg(windows)]
fn startup_file() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "无法定位 Windows 启动目录".to_string())?;
    Ok(base
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("Redroid Device Center.cmd"))
}

#[cfg(target_os = "macos")]
fn startup_file() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位 macOS 用户目录".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("com.redroid.device-center.plist"))
}

#[cfg(windows)]
pub fn apply(enabled: bool) -> Result<(), String> {
    let path = startup_file()?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| format!("无法定位应用程序: {e}"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建启动目录失败: {e}"))?;
        }
        let content = format!("@echo off\r\nstart \"\" \"{}\"\r\n", exe.display());
        std::fs::write(&path, content).map_err(|e| format!("写入开机启动项失败: {e}"))
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("移除开机启动项失败: {e}"))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn apply(enabled: bool) -> Result<(), String> {
    let path = startup_file()?;
    if !enabled {
        unload_launch_agent(&path)?;
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| format!("移除 macOS 开机启动项失败: {error}"))?;
        }
        return Ok(());
    }
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序: {error}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 LaunchAgents 目录失败: {error}"))?;
    }
    std::fs::write(&path, launch_agent_content(&executable))
        .map_err(|error| format!("写入 macOS 开机启动项失败: {error}"))?;
    unload_launch_agent(&path)?;
    load_launch_agent(&path)
}

#[cfg(target_os = "macos")]
fn launchctl_gui_domain() -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|error| format!("读取 macOS 用户 ID 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 macOS 用户 ID 失败（exit={:?})",
            output.status.code()
        ));
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() || !uid.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("macOS 用户 ID 无效".into());
    }
    Ok(format!("gui/{uid}"))
}

#[cfg(target_os = "macos")]
fn unload_launch_agent(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let domain = launchctl_gui_domain()?;
    let target = format!("{domain}/com.redroid.device-center");
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &target])
        .output()
        .map_err(|error| format!("注销 macOS 启动项失败: {error}"))?;
    // bootout is idempotent for this setting: a missing service is already in
    // the desired state and should not prevent the plist from being removed.
    let error = String::from_utf8_lossy(&output.stderr);
    if !output.status.success()
        && !error.contains("No such process")
        && !error.contains("Could not find service")
        && !error.contains("not found")
    {
        return Err(format!("注销 macOS 启动项失败: {}", error.trim()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn load_launch_agent(path: &std::path::Path) -> Result<(), String> {
    let domain = launchctl_gui_domain()?;
    let path_text = path.to_string_lossy().into_owned();
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &domain, &path_text])
        .output()
        .map_err(|error| format!("加载 macOS 启动项失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "加载 macOS 启动项失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn apply(enabled: bool) -> Result<(), String> {
    if enabled {
        Err("当前平台暂不支持开机启动".into())
    } else {
        Ok(())
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn launch_agent_content(executable: &std::path::Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.redroid.device-center</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Interactive</string></dict></plist>\n",
        xml_escape(&executable.to_string_lossy()),
    )
}

fn desktop_dir() -> Result<PathBuf, String> {
    dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|path| path.join("Desktop")))
        .ok_or_else(|| "无法定位桌面目录".to_string())
}

fn desktop_shortcut_paths() -> Result<Vec<PathBuf>, String> {
    let dir = desktop_dir()?;
    Ok(vec![
        dir.join("Redroid Device Center.url"),
        dir.join("Redroid Device Center.desktop"),
        dir.join("Redroid Device Center.command"),
    ])
}

fn remove_desktop_shortcuts() -> Result<(), String> {
    for path in desktop_shortcut_paths()? {
        let owned = std::fs::read_to_string(&path)
            .map(|content| content.contains("Redroid Device Center"))
            .unwrap_or(false);
        if owned {
            std::fs::remove_file(&path)
                .map_err(|error| format!("移除桌面快捷方式失败: {error}"))?;
        }
    }
    Ok(())
}

pub fn apply_desktop_shortcut(enabled: bool) -> Result<(), String> {
    if !enabled {
        return remove_desktop_shortcuts();
    }
    let dir = desktop_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建桌面目录失败: {error}"))?;
    remove_desktop_shortcuts()?;
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序: {error}"))?;
    let path = if cfg!(windows) {
        desktop_shortcut_paths()?.remove(0)
    } else if cfg!(target_os = "macos") {
        desktop_shortcut_paths()?.remove(2)
    } else {
        desktop_shortcut_paths()?.remove(1)
    };

    #[cfg(windows)]
    let content = {
        let url_path = executable
            .to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20");
        format!("[InternetShortcut]\r\nComment=Redroid Device Center\r\nURL=file:///{url_path}\r\nIconFile={}\r\nIconIndex=0\r\n", executable.display())
    };
    #[cfg(target_os = "macos")]
    let content = format!(
        "#!/bin/sh\n# Redroid Device Center\nexec '{}'\n",
        executable.to_string_lossy().replace('\'', "'\\''")
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    let content = format!(
        "[Desktop Entry]\nType=Application\nName=Redroid Device Center\nExec=\\\"{}\\\"\nTerminal=false\nCategories=Development;Utility;\n",
        executable.to_string_lossy().replace('"', "\\\"")
    );

    std::fs::write(&path, content).map_err(|error| format!("写入桌面快捷方式失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path)
            .map_err(|error| format!("读取快捷方式权限失败: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions)
            .map_err(|error| format!("设置快捷方式权限失败: {error}"))?;
    }
    Ok(())
}

pub fn create_app_shortcut(serial: &str, package: &str) -> Result<String, String> {
    if serial.trim().is_empty() || serial.chars().any(|ch| ch.is_control()) {
        return Err("设备 Serial 不能为空或包含控制字符".into());
    }
    if package.trim().is_empty()
        || package.split('.').any(|part| part.is_empty())
        || !package
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '$'))
    {
        return Err("应用包名格式无效".into());
    }
    let dir = desktop_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建桌面目录失败: {error}"))?;
    let suffix: String = serial
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let package = package.trim();
    let adb = crate::services::settings::adb_path();
    let adb = if adb.trim().is_empty() {
        "adb".to_string()
    } else {
        adb
    };

    #[cfg(target_os = "macos")]
    let adb = crate::services::util::resolve_program(&adb);

    #[cfg(windows)]
    let (path, content) = {
        let path = dir.join(format!("Redroid - {package} - {suffix}.cmd"));
        let content = format!(
            "@echo off\r\nrem Redroid Device Center\r\n\"{}\" -s \"{}\" shell monkey -p \"{}\" 1\r\n",
            adb.replace('"', ""),
            serial.trim().replace('"', ""),
            package
        );
        (path, content)
    };

    #[cfg(target_os = "macos")]
    let (path, content) = {
        let path = dir.join(format!("Redroid - {package} - {suffix}.command"));
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
        let content = format!(
            "#!/bin/sh\n# Redroid Device Center\nexport PATH=\"/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/.local/bin:$PATH\"\nexec {} -s {} shell monkey -p {} 1\n",
            quote(&adb),
            quote(serial.trim()),
            quote(package)
        );
        (path, content)
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let (path, content) = {
        let path = dir.join(format!("Redroid - {package} - {suffix}.desktop"));
        let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=Redroid {package}\nExec=\"{}\" -s \"{}\" shell monkey -p \"{}\" 1\nTerminal=true\nCategories=Development;Utility;\n",
            escape(&adb), escape(serial.trim()), escape(package)
        );
        (path, content)
    };

    std::fs::write(&path, content).map_err(|error| format!("写入应用快捷方式失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path)
            .map_err(|error| format!("读取快捷方式权限失败: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions)
            .map_err(|error| format!("设置快捷方式权限失败: {error}"))?;
    }
    Ok(path.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::launch_agent_content;
    use std::path::Path;

    #[test]
    fn escapes_macos_launch_agent_paths() {
        let content = launch_agent_content(Path::new("C:/Users/A&B/app\".app"));
        assert!(content.contains("A&amp;B/app&quot;.app"));
        assert!(content.contains("com.redroid.device-center"));
    }
}
