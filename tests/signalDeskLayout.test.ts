import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const detail = read("src/pages/DeviceDetail.tsx");
const styles = read("src/styles/global.css");

describe("Signal Desk layout", () => {
  it("defines the device detail workspace shell", () => {
    expect(detail).toContain('className="detail-shell"');
    expect(detail).toContain('className="detail-context"');
    expect(detail).toContain('className="detail-tabbar"');
    expect(detail).toContain('className="detail-workspace"');
    expect(detail).toContain('className="detail-module"');
  });

  it("keeps all six detail tabs in the new tab rail", () => {
    for (const key of ["overview", "control", "files", "apps", "logs", "settings"]) {
      expect(detail).toContain(`"${key}"`);
    }
    expect(detail).toContain("detail-workspace-head");
    expect(detail).toContain("detail-tab-status");
  });

  it("defines bounded detail scroll regions", () => {
    expect(styles).toMatch(/\.detail-scroll-region\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.detail-workspace\s*\{[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.page-device-detail[^}]*overflow-y:\s*auto/s);
  });

  it("uses the Signal Desk spacing and module primitives", () => {
    expect(styles).toContain("--surface-soft: #EEF2F4");
    expect(styles).toContain("--line-strong: #AABBC3");
    expect(styles).toMatch(/\.module\s*\{[^}]*border-top:\s*2px/s);
    expect(styles).toMatch(/\.module-head\s*\{[^}]*min-height:\s*35px/s);
    expect(styles).toMatch(/\.tabs\s*\{[^}]*border-bottom:\s*1px/s);
  });

  it("marks long-running feature regions as internal scroll areas", () => {
    expect(detail).toMatch(/className="[^"]*detail-control-workspace/);
    expect(detail).toMatch(/className="[^"]*detail-files-workspace/);
    expect(detail).toMatch(/className="[^"]*detail-apps-workspace/);
    expect(detail).toMatch(/className="[^"]*detail-logs-workspace/);
    expect(detail).toMatch(/className="[^"]*detail-settings-workspace/);
    expect(styles).toMatch(/\.detail-control-workspace[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.detail-files-workspace[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.detail-apps-workspace[^}]*min-height:\s*0/s);
  });

  it("gives detail tables their own bounded scroll surface", () => {
    expect(detail).toContain('className="table-wrap detail-table-scroll"');
    expect(detail.match(/table-wrap detail-table-scroll/g)?.length).toBeGreaterThanOrEqual(2);
    expect(styles).toMatch(/\.detail-table-scroll\s*\{[^}]*overflow:\s*auto;/s);
  });

  it("keeps a shared app shell and status bar", () => {
    const layout = read("src/components/layout/AppLayout.tsx");
    expect(layout).toContain("app-shell");
    expect(layout).toContain("StatusBar");
    expect(styles).toMatch(/\.page-header::before/);
    expect(styles).toMatch(/\.status-bar/);
  });

  it("keeps top-level feature pages in a single module flow", () => {
    for (const page of ["settings", "adb", "apk", "docker"]) {
      expect(styles).toMatch(new RegExp(`\\.page-${page} \\.page-fade > div > \\.grid-2\\s*\\{[^}]*grid-template-columns: minmax\\(0, 1fr\\);`, "s"));
    }
    expect(styles).toMatch(/\.page-dashboard \.grid-2\s*,[\s\S]*\.page-dashboard \.grid-3/);
  });
});
