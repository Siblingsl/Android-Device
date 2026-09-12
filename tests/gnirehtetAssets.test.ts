import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bundleDir = resolve(process.cwd(), "vendor", "gnirehtet", "windows-x64");

describe("bundled Gnirehtet runtime", () => {
  it("ships the Windows Rust runtime and Android client", () => {
    expect(existsSync(resolve(bundleDir, "gnirehtet.exe"))).toBe(true);
    expect(existsSync(resolve(bundleDir, "gnirehtet.apk"))).toBe(true);
    expect(existsSync(resolve(bundleDir, "gnirehtet-run.cmd"))).toBe(true);
  });

  it("keeps the upstream license with the downloaded runtime", () => {
    const license = readFileSync(resolve(bundleDir, "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
  });
});
