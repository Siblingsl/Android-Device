use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

use crate::services::device;

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

fn tool_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn device_property() -> Value {
    json!({"type":"string","description":"目标设备 Serial"})
}

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name":"devices_list",
            "description":"列出当前 ADB 设备及其在线状态。",
            "inputSchema":tool_schema(json!({}), &[]),
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}
        }),
        json!({
            "name":"screenshot",
            "description":"截取设备当前画面并保存到配置的截图目录。",
            "inputSchema":tool_schema(json!({"serial":device_property()}), &["serial"]),
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}
        }),
        json!({
            "name":"files_list",
            "description":"列出指定设备目录中的文件。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"path":{"type":"string","description":"设备上的绝对路径"}}), &["serial","path"]),
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}
        }),
        json!({
            "name":"apps_list",
            "description":"列出指定设备已安装的应用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"includeSystem":{"type":"boolean","description":"是否包含系统应用，默认 false"}}), &["serial"]),
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}
        }),
        json!({
            "name":"file_push",
            "description":"把本机文件推送到设备。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"local":{"type":"string","description":"本机绝对路径"},"remote":{"type":"string","description":"设备上的绝对路径"}}), &["serial","local","remote"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
        json!({
            "name":"file_pull",
            "description":"从设备下载文件到本机。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"remote":{"type":"string","description":"设备上的绝对路径"},"local":{"type":"string","description":"本机绝对路径"}}), &["serial","remote","local"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
        json!({
            "name":"file_delete",
            "description":"删除设备上的文件。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"path":{"type":"string","description":"设备上的绝对路径"}}), &["serial","path"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
        json!({
            "name":"batch_control",
            "description":"对多个设备广播 Home、返回、最近任务、锁屏或唤醒。需要显式允许副作用。每台设备独立返回结果。",
            "inputSchema":tool_schema(json!({"serials":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"string"}},"action":{"type":"string","enum":["home","back","recent","lock","wake"]}}), &["serials","action"]),
            "annotations":{"destructiveHint":true,"idempotentHint":true}
        }),
        json!({
            "name":"device_control",
            "description":"执行 Home、返回、最近任务、锁屏或唤醒。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"action":{"type":"string","enum":["home","back","recent","lock","wake"]}}), &["serial","action"]),
            "annotations":{"destructiveHint":true,"idempotentHint":true}
        }),
        json!({
            "name":"install_apk",
            "description":"把本机 APK 安装到指定设备。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"path":{"type":"string","description":"本机 APK 绝对路径"}}), &["serial","path"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
        json!({
            "name":"start_app",
            "description":"按包名启动指定设备上的应用。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"package":{"type":"string","description":"Android 包名"}}), &["serial","package"]),
            "annotations":{"destructiveHint":true,"idempotentHint":true}
        }),
        json!({
            "name":"send_text",
            "description":"向设备当前焦点输入文字。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"text":{"type":"string"}}), &["serial","text"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
        json!({
            "name":"keyevent",
            "description":"向设备发送 Android KeyEvent。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"code":{"type":"integer","minimum":0,"maximum":300}}), &["serial","code"]),
            "annotations":{"destructiveHint":true,"idempotentHint":true}
        }),
        json!({
            "name":"shell",
            "description":"在设备上执行 Shell 命令。需要显式允许副作用。",
            "inputSchema":tool_schema(json!({"serial":device_property(),"command":{"type":"string"}}), &["serial","command"]),
            "annotations":{"destructiveHint":true,"idempotentHint":false}
        }),
    ]
}

fn rpc_response(request: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":request.get("id").cloned().unwrap_or(Value::Null),"result":result})
}

fn rpc_error(request: &Value, code: i32, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":request.get("id").cloned().unwrap_or(Value::Null),"error":{"code":code,"message":message.into()}})
}

fn tool_result(text: impl Into<String>, error: bool) -> Value {
    json!({"content":[{"type":"text","text":text.into()}],"isError":error})
}

fn args(request: &Value) -> &Value {
    request
        .get("params")
        .and_then(|params| params.get("arguments"))
        .unwrap_or(&Value::Null)
}

fn validate_schema(name: &str, arguments: &Value) -> Result<(), String> {
    if !arguments.is_null() && !arguments.is_object() {
        return Err("arguments 必须是对象".into());
    }
    let definition = tool_definitions()
        .into_iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| {
            format!(
                "不支持的 MCP 工具：{}",
                if name.is_empty() { "未指定" } else { name }
            )
        })?;
    let properties = definition
        .get("inputSchema")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("工具 {name} 的 schema 无效"))?;
    if let Some(object) = arguments.as_object() {
        let unknown: Vec<&str> = object
            .keys()
            .filter_map(|key| (!properties.contains_key(key)).then_some(key.as_str()))
            .collect();
        if !unknown.is_empty() {
            return Err(format!("工具 {name} 不支持参数：{}", unknown.join(", ")));
        }
        if name == "apps_list" {
            if let Some(value) = object.get("includeSystem") {
                if !value.is_boolean() {
                    return Err("includeSystem 必须是布尔值".into());
                }
            }
        }
    }
    Ok(())
}

fn string_arg(arguments: &Value, name: &str) -> Result<String, String> {
    let value = arguments
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() {
        return Err(format!("{name} 必须是非空字符串"));
    }
    Ok(value.to_string())
}

fn serial_arg(arguments: &Value) -> Result<String, String> {
    let serial = string_arg(arguments, "serial")?;
    if !serial
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | ':' | '-' | '_' | '[' | ']'))
    {
        return Err("设备 Serial 包含非法字符".into());
    }
    Ok(serial)
}

fn control_result(serial: &str, action: &str) -> Result<String, String> {
    let result = match action {
        "home" => device::home(serial),
        "back" => device::back(serial),
        "recent" => device::recent(serial),
        "lock" => device::lock(serial),
        "wake" => device::wake(serial),
        _ => return Err("不支持的设备控制动作".into()),
    };
    shell_text(result)
}

fn shell_text(result: crate::models::ShellResult) -> Result<String, String> {
    if result.success {
        Ok([result.stdout.trim(), result.stderr.trim()]
            .into_iter()
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    } else {
        Err([result.stderr.trim(), result.stdout.trim()]
            .into_iter()
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    }
}

fn call_tool(name: &str, arguments: &Value) -> Result<String, String> {
    if name == "devices_list" {
        return serde_json::to_string(&device::list_devices()).map_err(|error| error.to_string());
    }
    if name == "batch_control" {
        let action = string_arg(arguments, "action")?;
        if !matches!(
            action.as_str(),
            "home" | "back" | "recent" | "lock" | "wake"
        ) {
            return Err("不支持的设备控制动作".into());
        }
        let serials = arguments
            .get("serials")
            .and_then(Value::as_array)
            .ok_or_else(|| "serials 必须是数组".to_string())?;
        if serials.is_empty() || serials.len() > 64 {
            return Err("serials 数量必须在 1-64 之间".into());
        }
        let results: Vec<Value> = serials
            .iter()
            .map(|value| {
                let serial = value.as_str().unwrap_or("");
                match serial_arg(&json!({"serial":serial}))
                    .and_then(|serial| control_result(&serial, &action))
                {
                    Ok(output) => json!({"serial":serial,"success":true,"output":output}),
                    Err(error) => json!({"serial":serial,"success":false,"error":error}),
                }
            })
            .collect();
        return serde_json::to_string(&results).map_err(|error| error.to_string());
    }
    let serial = serial_arg(arguments)?;
    match name {
        "screenshot" => {
            let result = device::screenshot(&serial);
            if !result.success {
                return Err(if result.error.trim().is_empty() {
                    "截图失败".into()
                } else {
                    result.error
                });
            }
            serde_json::to_string(&result).map_err(|error| error.to_string())
        }
        "files_list" => serde_json::to_string(&device::list_files_result(
            &serial,
            &string_arg(arguments, "path")?,
        )?)
        .map_err(|error| error.to_string()),
        "apps_list" => {
            let include_system = arguments
                .get("includeSystem")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            serde_json::to_string(&device::list_apps_result(&serial, include_system)?)
                .map_err(|error| error.to_string())
        }
        "file_push" => shell_text(device::upload_file(
            &serial,
            &string_arg(arguments, "local")?,
            &string_arg(arguments, "remote")?,
        )),
        "file_pull" => shell_text(device::download_file(
            &serial,
            &string_arg(arguments, "remote")?,
            &string_arg(arguments, "local")?,
        )),
        "file_delete" => shell_text(device::delete_file(
            &serial,
            &string_arg(arguments, "path")?,
        )),
        "device_control" => control_result(&serial, &string_arg(arguments, "action")?),
        "install_apk" => shell_text(device::install_apk(
            &serial,
            &string_arg(arguments, "path")?,
            true,
        )),
        "start_app" => shell_text(device::start_app(
            &serial,
            &string_arg(arguments, "package")?,
        )),
        "send_text" => shell_text(device::text(&serial, &string_arg(arguments, "text")?)),
        "keyevent" => {
            let code = arguments
                .get("code")
                .and_then(Value::as_i64)
                .ok_or_else(|| "KeyEvent 必须是整数".to_string())?;
            if !(0..=300).contains(&code) {
                return Err("KeyEvent 必须是 0-300 的整数".into());
            }
            shell_text(device::keyevent(&serial, code as i32))
        }
        "shell" => shell_text(device::shell_command(
            &serial,
            &string_arg(arguments, "command")?,
        )),
        _ => Err(format!("不支持的 MCP 工具：{name}")),
    }
}

pub fn handle_request(request: Value, allow_side_effects: bool) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "notifications/initialized" {
        return None;
    }
    if method == "initialize" {
        return Some(rpc_response(
            &request,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities":{"tools":{"listChanged":false}},
                "serverInfo":{"name":"redroid-device-center-mcp","version":"0.1.0"}
            }),
        ));
    }
    if method == "tools/list" {
        return Some(rpc_response(&request, json!({"tools":tool_definitions()})));
    }
    if method != "tools/call" {
        return Some(rpc_error(
            &request,
            -32601,
            format!("不支持的 MCP 方法：{method}"),
        ));
    }

    let name = request
        .get("params")
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let arguments = args(&request);
    if let Err(error) = validate_schema(name, arguments) {
        return Some(rpc_response(&request, tool_result(error, true)));
    }
    if !matches!(
        name,
        "devices_list" | "screenshot" | "files_list" | "apps_list"
    ) && !allow_side_effects
    {
        return Some(rpc_response(
            &request,
            tool_result(
                "副作用工具被拒绝：启动 MCP 时需要显式加入 --allow-side-effects",
                true,
            ),
        ));
    }
    let result = call_tool(name, arguments);
    Some(rpc_response(
        &request,
        match result {
            Ok(text) => tool_result(text, false),
            Err(error) => tool_result(error, true),
        },
    ))
}

pub fn run_stdio(allow_side_effects: bool) -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(request, allow_side_effects),
            Err(error) => Some(
                json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32700,"message":error.to_string()}}),
            ),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut stdout, &response).map_err(io::Error::other)?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{handle_request, tool_definitions};
    use serde_json::json;

    #[test]
    fn exposes_initialize_and_tools_list() {
        let init = handle_request(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            false,
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(
            init["result"]["capabilities"]["tools"]["listChanged"],
            false
        );

        let tools = tool_definitions();
        assert!(tools.iter().any(|tool| tool["name"] == "devices_list"));
        assert!(tools.iter().any(|tool| tool["name"] == "shell"));
        assert!(tools.iter().any(|tool| tool["name"] == "files_list"));
        assert!(tools.iter().any(|tool| tool["name"] == "apps_list"));
        assert!(tools.iter().any(|tool| tool["name"] == "batch_control"));
    }

    #[test]
    fn rejects_side_effects_without_explicit_opt_in() {
        let result = handle_request(json!({
            "jsonrpc":"2.0", "id":2, "method":"tools/call",
            "params":{"name":"device_control","arguments":{"serial":"emulator-5554","action":"home"}}
        }), false).unwrap();
        assert_eq!(result["result"]["isError"], true);
        assert!(result["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("allow-side-effects"));
    }

    #[test]
    fn validates_serial_and_keyevent_before_running() {
        let bad_serial = handle_request(
            json!({
                "jsonrpc":"2.0", "id":3, "method":"tools/call",
                "params":{"name":"keyevent","arguments":{"serial":"bad;whoami","code":3}}
            }),
            true,
        )
        .unwrap();
        assert_eq!(bad_serial["result"]["isError"], true);

        let bad_code = handle_request(
            json!({
                "jsonrpc":"2.0", "id":4, "method":"tools/call",
                "params":{"name":"keyevent","arguments":{"serial":"emulator-5554","code":301}}
            }),
            true,
        )
        .unwrap();
        assert_eq!(bad_code["result"]["isError"], true);
    }

    #[test]
    fn batch_control_keeps_independent_item_results() {
        let result = handle_request(json!({
            "jsonrpc":"2.0", "id":5, "method":"tools/call",
            "params":{"name":"batch_control","arguments":{"serials":["bad;one","bad|two"],"action":"home"}}
        }), true).unwrap();
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_str(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["success"], false);
        assert_eq!(entries[1]["success"], false);
    }

    #[test]
    fn rejects_arguments_outside_tool_schema() {
        let result = handle_request(
            json!({
                "jsonrpc":"2.0", "id":6, "method":"tools/call",
                "params":{"name":"screenshot","arguments":{"unexpected":true}}
            }),
            true,
        )
        .unwrap();
        assert_eq!(result["result"]["isError"], true);
        assert!(result["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("unexpected"));

        let bad_bool = handle_request(
            json!({
                "jsonrpc":"2.0", "id":7, "method":"tools/call",
                "params":{"name":"apps_list","arguments":{"serial":"emulator-5554","includeSystem":"yes"}}
            }),
            true,
        )
        .unwrap();
        assert_eq!(bad_bool["result"]["isError"], true);
        assert!(bad_bool["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("includeSystem"));
    }
}
