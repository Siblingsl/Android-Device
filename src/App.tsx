import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { Dashboard } from "./pages/Dashboard";
import { Devices } from "./pages/Devices";
import { DeviceDetail } from "./pages/DeviceDetail";
import { DockerPage } from "./pages/Docker";
import { AdbPage } from "./pages/Adb";
import { ApkPage } from "./pages/Apk";
import { VolumesPage } from "./pages/Volumes";
import { LogsPage } from "./pages/Logs";
import { SettingsPage } from "./pages/Settings";
import { MonitorAlertsPage } from "./pages/MonitorAlerts";
import { TerminalPage } from "./pages/Terminal";
import { FloatingControlPage } from "./pages/FloatingControl";
import { AutomationPage } from "./pages/Automation";
import { CopilotPage } from "./pages/Copilot";
import { I18nProvider } from "./i18n";

export default function App() {
  return (
    <I18nProvider>
      <HashRouter>
        <Routes>
          <Route path="terminal" element={<TerminalPage />} />
          <Route path="control" element={<FloatingControlPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="devices" element={<Devices />} />
            <Route path="devices/:id" element={<DeviceDetail />} />
            <Route path="docker" element={<DockerPage />} />
            <Route path="adb" element={<AdbPage />} />
            <Route path="apk" element={<ApkPage />} />
            <Route path="volumes" element={<VolumesPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="monitor" element={<MonitorAlertsPage />} />
            <Route path="automation" element={<AutomationPage />} />
            <Route path="copilot" element={<CopilotPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </I18nProvider>
  );
}
