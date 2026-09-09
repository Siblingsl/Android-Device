import { describe, expect, it } from "vitest";
import {
  findPairingService,
  isAdbConnectService,
  isAdbPairingService,
  normalizeWirelessAddress,
  normalizeReconnectConcurrency,
  parseAdbQrPayload,
  runWithConcurrency,
  getSavedWirelessAddressStatus,
  renameSavedWirelessAddress,
  upsertSavedWirelessAddress,
} from "./wirelessDebug";

describe("wireless debugging helpers", () => {
  it("parses Android ADB QR payloads", () => {
    expect(parseAdbQrPayload("WIFI:T:ADB;S:studio-g@device;P:(Aq+v9>Cx>!;;")).toEqual({
      instanceName: "studio-g@device",
      pairingSecret: "(Aq+v9>Cx>!",
    });
  });

  it("decodes escaped QR values and rejects non-ADB payloads", () => {
    expect(parseAdbQrPayload("WIFI:T:ADB;S:studio\\;device;P:secret\\:1;;")).toEqual({
      instanceName: "studio;device",
      pairingSecret: "secret:1",
    });
    expect(parseAdbQrPayload("WIFI:T:WPA;S:network;P:password;;")).toBeNull();
    expect(parseAdbQrPayload("not a qr payload")).toBeNull();
  });

  it("validates wireless addresses and identifies mDNS service types", () => {
    expect(normalizeWirelessAddress(" 192.168.1.20:37145 ")).toBe("192.168.1.20:37145");
    expect(normalizeWirelessAddress("192.168.1.20:0")).toBeNull();
    expect(normalizeWirelessAddress("not-an-address")).toBeNull();

    const pairing = { instanceName: "studio-device", serviceType: "_adb-tls-pairing._tcp", address: "192.168.1.20:37145" };
    const connect = { instanceName: "adb-device", serviceType: "_adb-tls-connect._tcp", address: "192.168.1.20:41123" };
    expect(isAdbPairingService(pairing)).toBe(true);
    expect(isAdbConnectService(connect)).toBe(true);
    expect(findPairingService([connect, pairing], "studio-device")).toEqual(pairing);
  });

  it("keeps saved addresses unique and caps reconnect concurrency", async () => {
    const first = upsertSavedWirelessAddress([], "192.168.1.20:5555", "Phone");
    const second = upsertSavedWirelessAddress(first, "192.168.1.20:5555", "Updated phone");
    expect(second).toHaveLength(1);
    expect(second[0].label).toBe("Updated phone");

    let active = 0;
    let peak = 0;
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("normalizes the saved-address reconnect concurrency range", () => {
    expect(normalizeReconnectConcurrency("4")).toBe(4);
    expect(normalizeReconnectConcurrency(0)).toBe(1);
    expect(normalizeReconnectConcurrency(99)).toBe(6);
    expect(normalizeReconnectConcurrency("invalid")).toBe(3);
  });

  it("merges live ADB, mDNS, and reconnect state for saved addresses", () => {
    const entry = { address: "192.168.1.20:5555", label: "Phone", lastConnectedAt: "" };
    expect(getSavedWirelessAddressStatus(entry, [], [], {})).toBe("offline");
    expect(getSavedWirelessAddressStatus(entry, [], [], {
      [entry.address]: { status: "connecting", message: "" },
    })).toBe("connecting");
    expect(getSavedWirelessAddressStatus(entry, [], [], {
      [entry.address]: { status: "failed", message: "timeout" },
    })).toBe("failed");
    expect(getSavedWirelessAddressStatus(
      entry,
      [{ serial: entry.address, state: "device", product: "", model: "", device: "", transportId: "" }],
      [],
      {},
    )).toBe("online");
    expect(getSavedWirelessAddressStatus(
      entry,
      [],
      [{ instanceName: "phone", serviceType: "_adb-tls-connect._tcp", address: entry.address }],
      {},
    )).toBe("online");
  });

  it("renames only the selected saved wireless address", () => {
    const entries = [
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "a" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "b" },
    ];
    expect(renameSavedWirelessAddress(entries, "192.168.1.20:5555", "  Main phone  ")).toEqual([
      { address: "192.168.1.20:5555", label: "Main phone", lastConnectedAt: "a" },
      entries[1],
    ]);
    expect(renameSavedWirelessAddress(entries, "192.168.1.20:5555", "")[0].label).toBe("192.168.1.20:5555");
  });
});
