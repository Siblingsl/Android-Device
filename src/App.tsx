import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { Dashboard } from "./pages/Dashboard";
import { Devices } from "./pages/Devices";
import { DeviceDetail } from "./pages/DeviceDetail";
import RuntimePage from "./pages/containers/RuntimePage";
import { AdbPage } from "./pages/Adb";
import { ApkPage } from "./pages/Apk";
import { VolumesPage } from "./pages/Volumes";
import { LogsPage } from "./pages/Logs";
import { MonitorAlertsPage } from "./pages/MonitorAlerts";
import { SettingsPage } from "./pages/Settings";
import { DeviceWindowPage } from "./pages/DeviceWindow";
import { TerminalPage } from "./pages/Terminal";
import { I18nProvider } from "./i18n";

export default function App() {
  const windowMode = new URLSearchParams(window.location.search).get("window");
  if (windowMode === "device") {
    return <I18nProvider><DeviceWindowPage /></I18nProvider>;
  }
  return (
    <I18nProvider>
      <HashRouter>
        <Routes>
          {/* Opened in a dedicated Tauri window; keep it free of the main shell. */}
          <Route path="terminal" element={<TerminalPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="devices" element={<Devices />} />
            <Route path="devices/:id" element={<DeviceDetail />} />
            <Route path="monitor" element={<MonitorAlertsPage />} />
            {/* Merged "containers & nodes" page; the track lives in ?track=. */}
            <Route path="containers" element={<RuntimePage />} />
            {/* Old deep links / bookmarks keep working: they land on the track
                they used to be. Kept permanently — no sidebar entries. */}
            <Route path="docker" element={<Navigate to="/containers?track=docker" replace />} />
            <Route path="qemu" element={<Navigate to="/containers?track=qemu" replace />} />
            <Route path="adb" element={<AdbPage />} />
            <Route path="apk" element={<ApkPage />} />
            <Route path="volumes" element={<VolumesPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </I18nProvider>
  );
}
