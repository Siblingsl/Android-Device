export type DeviceActionId =
  | "home"
  | "back"
  | "recent"
  | "power"
  | "lock"
  | "wake"
  | "screen-off"
  | "rotate"
  | "volume-up"
  | "volume-down"
  | "mute"
  | "restart"
  | "recording"
  | "stream"
  | "notifications"
  | "settings"
  | "screenshot"
  | "install-apk"
  | "apps"
  | "network"
  | "scrcpy-config"
  | "files"
  | "terminal";

export interface DeviceAction {
  id: DeviceActionId;
  label: string;
  dangerous?: boolean;
  disabled: boolean;
  disabledReason?: string;
}

const ACTIONS: Array<Pick<DeviceAction, "id" | "label" | "dangerous">> = [
  { id: "home", label: "HOME" },
  { id: "back", label: "BACK" },
  { id: "recent", label: "最近任务" },
  { id: "power", label: "电源", dangerous: true },
  { id: "lock", label: "锁屏" },
  { id: "wake", label: "唤醒" },
  { id: "screen-off", label: "熄屏" },
  { id: "rotate", label: "旋转" },
  { id: "volume-up", label: "音量+" },
  { id: "volume-down", label: "音量-" },
  { id: "mute", label: "静音" },
  { id: "restart", label: "重启", dangerous: true },
  { id: "recording", label: "录制" },
  { id: "stream", label: "内嵌投屏" },
  { id: "notifications", label: "通知栏" },
  { id: "settings", label: "系统设置" },
  { id: "screenshot", label: "截图" },
  { id: "install-apk", label: "安装 APK" },
  { id: "apps", label: "应用" },
  { id: "network", label: "网络供网" },
  { id: "scrcpy-config", label: "Scrcpy 配置" },
  { id: "files", label: "文件" },
  { id: "terminal", label: "终端" },
];

export function getControlActions(online: boolean): DeviceAction[] {
  return ACTIONS.map((action) => ({
    ...action,
    disabled: !online,
    disabledReason: online ? undefined : "需在线",
  }));
}
