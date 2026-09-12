import type { DeviceInfo } from "../types";

export interface DeviceMetadata {
  remark: string;
  group: string;
  labels: string[];
  autoConnect: boolean;
  autoMirror: boolean;
}

export const DEVICE_METADATA_STORAGE_KEY = "rdc.device-metadata.v1";

export const defaultDeviceMetadata: DeviceMetadata = {
  remark: "",
  group: "",
  labels: [],
  autoConnect: false,
  autoMirror: false,
};

function readAll(): Record<string, DeviceMetadata> {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_METADATA_STORAGE_KEY) || "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
      const item = value && typeof value === "object" ? value as Partial<DeviceMetadata> : {};
      return [id, { ...defaultDeviceMetadata, ...item, labels: Array.isArray(item.labels) ? item.labels.filter((label): label is string => typeof label === "string") : [] }];
    }));
  } catch {
    return {};
  }
}

export function getDeviceMetadata(id: string): DeviceMetadata {
  return { ...defaultDeviceMetadata, ...(readAll()[id] || {}) };
}

export function setDeviceMetadata(id: string, value: DeviceMetadata) {
  try {
    const all = readAll();
    all[id] = { ...defaultDeviceMetadata, ...value, labels: [...new Set(value.labels.map((label) => label.trim()).filter(Boolean))].slice(0, 30) };
    localStorage.setItem(DEVICE_METADATA_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Browser preview may not provide storage.
  }
}

export function removeDeviceMetadata(id: string): boolean {
  try {
    const all = readAll();
    if (!Object.prototype.hasOwnProperty.call(all, id)) return false;
    delete all[id];
    localStorage.setItem(DEVICE_METADATA_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function getAllDeviceMetadata(): Record<string, DeviceMetadata> {
  return readAll();
}

export function replaceAllDeviceMetadata(value: Record<string, DeviceMetadata>) {
  try {
    const cleaned: Record<string, DeviceMetadata> = {};
    for (const [id, item] of Object.entries(value)) {
      cleaned[id] = {
        ...defaultDeviceMetadata,
        ...item,
        labels: [...new Set((item.labels || []).map((label) => label.trim()).filter(Boolean))].slice(0, 30),
      };
    }
    localStorage.setItem(DEVICE_METADATA_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Local persistence is optional in browser preview.
  }
}

export function autoConnectDeviceIds() {
  return Object.entries(readAll()).filter(([, value]) => value.autoConnect).map(([id]) => id);
}

export const DEVICE_NOTES_KEY = "rdc.devices.notes";
export const OFFLINE_DEVICE_HISTORY_KEY = "rdc.devices.offlineHistory";
export const MAX_OFFLINE_DEVICE_HISTORY = 50;

export type DeviceNoteMap = Record<string, string>;

export interface OfflineDeviceHistoryEntry {
  device: DeviceInfo;
  lastSeenAt: number;
}

function isDeviceSnapshot(value: unknown): value is DeviceInfo {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DeviceInfo>;
  return typeof item.id === "string" && item.id.length > 0 && typeof item.name === "string";
}

export function readDeviceNotes(): DeviceNoteMap {
  try {
    const raw = localStorage.getItem(DEVICE_NOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.entries(parsed as Record<string, unknown>).reduce<DeviceNoteMap>((notes, [id, value]) => {
      if (typeof value === "string" && value.trim()) notes[id] = value.trim();
      return notes;
    }, {});
  } catch {
    return {};
  }
}

export function persistDeviceNotes(notes: DeviceNoteMap) {
  try {
    localStorage.setItem(DEVICE_NOTES_KEY, JSON.stringify(notes));
  } catch {
    /* ignore unavailable or full local storage */
  }
}

export function updateDeviceNote(notes: DeviceNoteMap, id: string, value: string): DeviceNoteMap {
  const next = { ...notes };
  const trimmed = value.trim();
  if (trimmed) next[id] = trimmed;
  else delete next[id];
  return next;
}

export function readOfflineDeviceHistory(): OfflineDeviceHistoryEntry[] {
  try {
    const raw = localStorage.getItem(OFFLINE_DEVICE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is OfflineDeviceHistoryEntry => {
        if (!value || typeof value !== "object") return false;
        const item = value as Partial<OfflineDeviceHistoryEntry>;
        return isDeviceSnapshot(item.device) && typeof item.lastSeenAt === "number" && Number.isFinite(item.lastSeenAt);
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_OFFLINE_DEVICE_HISTORY);
  } catch {
    return [];
  }
}

export function persistOfflineDeviceHistory(history: OfflineDeviceHistoryEntry[]) {
  try {
    localStorage.setItem(
      OFFLINE_DEVICE_HISTORY_KEY,
      JSON.stringify(history.slice(0, MAX_OFFLINE_DEVICE_HISTORY)),
    );
  } catch {
    /* ignore unavailable or full local storage */
  }
}

export function rememberDevices(
  history: OfflineDeviceHistoryEntry[],
  devices: DeviceInfo[],
  now = Date.now(),
): OfflineDeviceHistoryEntry[] {
  const current = new Map(history.map((entry) => [entry.device.id, entry]));
  devices.forEach((device) => {
    current.set(device.id, { device, lastSeenAt: now });
  });
  return [...current.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_OFFLINE_DEVICE_HISTORY);
}

export function removeOfflineDevice(history: OfflineDeviceHistoryEntry[], id: string) {
  return history.filter((entry) => entry.device.id !== id);
}
