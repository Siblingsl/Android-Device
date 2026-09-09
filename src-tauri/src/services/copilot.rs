use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotCompletionRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
}

fn endpoint_for(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("AI 接口地址必须使用 http:// 或 https://".into());
    }
    if base.len() <= "https://".len() {
        return Err("AI 接口地址不能为空".into());
    }
    Ok(format!("{base}/chat/completions"))
}

fn request_payload(request: &CopilotCompletionRequest) -> Value {
    json!({
        "model": request.model,
        "messages": request.messages,
        "max_tokens": request.max_tokens,
        "temperature": 0.2,
        "tools": request.tools,
        "tool_choice": "auto",
    })
}

pub async fn completion(request: CopilotCompletionRequest) -> Result<Value, String> {
    if request.api_key.trim().is_empty() {
        return Err("AI 服务未配置 API Key".into());
    }
    if request.model.trim().is_empty() {
        return Err("AI 服务未配置模型".into());
    }
    let endpoint = endpoint_for(&request.base_url)?;
    let timeout = Duration::from_millis(request.timeout_ms.clamp(1_000, 120_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "AI 网络客户端初始化失败".to_string())?;

    let response = client
        .post(endpoint)
        .bearer_auth(request.api_key.trim())
        .json(&request_payload(&request))
        .send()
        .await
        .map_err(|_| "AI 服务暂时不可用，请检查接口地址、模型和网络连接".to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("AI 服务请求失败（{}）", status.as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "AI 服务返回了无法解析的响应".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CopilotCompletionRequest {
        CopilotCompletionRequest {
            base_url: "https://example.test/v1/".into(),
            api_key: "secret-key".into(),
            model: "demo".into(),
            max_tokens: 256,
            timeout_ms: 5_000,
            messages: vec![json!({"role": "user", "content": "查看设备"})],
            tools: vec![json!({"type": "function"})],
        }
    }

    #[test]
    fn builds_a_provider_endpoint_without_logging_or_embedding_the_api_key() {
        let value = request_payload(&request());
        assert_eq!(
            endpoint_for("https://example.test/v1/").unwrap(),
            "https://example.test/v1/chat/completions"
        );
        assert!(!value.to_string().contains("secret-key"));
        assert_eq!(value["model"], "demo");
        assert_eq!(value["max_tokens"], 256);
    }

    #[test]
    fn rejects_invalid_provider_addresses() {
        assert!(endpoint_for("file:///secret").is_err());
        assert!(endpoint_for("https://").is_err());
    }
}
