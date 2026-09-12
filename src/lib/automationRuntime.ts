import { DeviceService } from "../services/deviceService";
import { containsTemplate } from "./imageMatcher";
import { interpolate, validateAutomationScript, type AutomationScript, type AutomationStep } from "./automation";

export interface AutomationDeviceContext {
  serial: string;
  id: string;
  name: string;
}

export interface AutomationRunOptions {
  shouldPause?: () => boolean;
  shouldStop?: () => boolean;
  onStep?: (index: number, total: number, step: AutomationStep, path?: string) => void;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function executeAutomationScript(script: AutomationScript, device: AutomationDeviceContext, options: AutomationRunOptions = {}) {
  const errors = validateAutomationScript(script);
  if (errors.length) throw new Error(errors[0]);
  // Device identity is authoritative and cannot be shadowed by an imported
  // script variable with the same name.
  const variables = {
    ...(script.variables || {}),
    serial: device.serial,
    deviceId: device.id,
    deviceName: device.name,
  };
  let activeStepPath = "";
  let activeStepLabel = "";
  const waitForControl = async () => {
    while (options.shouldPause?.() && !options.shouldStop?.()) await sleep(100);
    if (options.shouldStop?.()) throw new Error("脚本已停止");
  };
  const waitForDelay = async (milliseconds: number) => {
    let remaining = Math.max(0, milliseconds);
    while (remaining > 0) {
      await waitForControl();
      const slice = Math.min(100, remaining);
      await sleep(slice);
      remaining -= slice;
    }
    await waitForControl();
  };
  const command = async (promise: Promise<{ success: boolean; stderr: string; stdout: string }>, label: string) => {
    const result = await promise;
    if (!result.success) throw new Error(result.stderr || result.stdout || `${label}失败`);
  };
  const point = (step: AutomationStep) => ({
    x: Math.max(0, step.x + (step.randomOffsetX ? Math.round((Math.random() * 2 - 1) * step.randomOffsetX) : 0)),
    y: Math.max(0, step.y + (step.randomOffsetY ? Math.round((Math.random() * 2 - 1) * step.randomOffsetY) : 0)),
  });
  const runStep = async (step: AutomationStep, path: string, index: number, total: number): Promise<void> => {
    await waitForControl();
    activeStepPath = path;
    activeStepLabel = step.label || step.kind;
    options.onStep?.(index, total, step, path);
    const text = interpolate(step.text, variables);
    switch (step.kind) {
      case "tap": { const start = point(step); await command(DeviceService.tap(device.serial, start.x, start.y), "点击"); break; }
      case "long-press": { const start = point(step); await command(DeviceService.longPress(device.serial, start.x, start.y, step.duration), "长按"); break; }
      case "swipe": { const start = point(step); const end = { x: Math.max(0, step.x2 + start.x - step.x), y: Math.max(0, step.y2 + start.y - step.y) }; await command(DeviceService.swipe(device.serial, start.x, start.y, end.x, end.y, step.duration), "滑动"); break; }
      case "scroll": { const start = point(step); await command(DeviceService.swipe(device.serial, start.x, start.y, start.x, Math.max(0, start.y - step.duration), 200), "滚轮"); break; }
      case "text": await command(DeviceService.text(device.serial, text), "输入文字"); break;
      case "keyevent": await command(DeviceService.keyevent(device.serial, step.keyCode), "KeyEvent"); break;
      case "wait": await waitForDelay(step.seconds * 1000); break;
      case "launch-app": await command(DeviceService.startApp(device.serial, interpolate(step.packageName, variables)), "启动应用"); break;
      case "install-apk": await command(DeviceService.installApk(device.serial, interpolate(step.apkPath, variables), true), "安装 APK"); break;
      case "screenshot": {
        const result = await DeviceService.screenshot(device.serial);
        if (!result.success) throw new Error(result.error || "截图失败");
        break;
      }
      case "image-match": {
        const result = await DeviceService.screenshot(device.serial);
        if (!result.success || !(await containsTemplate(result.base64, step.templateData, step.threshold, { x: step.cropX, y: step.cropY, width: step.cropWidth, height: step.cropHeight }))) throw new Error("图片匹配未通过");
        break;
      }
      case "recording-start": {
        const result = await DeviceService.recordingStart(device.serial, "video");
        if (result.status === "error") throw new Error(result.message || "开始录制失败");
        break;
      }
      case "recording-stop": await command(DeviceService.recordingStop(device.serial), "停止录制"); break;
      case "shell": await command(DeviceService.shell(device.serial, interpolate(step.command, variables)), "Shell"); break;
      case "condition": {
        const result = await DeviceService.shell(device.serial, interpolate(step.command, variables));
        if (!result.success) throw new Error(result.stderr || result.stdout || "条件 Shell 未通过");
        break;
      }
      case "repeat":
        for (let index = 0; index < step.count; index += 1) {
          for (const [childIndex, child] of step.children.entries()) {
            await runStep(child, `${path}.${childIndex + 1}`, childIndex, step.children.length);
          }
        }
        break;
    }
  };

  try {
    for (const [index, step] of script.steps.entries()) {
      await waitForControl();
      await runStep(step, String(index + 1), index, script.steps.length);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (activeStepPath && !reason.startsWith("第 ")) {
      throw new Error(`第 ${activeStepPath} 步（${activeStepLabel}）：${reason}`);
    }
    throw error;
  }
}
