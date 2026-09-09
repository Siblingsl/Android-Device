export type CopilotToolRisk = "read" | "write" | "dangerous";

export interface CopilotToolDefinition {
  id: string;
  label: string;
  description: string;
  risk: CopilotToolRisk;
  requiresConfirmation: boolean;
  parameters: CopilotToolSchema;
}

export interface CopilotToolSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean"; description?: string }>;
  required?: string[];
  additionalProperties: false;
}

export interface CopilotToolCall {
  id?: string;
  toolId: string;
  args: Record<string, unknown>;
}

export interface CopilotToolPolicy {
  allowedToolIds: string[];
  confirmed: boolean;
}

export type CopilotAuthorization =
  | { status: "allowed"; tool: CopilotToolDefinition }
  | { status: "confirmation_required"; tool: CopilotToolDefinition; reason: string }
  | { status: "blocked"; reason: string };

const schema = (properties: CopilotToolSchema["properties"], required: string[] = []): CopilotToolSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const serial = { type: "string" as const, description: "目标设备 Serial，可省略并使用当前设备" };
const noArgs = schema({ serial });
const tool = (id: string, label: string, description: string, risk: CopilotToolRisk, requiresConfirmation: boolean, parameters: CopilotToolSchema = noArgs): CopilotToolDefinition => ({
  id, label, description, risk, requiresConfirmation, parameters,
});

export const COPILOT_TOOLS: CopilotToolDefinition[] = [
  tool("devices.list", "读取设备列表", "查看在线状态和设备基本信息", "read", false, schema({})),
  tool("device.info", "读取设备详情", "查看指定设备的系统、资源和连接状态", "read", false),
  tool("device.screenshot", "获取设备截图", "读取当前设备画面，用于诊断或图像分析", "read", false),
  tool("device.apps", "读取应用列表", "查看已安装应用和版本", "read", false),
  tool("device.files", "读取文件列表", "查看设备指定目录下的文件", "read", false, schema({ serial, path: { type: "string", description: "设备目录，默认 /" } }, ["path"])),
  tool("device.logs", "读取设备日志", "获取 logcat 或系统运行日志", "read", false, schema({ serial, lines: { type: "number", description: "日志行数" }, clear: { type: "boolean", description: "读取后清空" } })),
  tool("device.shell", "执行设备 Shell", "在选定设备上运行一条 Shell 命令", "dangerous", true, schema({ serial, command: { type: "string", description: "要执行的命令" } }, ["command"])),
  tool("device.installApk", "安装 APK", "把 APK 安装到选定设备", "write", true, schema({ serial, path: { type: "string", description: "本地 APK 路径" } }, ["path"])),
  tool("device.startApp", "启动应用", "启动指定包名的应用", "write", true, schema({ serial, packageName: { type: "string", description: "应用包名" } }, ["packageName"])),
  tool("device.startAppOnDisplay", "启动应用到显示屏", "在指定显示屏启动应用", "write", true, schema({ serial, packageName: { type: "string", description: "应用包名" }, displayId: { type: "number", description: "Android 显示屏编号，0 到 100" } }, ["packageName", "displayId"])),
  tool("device.stopApp", "停止应用", "停止指定包名的应用", "write", true, schema({ serial, packageName: { type: "string", description: "应用包名" } }, ["packageName"])),
  tool("device.input", "发送输入操作", "发送点按、滑动、文字或按键", "write", true, schema({
    serial, text: { type: "string" }, keycode: { type: "number" }, x: { type: "number" }, y: { type: "number" },
    x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, duration: { type: "number" },
  })),
  tool("device.volumeUp", "增加音量", "提高设备媒体音量", "write", true),
  tool("device.volumeDown", "减少音量", "降低设备媒体音量", "write", true),
  tool("device.volumeMute", "静音设备", "切换设备静音状态", "write", true),
  tool("device.rotate", "设置旋转模式", "设置设备竖屏、横屏、自动或锁定旋转", "write", true, schema({ serial, mode: { type: "string", description: "portrait、landscape、auto 或 lock" } }, ["mode"])),
  tool("device.screenOff", "熄灭屏幕", "关闭设备屏幕但不停止设备", "write", true),
  tool("device.reboot", "重启设备", "重启选定设备", "dangerous", true),
];

const DANGEROUS_COMMANDS = [
  /\brm\s+(-[a-z]+\s+)*-r[a-z]*f\b/i,
  /\b(format|mkfs|wipe|dd)\b/i,
  /\/dev\/block|\/system\b.*\bmount\b/i,
];

function toolFor(id: string): CopilotToolDefinition | undefined {
  return COPILOT_TOOLS.find((tool) => tool.id === id);
}

function isValidArgumentType(value: unknown, type: CopilotToolSchema["properties"][string]["type"]): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function validateArguments(tool: CopilotToolDefinition, args: Record<string, unknown>): string | null {
  for (const required of tool.parameters.required ?? []) {
    const value = args[required];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return `工具参数缺失：${required}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const definition = tool.parameters.properties[key];
    if (!definition) return `工具参数不允许：${key}`;
    if (!isValidArgumentType(value, definition.type)) return `工具参数类型错误：${key}`;
  }
  return null;
}

export function authorizeCopilotToolCall(call: CopilotToolCall, policy: CopilotToolPolicy): CopilotAuthorization {
  const tool = toolFor(call.toolId);
  if (!tool) return { status: "blocked", reason: `未知工具：${call.toolId}` };
  if (!policy.allowedToolIds.includes(tool.id)) return { status: "blocked", reason: `工具未加入白名单：${tool.label}` };
  const argumentError = validateArguments(tool, call.args);
  if (argumentError) return { status: "blocked", reason: argumentError };
  if (tool.id === "device.startAppOnDisplay") {
    const displayId = call.args.displayId;
    if (typeof displayId !== "number" || !Number.isInteger(displayId) || displayId < 0 || displayId > 100) {
      return { status: "blocked", reason: "显示屏编号必须是 0 到 100 的整数" };
    }
  }
  const command = typeof call.args.command === "string" ? call.args.command : "";
  if (tool.id === "device.shell" && DANGEROUS_COMMANDS.some((pattern) => pattern.test(command))) {
    return { status: "blocked", reason: "危险 Shell 命令已被拦截" };
  }
  if (tool.requiresConfirmation && !policy.confirmed) {
    return { status: "confirmation_required", tool, reason: `${tool.label}会改变设备状态，需要确认后执行` };
  }
  return { status: "allowed", tool };
}
