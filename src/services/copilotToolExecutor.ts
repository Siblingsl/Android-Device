import { DeviceService } from "./deviceService";
import type { CopilotToolCall } from "../lib/copilotTools";

function textResult(result: { success: boolean; stdout?: string; stderr?: string }, successText: string): string {
  if (!result.success) throw new Error(result.stderr || result.stdout || "设备操作失败");
  return result.stdout || successText;
}

export async function executeCopilotToolCall(call: CopilotToolCall, defaultSerial: string): Promise<string> {
  const serial = typeof call.args.serial === "string" ? call.args.serial : defaultSerial;
  switch (call.toolId) {
    case "devices.list":
      return JSON.stringify(await DeviceService.listDevices(), null, 2);
    case "device.screenshot": {
      const result = await DeviceService.screenshot(serial);
      if (!result.success) throw new Error(result.error || "截图失败");
      return `截图已保存：${result.path}`;
    }
    case "device.apps":
      return JSON.stringify(await DeviceService.listApps(serial, false), null, 2);
    case "device.logs":
      return await DeviceService.logcat(serial, 200, false);
    case "device.shell":
      return textResult(await DeviceService.shell(serial, String(call.args.command || "")), "Shell 执行成功");
    case "device.startApp":
      return textResult(await DeviceService.startApp(serial, String(call.args.packageName || "")), "启动应用成功");
    case "device.installApk":
      return textResult(await DeviceService.installApk(serial, String(call.args.path || ""), true), "安装 APK 成功");
    case "device.input":
      if (typeof call.args.text === "string") return textResult(await DeviceService.text(serial, call.args.text), "输入文本成功");
      if (typeof call.args.keycode === "number") return textResult(await DeviceService.keyevent(serial, call.args.keycode), "按键成功");
      return textResult(await DeviceService.tap(serial, Number(call.args.x || 0), Number(call.args.y || 0)), "点按成功");
    case "device.reboot":
      return textResult(await DeviceService.rebootDevice(serial), "重启设备成功");
    default:
      throw new Error(`暂不支持工具：${call.toolId}`);
  }
}
