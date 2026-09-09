import { DeviceService } from "./deviceService";
import type { AutomationRuntime } from "../lib/automationRunner";
import type { ScrcpyRecordingOptions, ShellResult } from "../types";

function assertSuccess(result: ShellResult, fallback: string): void {
  if (!result.success) throw new Error(result.stderr || result.stdout || fallback);
}

export function createDeviceAutomationRuntime(): AutomationRuntime {
  return {
    tap: async (serial, x, y) => assertSuccess(await DeviceService.tap(serial, x, y), "点按失败"),
    swipe: async (serial, x1, y1, x2, y2, duration) => assertSuccess(await DeviceService.swipe(serial, x1, y1, x2, y2, duration), "滑动失败"),
    longPress: async (serial, x, y, duration) => assertSuccess(await DeviceService.longPress(serial, x, y, duration), "长按失败"),
    text: async (serial, value) => assertSuccess(await DeviceService.text(serial, value), "输入文本失败"),
    keyevent: async (serial, code) => assertSuccess(await DeviceService.keyevent(serial, code), "按键失败"),
    shell: async (serial, command) => assertSuccess(await DeviceService.shell(serial, command), "Shell 执行失败"),
    screenshot: async (serial) => {
      const result = await DeviceService.screenshot(serial);
      if (!result.success) throw new Error(result.error || "截图失败");
    },
    launch: async (serial, packageName) => assertSuccess(await DeviceService.startApp(serial, packageName), "启动应用失败"),
    install: async (serial, path) => assertSuccess(await DeviceService.installApk(serial, path, true), "安装 APK 失败"),
    record: async (serial, outputPath, durationSeconds) => {
      const options: ScrcpyRecordingOptions = {
        outputPath,
        format: "mp4",
        audio: false,
        audioOnly: false,
        audioSource: "output",
        videoSource: "display",
        timeLimitSecs: durationSeconds,
        cameraId: "0",
        cameraSize: "1280x720",
        cameraAr: "16:9",
        cameraFps: 30,
        cameraFacing: "back",
        cameraTorch: false,
        cameraZoom: 1,
      };
      assertSuccess(await DeviceService.scrcpyStartRecording(serial, options), "开始录制失败");
      if (durationSeconds > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, durationSeconds * 1000));
        assertSuccess(await DeviceService.scrcpyStopRecording(serial), "停止录制失败");
      }
    },
  };
}
