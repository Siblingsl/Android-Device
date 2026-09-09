use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RELEASE_ENDPOINT: &str =
    "https://api.github.com/repos/Siblingsl/Android-Device/releases/latest";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub size: u64,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub html_url: String,
    pub published_at: String,
    pub assets: Vec<UpdateAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub update_available: bool,
    pub latest: Option<UpdateRelease>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadRequest {
    pub download_url: String,
    pub name: String,
}

fn parse_version(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(current: &str, latest: &str) -> bool {
    let mut current_parts = parse_version(current);
    let mut latest_parts = parse_version(latest);
    current_parts.resize(3, 0);
    latest_parts.resize(3, 0);
    latest_parts > current_parts
}

fn release_from_github(value: GitHubRelease) -> UpdateRelease {
    UpdateRelease {
        tag_name: value.tag_name,
        name: value.name.unwrap_or_default(),
        body: value.body.unwrap_or_default(),
        html_url: value.html_url,
        published_at: value.published_at.unwrap_or_default(),
        assets: value
            .assets
            .into_iter()
            .map(|asset| UpdateAsset {
                name: asset.name,
                size: asset.size,
                download_url: asset.browser_download_url,
            })
            .collect(),
    }
}

pub async fn check() -> Result<UpdateCheckResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "更新服务初始化失败".to_string())?;
    let response = client
        .get(RELEASE_ENDPOINT)
        .header("User-Agent", "Redroid-Device-Center")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub 更新服务".to_string())?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateCheckResult {
            current_version: env!("CARGO_PKG_VERSION").into(),
            update_available: false,
            latest: None,
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "更新服务请求失败（{}）",
            response.status().as_u16()
        ));
    }
    let release = release_from_github(
        response
            .json::<GitHubRelease>()
            .await
            .map_err(|_| "更新服务返回了无法解析的响应".to_string())?,
    );
    Ok(UpdateCheckResult {
        current_version: env!("CARGO_PKG_VERSION").into(),
        update_available: is_newer(env!("CARGO_PKG_VERSION"), &release.tag_name),
        latest: Some(release),
    })
}

fn safe_file_name(name: &str) -> String {
    let candidate = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("redroid-device-center-update.bin");
    let sanitized: String = candidate
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
        .collect();
    if sanitized.is_empty() {
        "redroid-device-center-update.bin".into()
    } else {
        sanitized
    }
}

fn next_available_path(directory: &Path, name: &str) -> PathBuf {
    let first = directory.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("update");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 1..10_000 {
        let candidate_name = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-download"))
}

pub async fn download(request: UpdateDownloadRequest) -> Result<String, String> {
    let url = reqwest::Url::parse(request.download_url.trim())
        .map_err(|_| "更新下载地址无效".to_string())?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "objects.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
            )
        )
    {
        return Err("更新下载地址不是受信任的 GitHub 地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "更新下载服务初始化失败".to_string())?;
    let response = client
        .get(url)
        .header("User-Agent", "Redroid-Device-Center")
        .send()
        .await
        .map_err(|_| "更新文件下载失败".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "更新文件下载失败（{}）",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
    {
        return Err("更新文件超过 512 MB，已拒绝下载".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "更新文件读取失败".to_string())?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("更新文件超过 512 MB，已拒绝保存".into());
    }
    let directory = dirs::download_dir().ok_or_else(|| "找不到系统下载目录".to_string())?;
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建系统下载目录".to_string())?;
    let path = next_available_path(&directory, &safe_file_name(&request.name));
    std::fs::write(&path, &bytes).map_err(|_| "更新文件保存失败".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_without_treating_a_same_version_as_an_update() {
        assert!(is_newer("0.1.0", "v0.2.0"));
        assert!(!is_newer("0.2.0", "v0.2.0"));
        assert!(!is_newer("0.3.0", "v0.2.0"));
    }

    #[test]
    fn sanitizes_download_names_and_avoids_existing_paths() {
        assert_eq!(safe_file_name("../release!.exe"), "release.exe");
        let directory = tempfile_directory();
        let first = next_available_path(&directory, "release.exe");
        std::fs::write(&first, b"old").unwrap();
        let second = next_available_path(&directory, "release.exe");
        assert_ne!(first, second);
        let _ = std::fs::remove_dir_all(directory);
    }

    fn tempfile_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("rdc-update-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}
