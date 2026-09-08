import { create } from "zustand";
import type { AppSettings, DeviceInfo, SystemStatus } from "../types";
import { DeviceService } from "../services/deviceService";
import {
  appendMonitorAlert,
  clearMonitorAlertsBefore,
  hasRecentMonitorAlert,
  MAX_MONITOR_ALERT_HISTORY,
  MONITOR_ALERT_STORAGE_KEY,
  parseStoredMonitorAlerts,
  removeMonitorAlertsByIds,
  type MonitorAlert,
} from "../lib/monitorAlerts";

interface AppState {
  theme: "light" | "dark";
  detailOpen: boolean;
  selectedDeviceId: string | null;
  status: SystemStatus | null;
  devices: DeviceInfo[];
  monitorAlerts: MonitorAlert[];
  settings: AppSettings | null;
  loading: boolean;
  statusText: string;
  refreshing: boolean;
  setTheme: (theme: "light" | "dark") => void;
  setDetailOpen: (open: boolean) => void;
  setSelectedDeviceId: (id: string | null) => void;
  setStatusText: (text: string) => void;
  addMonitorAlert: (alert: MonitorAlert) => void;
  dismissMonitorAlert: (id: string) => void;
  dismissMonitorAlerts: (ids: string[]) => void;
  clearMonitorAlerts: (deviceId?: string) => void;
  clearMonitorAlertsBefore: (cutoff: number) => void;
  refreshStatus: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (s: AppSettings) => Promise<void>;
}

import { tStatic } from "../i18n";

let statusInFlight = false;
let devicesInFlight = false;
let statusFails = 0;
let deviceFails = 0;

let lastWasRefreshFail = false;

function readMonitorAlerts(): MonitorAlert[] {
  try {
    return parseStoredMonitorAlerts(localStorage.getItem(MONITOR_ALERT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function persistMonitorAlerts(alerts: MonitorAlert[]) {
  try {
    localStorage.setItem(MONITOR_ALERT_STORAGE_KEY, JSON.stringify(alerts));
  } catch {
    /* local persistence is best effort */
  }
}

function noteRefreshOk() {
  statusFails = 0;
  deviceFails = 0;
  if (lastWasRefreshFail) {
    lastWasRefreshFail = false;
    useAppStore.getState().setStatusText(tStatic("common.status.ready"));
  }
}

function noteRefreshFail(kind: string) {
  if (kind === "status") statusFails += 1;
  else deviceFails += 1;
  if (statusFails + deviceFails >= 2) {
    lastWasRefreshFail = true;
    useAppStore.getState().setStatusText(tStatic("common.status.refreshFailedRetry"));
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: "light",
  detailOpen: (() => {
    try {
      return localStorage.getItem("rdc.detailOpen") !== "0";
    } catch {
      return true;
    }
  })(),
  selectedDeviceId: (() => {
    try {
      return localStorage.getItem("rdc.selectedDeviceId");
    } catch {
      return null;
    }
  })(),
  status: null,
  devices: [],
  monitorAlerts: readMonitorAlerts(),
  settings: null,
  loading: false,
  statusText: tStatic("common.status.ready"),
  refreshing: false,

  setTheme: (theme) => {
    set({ theme });
    document.documentElement.setAttribute("data-theme", theme);
  },

  setDetailOpen: (detailOpen) => {
    set({ detailOpen });
    try {
      localStorage.setItem("rdc.detailOpen", detailOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  },
  setSelectedDeviceId: (selectedDeviceId) => {
    set({ selectedDeviceId });
    try {
      if (selectedDeviceId) localStorage.setItem("rdc.selectedDeviceId", selectedDeviceId);
    } catch {
      /* ignore */
    }
  },
  setStatusText: (statusText) => set({ statusText }),
  addMonitorAlert: (alert) =>
    set((state) => {
      if (hasRecentMonitorAlert(state.monitorAlerts, alert)) return state;
      const monitorAlerts = appendMonitorAlert(
        state.monitorAlerts,
        alert,
        MAX_MONITOR_ALERT_HISTORY,
      );
      persistMonitorAlerts(monitorAlerts);
      return { monitorAlerts };
    }),
  dismissMonitorAlert: (id) =>
    set((state) => {
      const monitorAlerts = state.monitorAlerts.filter((alert) => alert.id !== id);
      persistMonitorAlerts(monitorAlerts);
      return { monitorAlerts };
    }),
  dismissMonitorAlerts: (ids) =>
    set((state) => {
      const monitorAlerts = removeMonitorAlertsByIds(state.monitorAlerts, ids);
      if (monitorAlerts === state.monitorAlerts) return state;
      persistMonitorAlerts(monitorAlerts);
      return { monitorAlerts };
    }),
  clearMonitorAlerts: (deviceId) =>
    set((state) => {
      const monitorAlerts = deviceId
        ? state.monitorAlerts.filter((alert) => alert.deviceId !== deviceId)
        : [];
      persistMonitorAlerts(monitorAlerts);
      return { monitorAlerts };
    }),
  clearMonitorAlertsBefore: (cutoff) =>
    set((state) => {
      const monitorAlerts = clearMonitorAlertsBefore(state.monitorAlerts, cutoff);
      persistMonitorAlerts(monitorAlerts);
      return { monitorAlerts };
    }),

  refreshStatus: async () => {
    if (statusInFlight) return;
    statusInFlight = true;
    try {
      const status = await DeviceService.getSystemStatus();
      set({ status });
      statusFails = 0;
      if (deviceFails === 0) noteRefreshOk();
    } catch {
      noteRefreshFail("status");
    } finally {
      statusInFlight = false;
    }
  },

  refreshDevices: async () => {
    if (devicesInFlight) return;
    devicesInFlight = true;
    const hasData = get().devices.length > 0;
    if (!hasData) set({ loading: true });
    try {
      const devices = await DeviceService.listDevices();
      set({ devices, loading: false });
      deviceFails = 0;
      if (statusFails === 0) noteRefreshOk();
    } catch {
      set({ loading: false });
      noteRefreshFail("device");
    } finally {
      devicesInFlight = false;
    }
  },

  loadSettings: async () => {
    try {
      const settings = await DeviceService.getSettings();
      set({ settings, theme: settings.theme === "dark" ? "dark" : "light" });
      document.documentElement.setAttribute(
        "data-theme",
        settings.theme === "dark" ? "dark" : "light"
      );
    } catch {
      // Web preview / backend unavailable: fall back to client defaults so the
      // Settings page renders instead of hanging on the loading state.
      if (!get().settings) {
        set({
          settings: {
            theme: "light",
            language: "zh-CN",
            autoUpdate: true,
            logPath: "",
            screenshotPath: "",
            apkPath: "",
            proxy: "",
            dockerPath: "docker",
            adbPath: "adb",
            scrcpyPath: "scrcpy",
            gappsZipPath: "",
            installGapps: true,
            lastCpu: "2",
            lastRam: "2g",
            lastResolution: "1080x1920",
            lastDpi: "320",
            lastImage: "redroid/redroid:13.0.0-latest",
            autoStartDeviceIds: [],
            createAutoStart: false,
            createStayOnForm: false,
            createWaitAdb: true,
            resourceAlertThreshold: 80,
            deviceRefreshIntervalSecs: 10,
            deviceMonitorRules: {},
          },
        });
      }
    }
  },

  saveSettings: async (settings) => {
    const updated = await DeviceService.updateSettings(settings);
    set({ settings: updated });
    get().setTheme(updated.theme === "dark" ? "dark" : "light");
  },
}));
