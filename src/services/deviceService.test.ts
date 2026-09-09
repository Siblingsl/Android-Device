import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DeviceService } from "./deviceService";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/errors", () => ({
  friendlyError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
}));

describe("DeviceService tracked file transfers", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("maps tracked upload arguments without changing the legacy method", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await DeviceService.uploadFileTracked("serial-1", "C:/a.txt", "/sdcard/a.txt", "op-1");

    expect(invoke).toHaveBeenCalledWith("upload_file_tracked", {
      serial: "serial-1",
      local: "C:/a.txt",
      remote: "/sdcard/a.txt",
      operationId: "op-1",
    });
  });

  it("maps tracked download and cancellation commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce(true);

    await DeviceService.downloadFileTracked("serial-1", "/sdcard/a.txt", "C:/a.txt", "op-2");
    await DeviceService.cancelFileTransfer("op-2");

    expect(invoke).toHaveBeenNthCalledWith(1, "download_file_tracked", {
      serial: "serial-1",
      remote: "/sdcard/a.txt",
      local: "C:/a.txt",
      operationId: "op-2",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "cancel_file_transfer", { operationId: "op-2" });
  });

  it("maps wireless pairing, mDNS discovery and tcpip commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ success: true, stdout: "paired", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ success: true, stdout: "restarting", stderr: "", exitCode: 0 });

    await DeviceService.adbPair("192.168.1.20:37145", "515109");
    await DeviceService.adbMdnsServices();
    await DeviceService.adbTcpip("usb-serial", 5555);

    expect(invoke).toHaveBeenNthCalledWith(1, "adb_pair", {
      address: "192.168.1.20:37145",
      pairingCode: "515109",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "adb_mdns_services", undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "adb_tcpip", { serial: "usb-serial", port: 5555 });
  });
});
