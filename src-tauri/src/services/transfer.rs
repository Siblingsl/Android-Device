use crate::models::ShellResult;
use crate::services::adb;

pub fn shell_quote(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(|c| c.is_control()) {
        return Err("路径不能为空或包含控制字符".into());
    }
    if value.contains([';', '|', '&', '`']) {
        return Err("路径包含不允许的 shell 字符".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

fn content_quote(value: &str) -> Result<String, String> {
    if value.contains('\0')
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("文件内容包含不支持的控制字符".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

fn remote_path(path: &str) -> Result<String, String> {
    if !path.trim_start().starts_with('/') {
        return Err("远端路径必须是绝对路径".into());
    }
    shell_quote(path)
}

pub fn build_move_command(source: &str, target: &str) -> Result<String, String> {
    Ok(format!(
        "mv -f {} {}",
        remote_path(source)?,
        remote_path(target)?
    ))
}

pub fn build_copy_command(source: &str, target: &str) -> Result<String, String> {
    Ok(format!(
        "cp -R {} {}",
        remote_path(source)?,
        remote_path(target)?
    ))
}

pub fn build_delete_command(path: &str) -> Result<String, String> {
    let normalized = path.trim_end_matches('/');
    let mut depth = 0_i32;
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => depth = (depth - 1).max(0),
            _ => depth += 1,
        }
    }
    if depth == 0 {
        return Err("为避免误删系统，不能删除设备根目录".into());
    }
    Ok(format!("rm -rf -- {}", remote_path(path)?))
}

pub fn build_list_command(path: &str) -> Result<String, String> {
    Ok(format!("ls -la -- {}", remote_path(path)?))
}

pub fn build_mkdir_command(path: &str) -> Result<String, String> {
    Ok(format!("mkdir -p -- {}", remote_path(path)?))
}

pub fn build_read_command(path: &str) -> Result<String, String> {
    Ok(format!("cat {}", remote_path(path)?))
}

pub fn build_write_command(path: &str, content: &str) -> Result<String, String> {
    if content.len() > 1_048_576 {
        return Err("单个文本文件不能超过 1 MB".into());
    }
    Ok(format!(
        "printf '%s' {} > {}",
        content_quote(content)?,
        remote_path(path)?
    ))
}

pub fn move_path(serial: &str, source: &str, target: &str) -> ShellResult {
    match build_move_command(source, target) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn copy_path(serial: &str, source: &str, target: &str) -> ShellResult {
    match build_copy_command(source, target) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn delete_path(serial: &str, path: &str) -> ShellResult {
    match build_delete_command(path) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn list_path(serial: &str, path: &str) -> ShellResult {
    match build_list_command(path) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn make_directory(serial: &str, path: &str) -> ShellResult {
    match build_mkdir_command(path) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn read_path(serial: &str, path: &str) -> ShellResult {
    match build_read_command(path) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

pub fn write_path(serial: &str, path: &str, content: &str) -> ShellResult {
    match build_write_command(path, content) {
        Ok(command) => adb::shell(serial, &command),
        Err(error) => ShellResult {
            success: false,
            stderr: error,
            exit_code: -1,
            ..ShellResult::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_copy_command, build_delete_command, build_list_command, build_mkdir_command,
        build_move_command, build_write_command, shell_quote,
    };

    #[test]
    fn quotes_remote_paths_without_allowing_command_injection() {
        let command =
            build_move_command("/sdcard/a file.txt", "/sdcard/b.txt").expect("valid remote path");
        assert_eq!(command, "mv -f '/sdcard/a file.txt' '/sdcard/b.txt'");
        assert!(shell_quote("/sdcard/x; rm -rf /").is_err());
    }

    #[test]
    fn rejects_control_characters_and_non_absolute_paths() {
        assert!(build_copy_command("relative.txt", "/sdcard/out.txt").is_err());
        assert!(build_copy_command("/sdcard/a\nrm", "/sdcard/out.txt").is_err());
    }

    #[test]
    fn quotes_list_and_mkdir_paths() {
        assert_eq!(
            build_list_command("/sdcard/a folder").expect("valid path"),
            "ls -la -- '/sdcard/a folder'"
        );
        assert_eq!(
            build_mkdir_command("/sdcard/new folder").expect("valid path"),
            "mkdir -p -- '/sdcard/new folder'"
        );
    }

    #[test]
    fn refuses_to_delete_the_remote_root() {
        assert!(build_delete_command("/").is_err());
        assert!(build_delete_command("/sdcard/../").is_err());
        assert!(build_delete_command("/sdcard/tmp").is_ok());
    }

    #[test]
    fn preserves_multiline_editor_content_without_shell_expansion() {
        let command = build_write_command("/sdcard/note.txt", "line one\nline two $HOME 'quoted'")
            .expect("valid text");
        assert!(command.contains("line one\nline two $HOME"));
        assert!(command.contains("\\''quoted"));
        assert!(command.ends_with("'/sdcard/note.txt'"));
    }
}
