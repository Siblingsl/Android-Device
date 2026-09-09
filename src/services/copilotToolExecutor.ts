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
    case "device.info": {
      const devices = await DeviceService.listDevices();
      const device = devices.find((entry) => entry.serial === serial || entry.id === serial);
      if (!device) throw new Error(`未找到设备：${serial || "当前设备"}`);
      return JSON.stringify(device, null, 2);
    }
    case "device.screenshot": {
      const result = await DeviceService.screenshot(serial);
      if (!result.success) throw new Error(result.error || "截图失败");
      return `截图已保存：${result.path}`;
    }
    case "device.apps":
      return JSON.stringify(await DeviceService.listApps(serial, false), null, 2);
    case "device.files":
      return JSON.stringify(await DeviceService.listFiles(serial, String(call.args.path || "/")), null, 2);
    case "device.logs":
      return await DeviceService.logcat(serial, Number(call.args.lines || 200), call.args.clear === true);
    case "device.shell":
      return textResult(await DeviceService.shell(serial, String(call.args.command || "")), "Shell 执行成功");
    case "device.startApp":
      return textResult(await DeviceService.startApp(serial, String(call.args.packageName || "")), "启动应用成功");
    case "device.startAppOnDisplay":
      return textResult(await DeviceService.startAppOnDisplay(serial, String(call.args.packageName || ""), Number(call.args.displayId)), "启动应用到显示屏成功");
    case "device.stopApp":
      return textResult(await DeviceService.stopApp(serial, String(call.args.packageName || "")), "停止应用成功");
    case "device.installApk":
      return textResult(await DeviceService.installApk(serial, String(call.args.path || ""), true), "安装 APK 成功");
    case "device.input":
      if (typeof call.args.text === "string") return textResult(await DeviceService.text(serial, call.args.text), "输入文本成功");
      if (typeof call.args.keycode === "number") return textResult(await DeviceService.keyevent(serial, call.args.keycode), "按键成功");
      if ([call.args.x1, call.args.y1, call.args.x2, call.args.y2].every((value) => typeof value === "number")) {
        return textResult(await DeviceService.swipe(serial, call.args.x1 as number, call.args.y1 as number, call.args.x2 as number, call.args.y2 as number, Number(call.args.duration || 300)), "滑动成功");
      }
      return textResult(await DeviceService.tap(serial, Number(call.args.x || 0), Number(call.args.y || 0)), "点按成功");
    case "device.volumeUp":
      return textResult(await DeviceService.volumeUp(serial), "增加音量成功");
    case "device.volumeDown":
      return textResult(await DeviceService.volumeDown(serial), "减少音量成功");
    case "device.volumeMute":
      return textResult(await DeviceService.volumeMute(serial), "静音操作成功");
    case "device.rotate":
      return textResult(await DeviceService.setRotationMode(serial, String(call.args.mode || "auto") as "portrait" | "landscape" | "auto" | "lock"), "旋转模式已设置");
    case "device.screenOff":
      return textResult(await DeviceService.screenOff(serial), "屏幕已熄灭");
    case "device.reboot":
      return textResult(await DeviceService.rebootDevice(serial), "重启设备成功");
    default:
      throw new Error(`暂不支持工具：${call.toolId}`);
  }
}
