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
    expect(detail).toMatch(/className="[^"]*detail-module[^"]*"/);
    expect(detail).toContain('className="detail-overview-panes"');
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

  it("keeps top-level feature pages aligned in paired module columns", () => {
    for (const page of ["settings", "adb", "apk", "docker"]) {
      expect(styles).toMatch(new RegExp(`\\.page-${page} \\.page-fade > div > \\.grid-2\\s*\\{[^}]*grid-template-columns:(?! minmax\\(0, 1fr\\);)[^;]+;`, "s"));
    }
    expect(styles).toMatch(/\.page-dashboard \.grid-2\s*,[\s\S]*\.page-dashboard \.grid-3/);
  });

  it("keeps Dashboard paired cards on the stat-grid split", () => {
    expect(styles).toMatch(
      /\.page-dashboard \.grid-stats\s*,\s*\.page-dashboard \.grid-2\s*\{[^}]*--dashboard-grid-gap:\s*7px;[^}]*--dashboard-stat-column:\s*calc\(\(100% - var\(--dashboard-grid-gap\) - var\(--dashboard-grid-gap\)\) \/ 3\);/s,
    );
    expect(styles).toMatch(
      /\.page-dashboard \.grid-2\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*calc\(var\(--dashboard-stat-column\) \+ var\(--dashboard-stat-column\) \+ var\(--dashboard-grid-gap\)\)\)\s+minmax\(0,\s*1fr\);[^}]*column-gap:\s*var\(--dashboard-grid-gap\);/s,
    );
  });

  it("keeps the Dashboard recent row on the same stat-grid rails", () => {
    // The 3-up recent row shares the stat rail: the same 7px gap token and
    // three equal columns, so every vertical split lines up with the rows above.
    expect(styles).toMatch(
      /\.page-dashboard \.grid-stats\s*,\s*\.page-dashboard \.grid-2\s*,\s*\.page-dashboard \.grid-3\s*\{[^}]*--dashboard-grid-gap:\s*7px;/s,
    );
    for (const block of styles.match(/\.page-dashboard \.grid-3\s*\{[^}]*\}/gs) ?? []) {
      expect(block).not.toMatch(/grid-template-columns:\s*[^;]*fr/);
    }
    expect(styles).toMatch(
      /\.page-dashboard \.grid-3\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(/\.page-dashboard \.grid-3\s*\{[^}]*gap:\s*var\(--dashboard-grid-gap\);\s*\}/s);
  });

  it("keeps device columns aligned across the table header and rows", () => {
    expect(styles).toMatch(/\.devices-table \{[^}]*table-layout:\s*fixed;/s);
    expect(styles).toMatch(/\.devices-table \.device-list-table-head \{[^}]*display:\s*table-row;/s);
    expect(styles).toMatch(/\.device-grid \{[^}]*grid-template-columns:\s*repeat\(auto-fit/s);
    expect(styles).toMatch(/\.detail-overview-panes \{[^}]*grid-template-columns:/s);
  });

  it("keeps device-scoped feature panels reachable from their workspaces", () => {
    expect(detail).toContain("KeyboardMappingPanel");
    expect(detail).toContain("AutomationPanel");
    expect(detail).toContain("AgentPanel");
    expect(detail).toContain("GnirehtetPanel");
    expect(detail).toContain("DeviceMetadataPanel");
    const devices = read("src/pages/Devices.tsx");
    expect(devices).toContain("ArrangementDialog");
    expect(devices).toContain("窗口编排");
  });

  it("keeps the standalone terminal window route reachable", () => {
    const app = read("src/App.tsx");
    expect(app).toContain('import { TerminalPage } from "./pages/Terminal";');
    expect(app).toContain('<Route path="terminal" element={<TerminalPage />} />');
    expect(read("src/pages/Terminal.tsx")).toContain("TerminalSessionService.subscribe");
  });

  it("keeps the persisted monitor alert workspace reachable", () => {
    const app = read("src/App.tsx");
    const sidebar = read("src/components/layout/Sidebar.tsx");
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(app).toContain('import { MonitorAlertsPage } from "./pages/MonitorAlerts";');
    expect(app).toContain('<Route path="monitor" element={<MonitorAlertsPage />} />');
    expect(sidebar).not.toContain('to: "/monitor"');
    expect(sidebar).not.toContain('key: "common.nav.monitor"');
    expect(dashboard).toContain('dashboard.card.monitorAlerts');
    expect(dashboard).toContain('navigate("/monitor")');
  });
});
