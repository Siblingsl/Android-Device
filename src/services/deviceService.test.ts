import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DeviceService, QemuService } from "./deviceService";

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

  it("maps the read-only runtime resource snapshot query", async () => {
    const snapshot = {
      capturedAt: "2026-09-17T04:00:00Z",
      hostTotalBytes: 16_000,
      hostAvailableBytes: null,
      qemuPrivateBytes: null,
      qemuWorkingSetBytes: null,
      wslPrivateBytes: null,
      vmMemoryMiB: 4096,
      vmVcpus: 4,
      instanceMemoryLimitBytes: null,
      instanceMemoryCurrentBytes: null,
      instanceMemoryPeakBytes: null,
      instanceOomKills: null,
      bootCompleted: null,
      appReadyMs: null,
      source: "host",
    } as const;
    vi.mocked(invoke).mockResolvedValueOnce(snapshot);

    const result = await DeviceService.readRuntimeResourceSnapshot("node1", "r13");

    expect(invoke).toHaveBeenCalledWith("read_runtime_resource_snapshot", {
      vm: "node1",
      instance: "r13",
    });
    expect(result).toEqual(snapshot);
  });

  it("maps nullable QEMU redroid stats without changing missing values", async () => {
    const stats = [
      {
        instance: "r13",
        container: "qc-r13",
        status: "running",
        memoryLimitBytes: null,
        memoryCurrentBytes: 123,
        memoryPeakBytes: null,
        oomKills: null,
        cpuUsagePercent: null,
        bootCompleted: true,
      },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(stats);

    const result = await QemuService.redroidStats("node1", "r13");

    expect(invoke).toHaveBeenCalledWith("qemu_redroid_stats", {
      vm: "node1",
      instance: "r13",
    });
    expect(result).toEqual(stats);
  });

  it("maps runtime lifecycle activity and idle reclaim commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ state: "queued" })
      .mockResolvedValueOnce({ instance: "r13", released: false, reason: "active_or_unknown" });

    await QemuService.runtimeMarkActivity("r13", "user_window");
    await QemuService.runtimeRequestStart("node1", "r13");
    await QemuService.runtimeReleaseIdle("node1", "r13");

    expect(invoke).toHaveBeenNthCalledWith(1, "runtime_mark_activity", {
      instance: "r13",
      kind: "user_window",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "runtime_request_start", {
      vm: "node1",
      instance: "r13",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "runtime_release_idle", {
      vm: "node1",
      instance: "r13",
    });
  });

  it("maps the bounded ART experiment command", async () => {
    const result = {
      serial: "127.0.0.1:24501",
      package: "com.xingin.xhs",
      mode: "speed-profile",
      success: true,
      exitCode: 0,
      elapsedMs: 120,
      output: "Success",
      warning: "measure the result",
    } as const;
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await DeviceService.optimizeAppArt("127.0.0.1:24501", "com.xingin.xhs", "speed-profile");

    expect(invoke).toHaveBeenCalledWith("optimize_app_art", {
      serial: "127.0.0.1:24501",
      package: "com.xingin.xhs",
      mode: "speed-profile",
    });
  });
});
