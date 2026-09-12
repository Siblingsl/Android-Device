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
