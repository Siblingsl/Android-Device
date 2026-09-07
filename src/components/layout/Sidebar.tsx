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
  Moon,
  Sun,
  Languages,
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
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const devices = useAppStore((s) => s.devices);
  const { lang, setLang, t } = useI18n();
  const online = devices.filter((d) => d.online && d.adbStatus === "device").length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">R</div>
        <div>
          <div className="brand-title">Redroid</div>
          <div className="brand-sub">Device Center</div>
        </div>
      </div>

      <nav className="nav">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            <item.icon size={18} strokeWidth={1.8} />
            <span>{t(item.key)}</span>
            {item.to === "/devices" && (
              <span
                className={online > 0 ? "ok" : "muted"}
                style={{ marginLeft: "auto", fontSize: 12 }}
                title={t("common.sidebar.adbReady", { n: online })}
              >
                {online}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className="theme-toggle"
          title={lang === "en-US" ? "切换到简体中文" : "Switch to English"}
          onClick={() => setLang(lang === "en-US" ? "zh-CN" : "en-US")}
        >
          <Languages size={16} />
          {lang === "en-US" ? "中文" : "EN"}
        </button>
        <button
          className="theme-toggle"
          onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            setTheme(next);
            if (settings) {
              void saveSettings({ ...settings, theme: next }).catch(() => {
                /* ignore */
              });
            }
          }}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          {theme === "dark" ? t("common.lightTheme") : t("common.darkTheme")}
        </button>
      </div>
    </aside>
  );
}
