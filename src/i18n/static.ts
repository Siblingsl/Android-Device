import { commonZh, commonEn } from "./pages/common";
import { dashboardZh, dashboardEn } from "./pages/dashboard";
import { devicesZh, devicesEn } from "./pages/devices";
import { volumesZh, volumesEn } from "./pages/volumes";
import { adbZh, adbEn } from "./pages/adb";
import { apkZh, apkEn } from "./pages/apk";
import { logsZh, logsEn } from "./pages/logs";
import { settingsZh, settingsEn } from "./pages/settings";
import { dockerZh, dockerEn } from "./pages/docker";
import { deviceDetailZh, deviceDetailEn } from "./pages/deviceDetail";
import { monitorZh, monitorEn } from "./pages/monitor";
import { automationZh, automationEn } from "./pages/automation";

export type Lang = "zh-CN" | "en-US";
export type Dict = Record<string, string>;

export const zhDict: Dict = {
  ...commonZh,
  ...dashboardZh,
  ...devicesZh,
  ...volumesZh,
  ...adbZh,
  ...apkZh,
  ...logsZh,
  ...settingsZh,
  ...dockerZh,
  ...deviceDetailZh,
  ...monitorZh,
  ...automationZh,
};

export const enDict: Dict = {
  ...commonEn,
  ...dashboardEn,
  ...devicesEn,
  ...volumesEn,
  ...adbEn,
  ...apkEn,
  ...logsEn,
  ...settingsEn,
  ...dockerEn,
  ...deviceDetailEn,
  ...monitorEn,
  ...automationEn,
};

export function tStatic(key: string, vars?: Record<string, string | number>): string {
  const lang = readStoredLang();
  const dict = lang === "en-US" ? enDict : zhDict;
  let value = dict[key] ?? zhDict[key] ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

function readStoredLang(): Lang {
  try {
    return localStorage.getItem("rdc.lang") === "en-US" ? "en-US" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}
