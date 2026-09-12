import type { DeviceInfo } from "../types";

export interface ArrangementItem {
  id: string;
  order: number;
  span: 1 | 2;
  height: number;
  x: number;
  y: number;
  width: number;
}

export const ARRANGEMENT_STORAGE_KEY = "rdc.device-arrangement.v1";
export const ARRANGEMENT_RESTORE_KEY = "rdc.device-arrangement.restore";

export function arrangementAutoRestoreEnabled(): boolean {
  try {
    return localStorage.getItem(ARRANGEMENT_RESTORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setArrangementAutoRestoreEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ARRANGEMENT_RESTORE_KEY, enabled ? "1" : "0");
  } catch {
    // Local persistence is optional in browser preview.
  }
}

export function buildGridLayout(devices: DeviceInfo[], columns = 2): ArrangementItem[] {
  const safeColumns = Math.max(1, Math.min(4, Math.round(columns)));
  const width = safeColumns === 1 ? 900 : 560;
  return devices.map((device, index) => ({
    id: device.id,
    order: index,
    span: safeColumns === 1 ? 1 : 1,
    height: 360,
    x: (index % safeColumns) * width,
    y: Math.floor(index / safeColumns) * 400,
    width,
  }));
}

export function readArrangement(devices: DeviceInfo[]): ArrangementItem[] {
  const fallback = buildGridLayout(devices);
  try {
    const parsed = JSON.parse(localStorage.getItem(ARRANGEMENT_STORAGE_KEY) || "null") as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const known = new Set(devices.map((device) => device.id));
    const stored = parsed.filter((item): item is ArrangementItem => Boolean(item) && typeof item === "object" && typeof (item as ArrangementItem).id === "string" && known.has((item as ArrangementItem).id));
    const seen = new Set(stored.map((item) => item.id));
    const merged = [...stored, ...fallback.filter((item) => !seen.has(item.id))];
    return merged.map((item, index) => ({
      id: item.id,
      order: index,
      span: item.span === 2 ? 2 : 1,
      height: Number.isFinite(Number(item.height)) ? Math.max(180, Math.min(1200, Math.round(Number(item.height)))) : 360,
      x: Number.isFinite(Number(item.x)) ? Math.round(Number(item.x)) : index * 20,
      y: Number.isFinite(Number(item.y)) ? Math.round(Number(item.y)) : index * 20,
      width: Number.isFinite(Number(item.width)) ? Math.max(320, Math.min(2400, Math.round(Number(item.width)))) : 560,
    }));
  } catch {
    return fallback;
  }
}

export function saveArrangement(items: ArrangementItem[]) {
  try {
    localStorage.setItem(ARRANGEMENT_STORAGE_KEY, JSON.stringify(items.map((item, index) => ({
      ...item,
      order: index,
      height: Math.max(180, Math.min(1200, Math.round(item.height || 360))),
      x: Number.isFinite(item.x) ? Math.round(item.x) : index * 20,
      y: Number.isFinite(item.y) ? Math.round(item.y) : index * 20,
      width: Math.max(320, Math.min(2400, Math.round(item.width || 560))),
    }))));
  } catch {
    // Local persistence is optional in browser preview.
  }
}

/** Persist the bounds reported by a native device window after the user moves or resizes it. */
export function updateArrangementBounds(id: string, x: number, y: number, width: number, height: number) {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARRANGEMENT_STORAGE_KEY) || "null") as unknown;
    if (!Array.isArray(parsed)) return;
    const items = parsed.filter((item): item is ArrangementItem => Boolean(item) && typeof item === "object" && typeof (item as ArrangementItem).id === "string");
    if (!items.some((item) => item.id === id)) return;
    saveArrangement(items.map((item) => item.id === id ? { ...item, x, y, width, height } : item));
  } catch {
    // Local persistence is optional in browser preview.
  }
}

export function resetArrangement(devices: DeviceInfo[]) {
  const next = buildGridLayout(devices);
  saveArrangement(next);
  return next;
}
