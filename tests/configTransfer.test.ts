import { describe, expect, it } from "vitest";
import { buildConfigBackup, parseConfigBackup } from "../src/lib/configTransfer";
import type { AppSettings } from "../src/types";

const settings: AppSettings = {
  theme: "light", language: "zh-CN", autoUpdate: true, logPath: "", screenshotPath: "", apkPath: "", proxy: "", dockerPath: "docker", adbPath: "adb", scrcpyPath: "scrcpy",
};

describe("configTransfer", () => {
  it("builds a versioned backup and restores known fields", () => {
    const backup = buildConfigBackup(settings);
    expect(backup.app).toBe("redroid-device-center");
    expect(backup.agentProfiles.length).toBeGreaterThan(0);
    expect(parseConfigBackup(JSON.stringify(backup), settings).settings.dockerPath).toBe("docker");
    expect(parseConfigBackup(JSON.stringify(backup), settings).agentProfiles.length).toBeGreaterThan(0);
  });

  it("rejects another app or unsupported schema", () => {
    expect(() => parseConfigBackup(JSON.stringify({ app: "other", schemaVersion: 1 }), settings)).toThrow();
    expect(() => parseConfigBackup(JSON.stringify({ app: "redroid-device-center", schemaVersion: 99 }), settings)).toThrow();
  });

  it("keeps unknown root fields for a later export", () => {
    const raw = JSON.stringify({ ...buildConfigBackup(settings), futureFeature: { enabled: true } });
    expect(parseConfigBackup(raw, settings).extensions.futureFeature).toEqual({ enabled: true });
  });

  it("migrates the legacy version 0 shape and keeps newer defaults", () => {
    const raw = JSON.stringify({
      app: "redroid-device-center",
      schemaVersion: 0,
      exportedAt: "2025-01-01T00:00:00.000Z",
      settings: { theme: "dark", language: "zh-CN" },
      deviceMetadata: {},
      arrangement: [],
      shortcuts: [],
      keyboardMappings: [],
      automationScripts: [],
      scheduledTasks: [],
      futureLegacyField: { enabled: true },
    });
    const migrated = parseConfigBackup(raw, settings);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.settings.theme).toBe("dark");
    expect(migrated.settings.adbPath).toBe("adb");
    expect(migrated.extensions.futureLegacyField).toEqual({ enabled: true });
    expect(migrated.extensions["rdc.migration"]).toEqual({ from: 0, to: 1 });
  });
});
