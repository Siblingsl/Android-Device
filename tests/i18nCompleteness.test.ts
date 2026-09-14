import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commonZh, commonEn } from "../src/i18n/pages/common";
import { dashboardZh, dashboardEn } from "../src/i18n/pages/dashboard";
import { devicesZh, devicesEn } from "../src/i18n/pages/devices";
import { volumesZh, volumesEn } from "../src/i18n/pages/volumes";
import { adbZh, adbEn } from "../src/i18n/pages/adb";
import { apkZh, apkEn } from "../src/i18n/pages/apk";
import { logsZh, logsEn } from "../src/i18n/pages/logs";
import { settingsZh, settingsEn } from "../src/i18n/pages/settings";
import { dockerZh, dockerEn } from "../src/i18n/pages/docker";
import { deviceDetailZh, deviceDetailEn } from "../src/i18n/pages/deviceDetail";
import { monitorZh, monitorEn } from "../src/i18n/pages/monitor";

// Mirror the merged dictionaries that i18n/index.tsx builds at runtime.
const zhDict: Record<string, string> = {
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
};
const enDict: Record<string, string> = {
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
};

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

const DEVICE_COMPONENTS = [
  "AgentPanel",
  "AutomationPanel",
  "DeviceBroadcastInput",
  "DeviceControlBar",
  "DeviceControlPanel",
  "DeviceHealthPanel",
  "DeviceHoverCard",
  "DeviceInputModes",
  "DeviceMediaControls",
  "DeviceMetadataPanel",
  "DevicePreview",
  "DeviceShell",
  "DeviceStream",
  "FileExplorer",
  "GnirehtetPanel",
  "GroupControlPanel",
  "InteractiveTerminal",
  "KeyboardMappingPanel",
  "QuickAppLauncher",
  "RecordingPanel",
  "ScrcpyControlBar",
  "ScrcpyOptionsPanel",
  "ScrcpyPreferences",
].map((name) => `src/components/device/${name}.tsx`);

const TARGETS = ["src/pages/DeviceDetail.tsx", ...DEVICE_COMPONENTS];

/** Static keys passed directly to t(): t("key"), t('key'), or t(`key`) without interpolation. */
function extractStaticKeys(source: string): string[] {
  const keys = new Set<string>();
  const re = /\bt\s*\(\s*("([^"]*)"|'([^']*)'|`([^`]*)`)\s*[,)]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const literal = match[2] ?? match[3] ?? match[4];
    if (!literal || literal.includes("${")) continue;
    keys.add(literal);
  }
  return [...keys];
}

// Keys built dynamically (template literals and ternaries). The static scanner
// deliberately ignores these, so their full expansions are enumerated here.
const DYNAMIC_KEYS = [
  // detail.tab.${tab} / detail.workspace.${tab}
  "detail.tab.overview",
  "detail.tab.control",
  "detail.tab.files",
  "detail.tab.apps",
  "detail.tab.logs",
  "detail.tab.settings",
  "detail.workspace.overview",
  "detail.workspace.control",
  "detail.workspace.files",
  "detail.workspace.apps",
  "detail.workspace.logs",
  "detail.workspace.settings",
  // detail.media.rotation.${mode}
  "detail.media.rotation.portrait",
  "detail.media.rotation.landscape",
  "detail.media.rotation.auto",
  "detail.media.rotation.lock",
  // detail.media.confirm.${action}
  "detail.media.confirm.reboot",
  "detail.media.confirm.shutdown",
  // detail.media.${action}
  "detail.media.mute",
  "detail.media.screenOff",
  "detail.media.reboot",
  "detail.media.shutdown",
  // detail.input.start.${mode}
  "detail.input.start.uhid",
  "detail.input.start.otg",
  // ternary mode hints in DeviceInputModes
  "detail.input.otgHint",
  "detail.input.uhidHint",
  // detail.monitor.state.${health.state}
  "detail.monitor.state.healthy",
  "detail.monitor.state.offline",
  "detail.monitor.state.adb",
  "detail.monitor.state.container",
  // detail.monitor.policy.preset.${monitorPreset}
  "detail.monitor.policy.preset.inherit",
  "detail.monitor.policy.preset.sensitive",
  "detail.monitor.policy.preset.balanced",
  "detail.monitor.policy.preset.relaxed",
  "detail.monitor.policy.preset.custom",
  // detail.monitor.policy.severity.${severity}
  "detail.monitor.policy.severity.warning",
  "detail.monitor.policy.severity.critical",
  // ternary file-manager keys
  "detail.files.copiedToClipboard",
  "detail.files.cutToClipboard",
  "detail.files.copyReady",
  "detail.files.cutReady",
  "detail.files.batchUpload",
  "detail.files.batchDownload",
  // DeviceBroadcastInput resolves t(key.label) from a runtime lookup
  "devices.broadcast.home",
  "devices.broadcast.back",
  "devices.broadcast.recent",
];

describe("i18n completeness for the device detail surface", () => {
  it("defines every static t() key in both zh and en", () => {
    const failures: string[] = [];
    for (const target of TARGETS) {
      for (const key of extractStaticKeys(read(target))) {
        if (!zhDict[key]) failures.push(`${target}: missing zh "${key}"`);
        if (!enDict[key]) failures.push(`${target}: missing en "${key}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("defines every dynamic t() key expansion in both zh and en", () => {
    const failures: string[] = [];
    for (const key of DYNAMIC_KEYS) {
      if (!zhDict[key]) failures.push(`missing zh "${key}"`);
      if (!enDict[key]) failures.push(`missing en "${key}"`);
    }
    expect(failures).toEqual([]);
  });
});
