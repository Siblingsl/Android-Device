import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Smartphone,
  Container,
  Cable,
  Package,
  Database,
  ScrollText,
  Settings,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";

const items = [
  { to: "/", icon: LayoutDashboard, key: "common.nav.dashboard" },
  { to: "/devices", icon: Smartphone, key: "common.nav.devices" },
  { to: "/docker", icon: Container, key: "common.nav.docker" },
  { to: "/adb", icon: Cable, key: "common.nav.adb" },
  { to: "/apk", icon: Package, key: "common.nav.apk" },
  { to: "/volumes", icon: Database, key: "common.nav.volumes" },
  { to: "/logs", icon: ScrollText, key: "common.nav.logs" },
  { to: "/settings", icon: Settings, key: "common.nav.settings" },
];

export function Sidebar() {
  const devices = useAppStore((s) => s.devices);
  const { t } = useI18n();
  const online = devices.filter((d) => d.online && d.adbStatus === "device").length;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <NavLink to="/" className="brand" end>
          <div className="logo" aria-hidden="true"><span>J</span></div>
          <div className="brand-copy">
            <div className="brand-title">Just Run</div>
            <div className="brand-sub">Device tools <span className="brand-mark">/ simple</span></div>
          </div>
        </NavLink>

        <div className="topbar-tools">
          <nav className="nav" aria-label="Primary navigation">
            {items.slice(0, 2).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              >
                <item.icon size={16} strokeWidth={1.9} />
                <span>{t(item.key)}</span>
                {item.to === "/devices" && (
                  <span className={online > 0 ? "nav-count ok" : "nav-count muted"} title={t("common.sidebar.adbReady", { n: online })}>
                    {online}
                  </span>
                )}
              </NavLink>
            ))}
            {items.slice(2, 7).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              >
                <item.icon size={16} strokeWidth={1.9} />
                <span>{t(item.key)}</span>
              </NavLink>
            ))}
          </nav>

          <span className="topbar-divider" aria-hidden="true" />

          <div className="topbar-actions">
            <NavLink to="/settings" className="settings-link" title={t("common.nav.settings")}>
              <Settings size={16} />
            </NavLink>
          </div>
        </div>
      </div>
      <div className="topbar-rule" />
    </header>
  );
}
