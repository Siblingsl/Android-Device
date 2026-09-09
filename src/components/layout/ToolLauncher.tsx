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
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useI18n } from "../../i18n";

type ToolItem = {
  to: string;
  labelKey: string;
  descriptionKey: string;
  icon: typeof LayoutDashboard;
};

const tools: ToolItem[] = [
  { to: "/", labelKey: "common.tool.dashboard", descriptionKey: "common.tool.dashboardHint", icon: LayoutDashboard },
  { to: "/devices", labelKey: "common.nav.devices", descriptionKey: "common.tool.devicesHint", icon: Smartphone },
  { to: "/devices", labelKey: "common.tool.filesApps", descriptionKey: "common.tool.filesAppsHint", icon: FileBox },
  { to: "/docker", labelKey: "common.nav.docker", descriptionKey: "common.tool.dockerHint", icon: Container },
  { to: "/adb", labelKey: "common.nav.adb", descriptionKey: "common.tool.adbHint", icon: Cable },
  { to: "/apk", labelKey: "common.nav.apk", descriptionKey: "common.tool.apkHint", icon: Package },
  { to: "/volumes", labelKey: "common.nav.volumes", descriptionKey: "common.tool.volumesHint", icon: Database },
  { to: "/monitor", labelKey: "common.nav.monitor", descriptionKey: "common.tool.monitorHint", icon: Activity },
  { to: "/logs", labelKey: "common.nav.logs", descriptionKey: "common.tool.logsHint", icon: ScrollText },
  { to: "/settings", labelKey: "common.nav.settings", descriptionKey: "common.tool.settingsHint", icon: Settings },
];

export function ToolLauncher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();

  return (
    <div className="tool-launcher-menu" role="menu" aria-label={t("common.tool.menuLabel")}>
      <div className="tool-launcher-heading">
        <span>{t("common.tool.menuTitle")}</span>
        <span className="tool-launcher-hint">{t("common.tool.menuHint")}</span>
      </div>
      <div className="tool-launcher-grid">
        {tools.map((tool, index) => {
          const Icon = tool.icon;
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
    </div>
  );
}
