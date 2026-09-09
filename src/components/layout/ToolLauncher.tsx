import {
  Activity,
  Cable,
  Container,
  Database,
  FileBox,
  LayoutDashboard,
  Package,
  ScrollText,
  Settings,
  Smartphone,
  SquareTerminal,
} from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useI18n } from "../../i18n";
import { TerminalSessionService } from "../../services/terminalSessionService";
import { openTerminalWindow } from "../../lib/terminalWindow";

type ToolItem = {
  kind: "link" | "terminal";
  to: string;
  labelKey: string;
  descriptionKey: string;
  icon: typeof LayoutDashboard;
};

const tools: ToolItem[] = [
  { kind: "link", to: "/", labelKey: "common.tool.dashboard", descriptionKey: "common.tool.dashboardHint", icon: LayoutDashboard },
  { kind: "link", to: "/devices", labelKey: "common.nav.devices", descriptionKey: "common.tool.devicesHint", icon: Smartphone },
  { kind: "link", to: "/devices", labelKey: "common.tool.filesApps", descriptionKey: "common.tool.filesAppsHint", icon: FileBox },
  { kind: "terminal", to: "", labelKey: "common.nav.terminal", descriptionKey: "common.tool.terminalHint", icon: SquareTerminal },
  { kind: "link", to: "/docker", labelKey: "common.nav.docker", descriptionKey: "common.tool.dockerHint", icon: Container },
  { kind: "link", to: "/adb", labelKey: "common.nav.adb", descriptionKey: "common.tool.adbHint", icon: Cable },
  { kind: "link", to: "/apk", labelKey: "common.nav.apk", descriptionKey: "common.tool.apkHint", icon: Package },
  { kind: "link", to: "/volumes", labelKey: "common.nav.volumes", descriptionKey: "common.tool.volumesHint", icon: Database },
  { kind: "link", to: "/monitor", labelKey: "common.nav.monitor", descriptionKey: "common.tool.monitorHint", icon: Activity },
  { kind: "link", to: "/logs", labelKey: "common.nav.logs", descriptionKey: "common.tool.logsHint", icon: ScrollText },
  { kind: "link", to: "/settings", labelKey: "common.nav.settings", descriptionKey: "common.tool.settingsHint", icon: Settings },
];

export function ToolLauncher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState("");

  const openLocalTerminal = async () => {
    if (terminalBusy) return;
    setTerminalBusy(true);
    setTerminalError("");
    try {
      const session = await TerminalSessionService.start({ kind: "local", serial: "", shell: "powershell" });
      await openTerminalWindow(session.id, { title: t("terminal.title") });
      onNavigate?.();
    } catch (cause) {
      setTerminalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTerminalBusy(false);
    }
  };

  return (
    <div className="tool-launcher-menu" role="menu" aria-label={t("common.tool.menuLabel")}>
      <div className="tool-launcher-heading">
        <span>{t("common.tool.menuTitle")}</span>
        <span className="tool-launcher-hint">{t("common.tool.menuHint")}</span>
      </div>
      <div className="tool-launcher-grid">
        {tools.map((tool, index) => {
          const Icon = tool.icon;
          if (tool.kind === "terminal") {
            return (
              <button
                key={`${tool.labelKey}-${index}`}
                type="button"
                aria-label={t(tool.labelKey)}
                className="tool-launcher-item"
                onClick={() => void openLocalTerminal()}
                disabled={terminalBusy}
              >
                <span className="tool-launcher-icon"><Icon size={16} strokeWidth={1.8} /></span>
                <span className="tool-launcher-copy">
                  <span className="tool-launcher-label">{t(tool.labelKey)}</span>
                  <span className="tool-launcher-description">{t(tool.descriptionKey)}</span>
                </span>
              </button>
            );
          }
          return (
            <NavLink
              key={`${tool.to}-${tool.labelKey}-${index}`}
              to={tool.to}
              aria-label={t(tool.labelKey)}
              className="tool-launcher-item"
              onClick={onNavigate}
            >
              <span className="tool-launcher-icon"><Icon size={16} strokeWidth={1.8} /></span>
              <span className="tool-launcher-copy">
                <span className="tool-launcher-label">{t(tool.labelKey)}</span>
                <span className="tool-launcher-description">{t(tool.descriptionKey)}</span>
              </span>
            </NavLink>
          );
        })}
      </div>
      {terminalError && <div className="tool-launcher-error" role="alert">{terminalError}</div>}
    </div>
  );
}
