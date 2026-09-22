import { existsSync, readFileSync } from "node:fs";
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

  it("keeps all seven detail tabs in the new tab rail", () => {
    for (const key of ["overview", "control", "files", "apps", "logs", "spoof", "settings"]) {
      expect(detail).toContain(`"${key}"`);
    }
    expect(detail).toContain("detail-workspace-head");
    expect(detail).toContain("detail-tab-status");
  });

  it("gives spoofing and self-audit their own detail workspace", () => {
    expect(detail).toContain('type Tab = "overview" | "control" | "files" | "apps" | "logs" | "spoof" | "settings";');
    expect(detail).toContain('["spoof", "detail.tab.spoof", true]');
    expect(detail).toContain('{tab === "spoof" && (');
    expect(detail).toMatch(
      /className="detail-spoof-workspace"[\s\S]{0,500}<SpoofCard[\s\S]{0,300}<AuditCard/,
    );
    const settingsBranch = detail.match(/\{tab === "settings" && \(([\s\S]*?)\n        \)\}/)?.[1] ?? "";
    expect(settingsBranch).not.toContain("<SpoofCard");
    expect(settingsBranch).not.toContain("<AuditCard");
    expect(styles).toMatch(
      /\.detail-spoof-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*9px;/s,
    );
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
    expect(styles).toMatch(/\.module-head\s*\{[^}]*min-height:\s*40px/s);
    expect(styles).toMatch(/\.module-head\s*\{[^}]*padding:\s*0 14px/s);
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

  it("removes the global Quick look drawer", () => {
    const layout = read("src/components/layout/AppLayout.tsx");
    const store = read("src/stores/appStore.ts");
    const preview = read("src/preview-devices.tsx");
    const common = read("src/i18n/pages/common.ts");

    expect(layout).not.toContain("DetailPanel");
    expect(layout).not.toContain("detailOpen");
    expect(store).not.toContain("detailOpen");
    expect(preview).not.toContain("detailOpen");
    expect(common).not.toContain('"common.detailPanel"');
    expect(common).not.toContain('"common.panel.expand"');
    expect(common).not.toContain('"common.panel.collapse"');
    expect(common).not.toContain('"common.panel.openDetail"');
    expect(styles).not.toContain(".detail-drawer");
    expect(styles).not.toContain(".detail-toggle");
    expect(existsSync(resolve(root, "src/components/layout/DetailPanel.tsx"))).toBe(false);
  });

  it("keeps top-level feature pages aligned in paired module columns", () => {
    for (const page of ["settings", "adb", "apk", "docker"]) {
      expect(styles).toMatch(new RegExp(`\\.page-${page} \\.page-fade > div > \\.grid-2\\s*\\{[^}]*grid-template-columns:(?! minmax\\(0, 1fr\\);)[^;]+;`, "s"));
    }
    expect(styles).toMatch(/\.page-dashboard \.grid-2\s*,[\s\S]*\.page-dashboard \.grid-3/);
  });

  it("keeps Dashboard paired cards on the stat-grid split", () => {
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
    // No fractional-fr column weights: only the shared 1fr thirds.
    for (const block of styles.match(/\.page-dashboard \.grid-3\s*\{[^}]*\}/gs) ?? []) {
      expect(block).not.toMatch(/grid-template-columns:[^;]*\.\d+fr/);
    }
    expect(styles).toMatch(
      /\.page-dashboard \.grid-3\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(/\.page-dashboard \.grid-3\s*\{[^}]*gap:\s*var\(--dashboard-grid-gap\);\s*\}/s);
  });

  it("fills the available width on wide viewports", () => {
    expect(styles).toMatch(/--content-max:\s*100%;/);
  });

  it("hosts every devices toolbar panel in one shared row", () => {
    const devices = read("src/pages/Devices.tsx");
    // Action rail: primary batch actions first, utilities after, toggles pinned right.
    expect(devices).toContain('className="devices-batch-group is-primary"');
    expect(devices).toContain('className="devices-batch-group is-utility"');
    expect(devices).toContain('className="devices-batch-panel-toggles"');
    // Broadcast and mirror layout are toggles + one shared panel row, so the
    // button rows never reflow when a panel opens.
    expect(devices).not.toContain("batch-layout-details");
    expect(devices).not.toContain("devices-toolbar-advanced");
    expect(devices).toContain('className="devices-toolbar-panel"');
    expect(devices).toContain('variant="panel"');
    // Panel toggles travel as one indivisible unit in the wrapping flow —
    // never pinned to the rail edge (margin-left auto), never split apart.
    expect(styles).toMatch(/\.devices-batch-panel-toggles\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).not.toMatch(/\.devices-batch-panel-toggles\s*\{[^}]*margin-left:\s*auto/);
    expect(styles).toMatch(/\.devices-toolbar-panel\s*\{[^}]*border-left:\s*2px solid var\(--violet\);/s);
    // Responsive action rail: groups are flattened so individual buttons wrap
    // one-by-one on shared rails, never whole-group onto a ragged second line.
    expect(styles).toMatch(/\.devices-batch-rail\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*6px;/s);
    expect(styles).toMatch(/\.devices-batch-group\s*\{\s*display:\s*contents;\s*\}/);
  });

  it("keeps device grid cards on shared internal rails", () => {
    expect(styles).toMatch(/\.device-grid \{[^}]*align-items:\s*stretch;/s);
    expect(styles).toMatch(
      /\.device-grid \.module-body > div:first-child > \.meta-grid \{ margin-top: auto; \}/,
    );
    // Long runtime strings truncate instead of changing the card height.
    expect(styles).toMatch(/\.device-grid \.device-meta-value\s*\{[^}]*white-space:\s*nowrap;/s);
  });

  it("keeps device columns aligned across the table header and rows", () => {
    expect(styles).toMatch(/\.devices-table \{[^}]*table-layout:\s*fixed;/s);
    expect(styles).toMatch(/\.devices-table \.device-list-table-head \{[^}]*display:\s*table-row;/s);
    expect(styles).toMatch(/\.device-grid \{[^}]*grid-template-columns:\s*repeat\(auto-fit/s);
    expect(styles).toMatch(/\.detail-overview-panes \{[^}]*grid-template-columns:/s);
  });

  it("keeps detail overview panes equal-height and root actions on one rail", () => {
    expect(detail).toContain('className="row detail-root-actions"');
    expect(styles).toMatch(/\.detail-overview-panes\s*\{[^}]*align-items:\s*stretch;/s);
    expect(styles).toMatch(
      /\.detail-root-module > \.module-head > \.row\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*6px;[^}]*margin-left:\s*auto;[^}]*overflow-x:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.detail-root-module > \.module-head > \.row > \.btn\s*\{[^}]*flex:\s*0 0 auto;/s,
    );
  });

  it("keeps the Root panel title compact enough for its action rail", () => {
    const translations = read("src/i18n/pages/deviceDetail.ts");
    expect(translations).toContain('"detail.root.title": "Root / 伪装",');
    expect(translations).toContain('"detail.root.title": "Root / spoofing",');
  });

  it("gives the control preview its own collapsible row and symmetric module grid", () => {
    expect(detail).toContain('className="control-preview-row"');
    expect(detail).toContain('label={t("detail.control.previewTitle")}');
    expect(detail).toContain("open={previewOpen}");
    expect(styles).toMatch(
      /\.detail-control-workspace\.split-control\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*10px;/s,
    );
    expect(styles).toMatch(
      /\.detail-control-workspace \.control-action-dock\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*align-items:\s*stretch;/s,
    );
    expect(styles).toMatch(
      /\.detail-control-assistants\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*align-items:\s*stretch;/s,
    );
  });

  it("keeps the apps system filter compact and horizontal", () => {
    expect(detail).toContain('className="app-system-toggle"');
    expect(styles).toMatch(
      /\.app-filter-main\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.app-system-toggle\s*\{[^}]*display:\s*inline-flex;[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s,
    );
  });

  it("keeps device-scoped feature panels reachable from their workspaces", () => {
    expect(detail).toContain("KeyboardMappingPanel");
    expect(detail).toContain("AutomationPanel");
    expect(detail).toContain("AgentPanel");
    expect(detail).toContain("GnirehtetPanel");
    expect(detail).toContain("DeviceMetadataPanel");
  });

  it("keeps the standalone terminal window route reachable", () => {
    const app = read("src/App.tsx");
    expect(app).toContain('const TerminalPage = lazy(() => import("./pages/Terminal")');
    expect(app).toContain('import { lazy, Suspense } from "react";');
    expect(app).toContain('<Suspense fallback={null}>');
    expect(app).not.toContain('import { TerminalPage } from "./pages/Terminal";');
    expect(app).toContain('<Route path="terminal" element={<TerminalPage />} />');
    expect(read("src/pages/Terminal.tsx")).toContain("TerminalSessionService.subscribe");
  });

  it("keeps monitor alerts out of Dashboard while preserving their workspace", () => {
    const app = read("src/App.tsx");
    const sidebar = read("src/components/layout/Sidebar.tsx");
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(app).toContain('const MonitorAlertsPage = lazy(() => import("./pages/MonitorAlerts")');
    expect(app).not.toContain('import { MonitorAlertsPage } from "./pages/MonitorAlerts";');
    expect(app).toContain('<Route path="monitor" element={<MonitorAlertsPage />} />');
    expect(sidebar).not.toContain('to: "/monitor"');
    expect(sidebar).not.toContain('key: "common.nav.monitor"');
    expect(dashboard).not.toContain('dashboard.card.monitorAlerts');
    expect(dashboard).not.toContain('navigate("/monitor")');
    expect(read("src/pages/MonitorAlerts.tsx")).toContain("monitorAlerts");
  });
});
