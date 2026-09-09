import type { DeviceInfo } from "../types";

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
