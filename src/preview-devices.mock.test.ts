import { describe, expect, it } from "vitest";
import { mockInvoke, MOCK_DEVICES } from "./preview-devices.mock";

describe("preview Tauri bridge contract", () => {
  it("returns structured data for dashboard and global pages", () => {
    const dashboard = mockInvoke("get_dashboard") as {
      status: Record<string, unknown>;
      devices: unknown[];
      recentLogs: unknown[];
      notifications: unknown[];
    };
    expect(dashboard.status).toMatchObject({ dockerRunning: true, adbRunning: true });
    expect(dashboard.devices).toHaveLength(MOCK_DEVICES.length);
    expect(mockInvoke("get_system_logs")).toEqual(expect.any(Array));
    expect(mockInvoke("list_volumes")).toEqual(expect.any(Array));
    expect(mockInvoke("get_settings")).toMatchObject({ language: "zh-CN", adbPath: "adb" });
  });

  it("returns detail values in the types consumed by the detail page", () => {
    expect(mockInvoke("list_files", { serial: "serial", path: "/sdcard" })).toEqual(expect.any(Array));
    expect(mockInvoke("list_apps", { serial: "serial", includeSystem: false })).toEqual(expect.any(Array));
    expect(mockInvoke("get_logcat", { serial: "serial" })).toEqual(expect.any(String));
    expect(mockInvoke("get_battery_state", { serial: "serial" })).toMatchObject({ level: 86, charging: true });
    expect(mockInvoke("adversarial_audit", { serial: "serial" })).toMatchObject({ checks: expect.any(Array) });
  });

  it("keeps shell operations distinguishable from query results", () => {
    expect(mockInvoke("device_home", { serial: "serial" })).toMatchObject({ success: true, exitCode: 0 });
    expect(mockInvoke("get_device_proxy_status", { serial: "serial" })).toMatchObject({ transparentRunning: false });
  });

  it("returns QEMU track query shapes without inventing a ready environment", () => {
    expect(mockInvoke("qemu_doctor")).toMatchObject({ checks: expect.any(Array) });
    expect(mockInvoke("qemu_vm_list")).toEqual([]);
    expect(mockInvoke("qemu_redroid_list", { vm: "preview" })).toEqual([]);
  });
});
