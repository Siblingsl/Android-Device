/**
 * Small MCP-compatible protocol layer for device control.
 *
 * The renderer owns the transport today, while this module keeps the wire
 * contract independent from the AI provider. That makes tool discovery,
 * argument validation and confirmation policy testable before a remote MCP
 * transport is enabled.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpId = string | number;

export interface McpRequest {
  jsonrpc: "2.0";
  id?: McpId;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id?: McpId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

export interface McpDeviceContext {
  name: string;
  serial: string;
}

export interface McpDispatcherOptions {
  device: McpDeviceContext;
  allowedSerials?: readonly string[];
  execute?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  confirm?: (tool: McpTool, args: Record<string, unknown>) => Promise<boolean>;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const DEVICE_ACTIONS = ["home", "back", "recent", "lock", "wake"] as const;
const NETWORK_ACTIONS = ["start", "stop", "restart"] as const;
const RECORDING_ACTIONS = ["start", "stop"] as const;

function textResult(text: string, isError = false): ToolCallResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
  annotations: McpTool["annotations"] = {},
): McpTool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations,
  };
}

export function getDeviceMcpTools(device: McpDeviceContext): McpTool[] {
  return [
    tool(
      "screenshot",
      `截取设备 ${device.name}（${device.serial}）当前画面。`,
      {},
      [],
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    ),
    tool(
      "device_control",
      "执行 Home、返回、最近任务、锁屏或唤醒。",
      { action: { type: "string", enum: [...DEVICE_ACTIONS] } },
      ["action"],
      { destructiveHint: true, idempotentHint: true },
    ),
    tool(
      "install_apk",
      "把本机 APK 安装到当前设备。",
      { path: { type: "string", description: "本机 APK 的绝对路径" } },
      ["path"],
      { destructiveHint: true, idempotentHint: false },
    ),
    tool(
      "start_app",
      "按包名启动设备上的应用。",
      { package: { type: "string", description: "Android 包名" } },
      ["package"],
      { destructiveHint: true, idempotentHint: true },
    ),
    tool(
      "send_text",
      "向设备当前焦点输入文字。",
      { text: { type: "string" } },
      ["text"],
      { destructiveHint: true, idempotentHint: false },
    ),
    tool(
      "keyevent",
      "向设备发送 Android KeyEvent。",
      { code: { type: "integer", minimum: 0, maximum: 300 } },
      ["code"],
      { destructiveHint: true, idempotentHint: true },
    ),
    tool(
      "shell",
      "在设备上执行 Shell 命令；必须由用户确认。",
      { command: { type: "string" } },
      ["command"],
      { destructiveHint: true, idempotentHint: false },
    ),
    tool(
      "open_files",
      "打开当前设备的文件管理工作区。",
      {},
      [],
      { destructiveHint: false, idempotentHint: true },
    ),
    tool(
      "open_apps",
      "打开当前设备的应用管理工作区。",
      {},
      [],
      { destructiveHint: false, idempotentHint: true },
    ),
    tool(
      "apps_list",
      "列出当前设备已安装的应用。",
      { includeSystem: { type: "boolean", description: "是否包含系统应用，默认 false" } },
      [],
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    ),
    tool(
      "files_list",
      "列出当前设备目录中的文件。",
      { path: { type: "string", description: "设备上的绝对路径" } },
      ["path"],
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    ),
    tool(
      "file_delete",
      "删除当前设备上的文件或目录；必须由用户确认。",
      { path: { type: "string", description: "设备上的绝对路径" } },
      ["path"],
      { destructiveHint: true, idempotentHint: false },
    ),
    tool(
      "batch_control",
      "对指定 Serial 列表广播 Home、返回、最近任务、锁屏或唤醒；每台设备独立返回结果。",
      {
        serials: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
        action: { type: "string", enum: [...DEVICE_ACTIONS] },
      },
      ["serials", "action"],
      { destructiveHint: true, idempotentHint: true },
    ),
    tool(
      "network",
      "启动、停止或重启当前设备的 Gnirehtet 网络供网。",
      { action: { type: "string", enum: [...NETWORK_ACTIONS] } },
      ["action"],
      { destructiveHint: true, idempotentHint: false },
    ),
    tool(
      "recording",
      "开始或停止当前设备的录制任务。",
      { action: { type: "string", enum: [...RECORDING_ACTIONS] } },
      ["action"],
      { destructiveHint: true, idempotentHint: false },
    ),
  ];
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必须是非空字符串`);
  return value.trim();
}

export function validateMcpToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  tools: McpTool[],
): McpTool {
  const definition = tools.find((item) => item.name === toolName);
  if (!definition) throw new Error(`不支持的 MCP 工具：${toolName || "未指定"}`);
  if (definition.inputSchema.additionalProperties === false) {
    const known = new Set(Object.keys(definition.inputSchema.properties));
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length) throw new Error(`工具 ${toolName} 不支持参数：${unknown.join(", ")}`);
  }
  for (const key of definition.inputSchema.required || []) requiredString(args, key);

  if (toolName === "device_control") {
    const action = requiredString(args, "action");
    if (!(DEVICE_ACTIONS as readonly string[]).includes(action)) throw new Error("不支持的设备控制动作");
  }
  if (toolName === "network") {
    const action = requiredString(args, "action");
    if (!(NETWORK_ACTIONS as readonly string[]).includes(action)) throw new Error("不支持的供网动作");
  }
  if (toolName === "recording") {
    const action = requiredString(args, "action");
    if (!(RECORDING_ACTIONS as readonly string[]).includes(action)) throw new Error("不支持的录制动作");
  }
  if (toolName === "keyevent") {
    const code = args.code;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 300) {
      throw new Error("KeyEvent 必须是 0-300 的整数");
    }
  }
  if (toolName === "apps_list" && args.includeSystem !== undefined && typeof args.includeSystem !== "boolean") {
    throw new Error("includeSystem 必须是布尔值");
  }
  if (toolName === "files_list" || toolName === "file_delete") requiredString(args, "path");
  if (toolName === "batch_control") {
    const serials = args.serials;
    if (!Array.isArray(serials) || serials.length < 1 || serials.length > 64 || serials.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("serials 必须是 1-64 个非空 Serial 的数组");
    }
    const action = requiredString(args, "action");
    if (!(DEVICE_ACTIONS as readonly string[]).includes(action)) throw new Error("不支持的设备控制动作");
  }
  return definition;
}

function response(request: McpRequest, result: unknown): McpResponse {
  return { jsonrpc: "2.0", ...(request.id === undefined ? {} : { id: request.id }), result };
}

function protocolError(request: McpRequest, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", ...(request.id === undefined ? {} : { id: request.id }), error: { code, message } };
}

export async function dispatchMcpRequest(
  request: McpRequest,
  options: McpDispatcherOptions,
): Promise<McpResponse | null> {
  const tools = getDeviceMcpTools(options.device);
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return response(request, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "redroid-device-center", version: "0.1.0" },
    });
  }
  if (request.method === "tools/list") return response(request, { tools });
  if (request.method !== "tools/call") return protocolError(request, -32601, `不支持的 MCP 方法：${request.method}`);

  const params = asObject(request.params);
  const name = typeof params.name === "string" ? params.name : "";
  if (params.arguments !== undefined && !isObject(params.arguments)) {
    return response(request, textResult("arguments 必须是对象", true));
  }
  const args = asObject(params.arguments);
  try {
    const definition = validateMcpToolArguments(name, args, tools);
    if (name === "batch_control" && options.allowedSerials) {
      const allowed = new Set(options.allowedSerials);
      const serials = Array.isArray(args.serials) ? args.serials : [];
      if (serials.some((serial) => typeof serial !== "string" || !allowed.has(serial))) {
        throw new Error("批量控制目标不在当前 MCP 会话允许的设备范围内");
      }
    }
    if (definition.annotations?.destructiveHint) {
      const confirmed = options.confirm ? await options.confirm(definition, args) : false;
      if (!confirmed) return response(request, textResult("操作已被拒绝或未获得确认", true));
    }
    if (!options.execute) return response(request, textResult("当前 MCP 会话没有配置执行器", true));
    const output = await options.execute(name, args);
    return response(request, textResult(typeof output === "string" ? output : JSON.stringify(output)));
  } catch (error) {
    return response(request, textResult(error instanceof Error ? error.message : String(error), true));
  }
}
