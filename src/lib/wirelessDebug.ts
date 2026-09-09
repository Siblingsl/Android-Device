import type { AdbDevice, AdbMdnsService } from "../types";

export interface AdbQrPayload {
  instanceName: string;
  pairingSecret: string;
}

export interface SavedWirelessAddress {
  address: string;
  label: string;
  lastConnectedAt: string;
  favorite?: boolean;
  group?: string;
}

export type SavedWirelessAddressStatus = "online" | "connecting" | "offline" | "failed";
export type SavedWirelessReconnectState = {
  status: "connecting" | "success" | "failed";
  message: string;
};

export const DEFAULT_RECONNECT_CONCURRENCY = 3;

export function normalizeReconnectConcurrency(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RECONNECT_CONCURRENCY;
  return Math.max(1, Math.min(6, Math.floor(parsed)));
}

function decodeQrValue(value: string): string {
  let decoded = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      decoded += value[i + 1];
      i += 1;
    } else {
      decoded += value[i];
    }
  }
  return decoded;
}

function splitQrFields(value: string): string[] {
  const fields: string[] = [];
  let field = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      field += "\\" + character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ";") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaped) field += "\\";
  if (field) fields.push(field);
  return fields;
}

export function parseAdbQrPayload(raw: string): AdbQrPayload | null {
  const value = raw.trim();
  if (!value.toUpperCase().startsWith("WIFI:")) return null;
  const fields = new Map<string, string>();
  for (const field of splitQrFields(value.slice(5))) {
    const separator = field.indexOf(":");
    if (separator <= 0) continue;
    const key = field.slice(0, separator).toUpperCase();
    fields.set(key, decodeQrValue(field.slice(separator + 1)));
  }
  if (fields.get("T")?.toUpperCase() !== "ADB") return null;
  const instanceName = fields.get("S")?.trim() || "";
  const pairingSecret = fields.get("P")?.trim() || "";
  if (!instanceName || !pairingSecret) return null;
  return { instanceName, pairingSecret };
}

export function normalizeWirelessAddress(raw: string): string | null {
  const value = raw.trim();
  const match = value.match(/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return value;
}

export function isAdbPairingService(service: AdbMdnsService): boolean {
  return service.serviceType.toLowerCase().includes("adb-tls-pairing");
}

export function isAdbConnectService(service: AdbMdnsService): boolean {
  return service.serviceType.toLowerCase().includes("adb-tls-connect");
}

export function findPairingService(
  services: AdbMdnsService[],
  instanceName: string,
): AdbMdnsService | null {
  const requested = instanceName.trim();
  if (!requested) return null;
  return services.find((service) => isAdbPairingService(service) && service.instanceName === requested) || null;
}

export function upsertSavedWirelessAddress(
  entries: SavedWirelessAddress[],
  rawAddress: string,
  label = rawAddress,
): SavedWirelessAddress[] {
  const address = normalizeWirelessAddress(rawAddress);
  if (!address) return entries;
  const existing = entries.find((entry) => entry.address === address);
  const next = entries.filter((entry) => entry.address !== address);
  return [
    {
      address,
      label: label.trim() || address,
      lastConnectedAt: new Date().toISOString(),
      ...(existing?.favorite !== undefined ? { favorite: existing.favorite } : {}),
      ...(existing?.group ? { group: existing.group } : {}),
    },
    ...next,
  ].slice(0, 32);
}

export function renameSavedWirelessAddress(
  entries: SavedWirelessAddress[],
  rawAddress: string,
  rawLabel: string,
): SavedWirelessAddress[] {
  const address = normalizeWirelessAddress(rawAddress);
  if (!address) return entries;
  const label = rawLabel.trim() || address;
  return entries.map((entry) => entry.address === address ? { ...entry, label } : entry);
}

export function getSavedWirelessAddressStatus(
  entry: SavedWirelessAddress,
  devices: AdbDevice[],
  services: AdbMdnsService[],
  reconnectResults: Record<string, SavedWirelessReconnectState>,
): SavedWirelessAddressStatus {
  const reconnect = reconnectResults[entry.address];
  if (reconnect?.status === "connecting") return "connecting";

  const liveDevice = devices.some((device) => device.serial === entry.address && device.state === "device");
  const liveService = services.some((service) => isAdbConnectService(service) && service.address === entry.address);
  if (liveDevice || liveService || reconnect?.status === "success") return "online";
  if (reconnect?.status === "failed") return "failed";
  return "offline";
}

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}
