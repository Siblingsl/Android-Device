use std::path::Path;

const MAX_CONFIG_BYTES: u64 = 5 * 1024 * 1024;

fn validate_path(path: &str) -> Result<&Path, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("配置文件路径为空".into());
    }
    let p = Path::new(trimmed);
    if p.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        != Some(true)
    {
        return Err("配置文件必须使用 .json 扩展名".into());
    }
    if p.file_name().is_none() {
        return Err("配置文件路径无效".into());
    }
    Ok(p)
}

pub fn read(path: &str) -> Result<String, String> {
    let p = validate_path(path)?;
    let metadata = std::fs::metadata(p).map_err(|e| format!("读取配置文件失败: {e}"))?;
    if !metadata.is_file() {
        return Err("配置路径不是文件".into());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("配置文件超过 5 MB 限制".into());
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("读取配置文件失败: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("配置文件不是有效 JSON: {e}"))?;
    Ok(content)
}

pub fn write(path: &str, content: &str) -> Result<(), String> {
    let p = validate_path(path)?;
    if content.as_bytes().len() as u64 > MAX_CONFIG_BYTES {
        return Err("配置内容超过 5 MB 限制".into());
    }
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("配置内容不是有效 JSON: {e}"))?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    std::fs::write(p, content).map_err(|e| format!("写入配置文件失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::validate_path;

    #[test]
    fn only_json_files_are_accepted() {
        assert!(validate_path("settings.json").is_ok());
        assert!(validate_path("settings.txt").is_err());
        assert!(validate_path("").is_err());
    }
}
