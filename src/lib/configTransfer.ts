import type { AppSettings } from "../types";
import { DEVICE_METADATA_STORAGE_KEY, defaultDeviceMetadata, getAllDeviceMetadata, type DeviceMetadata } from "./deviceMetadata";
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_STORAGE_KEY, type ShortcutBinding } from "./shortcutConfig";
import { KEYBOARD_MAPPING_STORAGE_KEY, type KeyboardMapping } from "./keyboardMapping";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript, type AutomationScript } from "./automation";
import { SCHEDULER_STORAGE_KEY, type ScheduledTask } from "./scheduler";
import { AGENT_CONFIG_KEY, AGENT_PROFILES_KEY, parseAgentProfileState, type AgentProfile } from "./agent";

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_EXTENSIONS_STORAGE_KEY = "rdc.config-extensions.v1";

export interface AppConfigBackup {
  schemaVersion: number;
  app: "redroid-device-center";
  exportedAt: string;
  settings: AppSettings;
  deviceMetadata: Record<string, DeviceMetadata>;
  shortcuts: ShortcutBinding[];
  keyboardMappings: KeyboardMapping[];
  automationScripts: AutomationScript[];
  scheduledTasks: ScheduledTask[];
  agentProfiles: AgentProfile[];
  extensions: Record<string, unknown>;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null") as unknown;
    return parsed === null ? fallback : parsed as T;
  } catch {
    return fallback;
  }
}

export function buildConfigBackup(settings: AppSettings): AppConfigBackup {
  const shortcuts = readStored<ShortcutBinding[]>(SHORTCUT_STORAGE_KEY, DEFAULT_SHORTCUTS).filter((item) => item && typeof item.id === "string" && typeof item.key === "string");
  const keyboardMappings = readStored<KeyboardMapping[]>(KEYBOARD_MAPPING_STORAGE_KEY, []).filter((item) => item && typeof item.id === "string" && typeof item.trigger === "string");
  const automationScripts = readStored<AutomationScript[]>(AUTOMATION_STORAGE_KEY, []).filter((item) => item && typeof item.id === "string" && Array.isArray(item.steps));
  const scheduledTasks = readStored<ScheduledTask[]>(SCHEDULER_STORAGE_KEY, []).filter((item) => item && typeof item.id === "string" && typeof item.nextRun === "string");
  let agentProfilesRaw: string | null = null;
  let legacyAgentConfigRaw: string | null = null;
  try {
    agentProfilesRaw = localStorage.getItem(AGENT_PROFILES_KEY);
    legacyAgentConfigRaw = localStorage.getItem(AGENT_CONFIG_KEY);
  } catch { /* browser preview */ }
  const agentProfiles = parseAgentProfileState(agentProfilesRaw, legacyAgentConfigRaw).profiles;
  const extensions = readStored<Record<string, unknown>>(CONFIG_EXTENSIONS_STORAGE_KEY, {});
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    app: "redroid-device-center",
    exportedAt: new Date().toISOString(),
    settings: { ...settings },
    deviceMetadata: getAllDeviceMetadata(),
    shortcuts,
    keyboardMappings,
    automationScripts,
    scheduledTasks,
    agentProfiles,
    extensions,
  };
}

export function parseConfigBackup(raw: string, fallbackSettings: AppSettings): AppConfigBackup {
  const parsed = JSON.parse(raw) as Partial<AppConfigBackup>;
  if (!parsed || parsed.app !== "redroid-device-center") throw new Error("这不是 Redroid Device Center 配置文件");
  // Version 0 was the unversioned/first export shape. It already had the
  // settings and client-side collections, but omitted fields added later.
  // Merge those fields with the current defaults instead of making users
  // discard a usable backup after an upgrade.
  const sourceVersion = parsed.schemaVersion === undefined ? 0 : parsed.schemaVersion;
  if (sourceVersion !== 0 && sourceVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`不支持的配置版本：${String(parsed.schemaVersion)}`);
  }
  if (!parsed.settings || typeof parsed.settings !== "object") throw new Error("配置文件缺少设置内容");
  const settings = { ...fallbackSettings, ...parsed.settings };
  const metadata: AppConfigBackup["deviceMetadata"] = {};
  if (parsed.deviceMetadata && typeof parsed.deviceMetadata === "object") {
    for (const [id, value] of Object.entries(parsed.deviceMetadata)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Partial<DeviceMetadata>;
      metadata[id] = {
        ...defaultDeviceMetadata,
        ...item,
        labels: Array.isArray(item.labels) ? item.labels.filter((label): label is string => typeof label === "string") : [],
      };
    }
  }
  const knownActions = new Set(SHORTCUT_ACTIONS.map((item) => item.value));
  const shortcuts = Array.isArray(parsed.shortcuts)
    ? parsed.shortcuts.filter((item): item is ShortcutBinding => Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.key === "string" && knownActions.has(item.action as ShortcutBinding["action"])).map((item) => ({ ...item, deviceId: typeof item.deviceId === "string" ? item.deviceId : "", enabled: item.enabled === true }))
    : DEFAULT_SHORTCUTS.map((item) => ({ ...item }));
  const keyboardMappings = Array.isArray(parsed.keyboardMappings)
    ? parsed.keyboardMappings.filter((item): item is KeyboardMapping => Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.trigger === "string").map((item) => ({ ...item, enabled: item.enabled === true }))
    : [];
  const automationScripts = Array.isArray(parsed.automationScripts)
    ? parsed.automationScripts.filter((item) => Boolean(item) && typeof item === "object" && typeof (item as AutomationScript).id === "string" && Array.isArray((item as AutomationScript).steps)).map((item) => normalizeAutomationScript(item as unknown as Record<string, unknown>))
    : [];
  const scheduledTasks = Array.isArray(parsed.scheduledTasks)
    ? parsed.scheduledTasks.filter((item): item is ScheduledTask => Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.nextRun === "string")
    : [];
  const agentProfiles = Array.isArray(parsed.agentProfiles)
    ? parseAgentProfileState(JSON.stringify({ selectedId: parsed.agentProfiles[0]?.id, profiles: parsed.agentProfiles })).profiles
    : [];
  const knownKeys = new Set(["schemaVersion", "app", "exportedAt", "settings", "deviceMetadata", "arrangement", "shortcuts", "keyboardMappings", "automationScripts", "scheduledTasks", "agentProfiles", "extensions"]);
  const extensions = {
    ...(parsed.extensions && typeof parsed.extensions === "object" ? parsed.extensions : {}),
    ...Object.fromEntries(Object.entries(parsed).filter(([key]) => !knownKeys.has(key))),
    ...(sourceVersion === 0 ? { "rdc.migration": { from: 0, to: CONFIG_SCHEMA_VERSION } } : {}),
  };
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    app: "redroid-device-center",
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    settings,
    deviceMetadata: metadata,
    shortcuts,
    keyboardMappings,
    automationScripts,
    scheduledTasks,
    agentProfiles,
    extensions,
  };
}

export function applyClientConfig(config: AppConfigBackup) {
  try {
    localStorage.setItem(DEVICE_METADATA_STORAGE_KEY, JSON.stringify(config.deviceMetadata));
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(config.shortcuts));
    localStorage.setItem(KEYBOARD_MAPPING_STORAGE_KEY, JSON.stringify(config.keyboardMappings));
    localStorage.setItem(AUTOMATION_STORAGE_KEY, JSON.stringify(config.automationScripts));
    localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(config.scheduledTasks));
    localStorage.setItem(AGENT_PROFILES_KEY, JSON.stringify({ selectedId: config.agentProfiles[0]?.id || "", profiles: config.agentProfiles }));
    localStorage.setItem(CONFIG_EXTENSIONS_STORAGE_KEY, JSON.stringify(config.extensions));
  } catch {
    // Browser preview may have restricted storage; the native settings still import.
  }
}
