export type CopilotToolRisk = "read" | "write" | "dangerous";

export interface CopilotToolDefinition {
  id: string;
  label: string;
  description: string;
  risk: CopilotToolRisk;
  requiresConfirmation: boolean;
}

export interface CopilotToolCall {
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

export const COPILOT_TOOLS: CopilotToolDefinition[] = [
  { id: "devices.list", label: "读取设备列表", description: "查看在线状态和设备基本信息", risk: "read", requiresConfirmation: false },
  { id: "device.screenshot", label: "获取设备截图", description: "读取当前设备画面，用于诊断或图像分析", risk: "read", requiresConfirmation: false },
  { id: "device.apps", label: "读取应用列表", description: "查看已安装应用和版本", risk: "read", requiresConfirmation: false },
  { id: "device.logs", label: "读取设备日志", description: "获取 logcat 或系统运行日志", risk: "read", requiresConfirmation: false },
  { id: "device.shell", label: "执行设备 Shell", description: "在选定设备上运行一条 Shell 命令", risk: "dangerous", requiresConfirmation: true },
  { id: "device.installApk", label: "安装 APK", description: "把 APK 安装到选定设备", risk: "write", requiresConfirmation: true },
  { id: "device.startApp", label: "启动应用", description: "启动指定包名的应用", risk: "write", requiresConfirmation: true },
  { id: "device.input", label: "发送输入操作", description: "发送点按、滑动、文字或按键", risk: "write", requiresConfirmation: true },
  { id: "device.reboot", label: "重启设备", description: "重启选定设备", risk: "dangerous", requiresConfirmation: true },
];

const DANGEROUS_COMMANDS = [
  /\brm\s+(-[a-z]+\s+)*-r[a-z]*f\b/i,
  /\b(format|mkfs|wipe|dd)\b/i,
  /\/dev\/block|\/system\b.*\bmount\b/i,
];

function toolFor(id: string): CopilotToolDefinition | undefined {
  return COPILOT_TOOLS.find((tool) => tool.id === id);
}

export function authorizeCopilotToolCall(call: CopilotToolCall, policy: CopilotToolPolicy): CopilotAuthorization {
  const tool = toolFor(call.toolId);
  if (!tool) return { status: "blocked", reason: `未知工具：${call.toolId}` };
  if (!policy.allowedToolIds.includes(tool.id)) return { status: "blocked", reason: `工具未加入白名单：${tool.label}` };
  const command = typeof call.args.command === "string" ? call.args.command : "";
  if (tool.id === "device.shell" && DANGEROUS_COMMANDS.some((pattern) => pattern.test(command))) {
    return { status: "blocked", reason: "危险 Shell 命令已被拦截" };
  }
  if (tool.requiresConfirmation && !policy.confirmed) {
    return { status: "confirmation_required", tool, reason: `${tool.label}会改变设备状态，需要确认后执行` };
  }
  return { status: "allowed", tool };
}
