import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { I18nProvider } from "./i18n";

const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Devices = lazy(() => import("./pages/Devices").then((m) => ({ default: m.Devices })));
const DeviceDetail = lazy(() => import("./pages/DeviceDetail").then((m) => ({ default: m.DeviceDetail })));
const RuntimePage = lazy(() => import("./pages/containers/RuntimePage"));
const AdbPage = lazy(() => import("./pages/Adb").then((m) => ({ default: m.AdbPage })));
const ApkPage = lazy(() => import("./pages/Apk").then((m) => ({ default: m.ApkPage })));
const VolumesPage = lazy(() => import("./pages/Volumes").then((m) => ({ default: m.VolumesPage })));
const LogsPage = lazy(() => import("./pages/Logs").then((m) => ({ default: m.LogsPage })));
const MonitorAlertsPage = lazy(() => import("./pages/MonitorAlerts").then((m) => ({ default: m.MonitorAlertsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const TerminalPage = lazy(() => import("./pages/Terminal").then((m) => ({ default: m.TerminalPage })));

export default function App() {
  return (
    <I18nProvider>
      <HashRouter>
        <Suspense fallback={null}>
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
        </Suspense>
      </HashRouter>
    </I18nProvider>
  );
}
