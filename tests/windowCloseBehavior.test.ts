import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layout = readFileSync(
  resolve(process.cwd(), "src/components/layout/AppLayout.tsx"),
  "utf8",
);

describe("native window close behavior", () => {
  it("registers the close interceptor only when close-to-tray is enabled", () => {
    expect(layout).toMatch(/const closeToTray = useAppStore\(\(s\) => Boolean\(s\.settings\?\.closeToTray\)\)/);
    expect(layout).toMatch(/if \(!closeToTray\) return;/);
    expect(layout).toMatch(/\}, \[closeToTray\]\);/);
  });
});
