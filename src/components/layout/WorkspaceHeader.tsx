import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Languages, Moon, RefreshCw, Search, Settings2, SlidersHorizontal, Sun, Wrench } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import { ToolLauncher } from "./ToolLauncher";
import { openControlWindow } from "../../lib/controlWindow";

export function WorkspaceHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const { lang, setLang, t } = useI18n();
  const theme = useAppStore((s) => s.theme);
  const settings = useAppStore((s) => s.settings);
  const setTheme = useAppStore((s) => s.setTheme);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const devices = useAppStore((s) => s.devices);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const online = devices.filter((device) => device.online && device.adbStatus === "device").length;
  const attention = devices.filter((device) => device.adbStatus === "unauthorized" || device.adbStatus === "authorizing").length;

  const submitSearch = () => {
    const value = query.trim();
    try {
      sessionStorage.setItem("rdc.devices.query", value);
      sessionStorage.setItem("rdc.devices.filter", "all");
    } catch {
      /* storage is optional */
    }
    navigate("/devices");
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (settings) {
      void useAppStore.getState().saveSettings({ ...settings, theme: next }).catch(() => {
        setStatusText(t("common.settings.saveFailedShort"));
      });
    }
  };

  const refresh = async () => {
    await Promise.all([refreshStatus(), refreshDevices()]);
  };

  return (
    <header className="workspace-header">
      <button className="workspace-brand" type="button" onClick={() => navigate("/")} aria-label={t("common.tool.dashboard")}>
        <span className="workspace-mark">R</span>
        <span className="workspace-brand-copy">
          <span className="workspace-brand-title">Redroid</span>
          <span className="workspace-brand-subtitle">Device Center</span>
        </span>
      </button>

      <div className="workspace-context">
        <span className="workspace-context-kicker">{location.pathname === "/" ? t("common.workspace.overview") : t("common.workspace.tools")}</span>
        <span className="workspace-context-title">{t("common.workspace.deviceOperations")}</span>
      </div>

      <form className="workspace-search" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("common.workspace.searchDevices")}
          aria-label={t("common.workspace.searchDevices")}
        />
      </form>

      <div className="workspace-summary" aria-label={t("common.workspace.statusLabel")}>
        <button type="button" className="workspace-summary-item online" onClick={() => navigate("/devices")}>
          <span className="workspace-summary-dot" />
          <span>{online} {t("common.workspace.onlineShort")}</span>
        </button>
        {attention > 0 && (
          <button type="button" className="workspace-summary-item attention" onClick={() => navigate("/devices")}>
            <span className="workspace-summary-dot" />
            <span>{attention} {t("common.workspace.attentionShort")}</span>
          </button>
        )}
      </div>

      <div className="workspace-actions">
        <button
          className="workspace-icon-button"
          type="button"
          onClick={() => {
            const fallback = devices.find((device) => device.online && device.adbStatus === "device")?.id;
            void openControlWindow(selectedDeviceId ?? fallback, { title: t("controlWindow.title") });
          }}
          title={t("controlWindow.title")}
          aria-label={t("controlWindow.title")}
        >
          <SlidersHorizontal size={16} />
        </button>
        <button className="workspace-icon-button" type="button" onClick={() => void refresh()} title={t("common.refresh")} aria-label={t("common.refresh")}>
          <RefreshCw size={16} />
        </button>
        <div className="workspace-tool-wrap">
          <button
            className={`workspace-tool-button${toolsOpen ? " active" : ""}`}
            type="button"
            aria-expanded={toolsOpen}
            aria-haspopup="menu"
            onClick={() => setToolsOpen((open) => !open)}
          >
            <Wrench size={15} />
            <span>{t("common.tool.open")}</span>
            <ChevronDown size={14} />
          </button>
          {toolsOpen && <ToolLauncher onNavigate={() => setToolsOpen(false)} />}
        </div>
        <button className="workspace-icon-button" type="button" onClick={() => setLang(lang === "en-US" ? "zh-CN" : "en-US")} title={t("common.language")} aria-label={t("common.language")}>
          <Languages size={16} />
        </button>
        <button className="workspace-icon-button" type="button" onClick={toggleTheme} title={theme === "dark" ? t("common.lightTheme") : t("common.darkTheme")} aria-label={theme === "dark" ? t("common.lightTheme") : t("common.darkTheme")}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="workspace-icon-button" type="button" onClick={() => navigate("/settings")} title={t("common.nav.settings")} aria-label={t("common.nav.settings")}>
          <Settings2 size={16} />
        </button>
      </div>
    </header>
  );
}
