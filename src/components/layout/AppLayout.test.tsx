// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "./AppLayout";
import type { GlobalShortcutStatus } from "../../lib/globalShortcuts";

const storeState = vi.hoisted(() => ({
  detailOpen: false,
  settings: null,
  devices: [],
  loadSettings: vi.fn().mockResolvedValue(undefined),
  refreshStatus: vi.fn().mockResolvedValue(undefined),
  refreshDevices: vi.fn().mockResolvedValue(undefined),
  setStatusText: vi.fn(),
}));

const managerState = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

const nativeStatus: GlobalShortcutStatus = {
  available: true,
  enabled: true,
  registered: ["openDashboard", "openDevices", "openTerminal", "refreshWorkspace", "openSettings"],
  failed: {},
};

vi.mock("../../stores/appStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../../services/deviceService", () => ({ DeviceService: {} }));
vi.mock("../../lib/globalShortcuts", () => ({
  GLOBAL_SHORTCUTS_CHANGED_EVENT: "rdc:global-shortcuts-changed",
  readGlobalShortcutsEnabled: vi.fn(() => true),
  readShortcuts: vi.fn(() => ({
    openDashboard: "Ctrl+1",
    openDevices: "Ctrl+2",
    openTerminal: "Ctrl+3",
    refreshWorkspace: "Ctrl+R",
    openSettings: "Ctrl+,",
  })),
  registerGlobalShortcuts: managerState.register,
  unregisterGlobalShortcuts: managerState.unregister,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock("./StatusBar", () => ({ StatusBar: () => <div data-testid="status-bar" /> }));
vi.mock("./DetailPanel", () => ({ DetailPanel: () => <div data-testid="detail-panel" /> }));
vi.mock("./WorkspaceHeader", () => ({ WorkspaceHeader: () => <div data-testid="workspace-header" /> }));
vi.mock("./ActivityDrawer", () => ({ ActivityDrawer: () => <div data-testid="activity-drawer" /> }));

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<div>dashboard</div>} />
          <Route path="devices" element={<div>devices</div>} />
          <Route path="terminal" element={<div>terminal</div>} />
          <Route path="settings" element={<div>settings</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout global shortcuts", () => {
  beforeEach(() => {
    managerState.register.mockReset().mockResolvedValue(nativeStatus);
    managerState.unregister.mockReset().mockResolvedValue(undefined);
    storeState.loadSettings.mockClear();
    storeState.refreshStatus.mockClear();
    storeState.refreshDevices.mockClear();
  });

  afterEach(() => cleanup());

  it("registers configured shortcuts on mount and unregisters on unmount", async () => {
    const view = renderLayout();

    await waitFor(() => expect(managerState.register).toHaveBeenCalledTimes(1));
    view.unmount();

    expect(managerState.unregister).toHaveBeenCalledTimes(1);
  });

  it("re-registers after the settings page broadcasts a shortcut change", async () => {
    renderLayout();
    await waitFor(() => expect(managerState.register).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event("rdc:global-shortcuts-changed"));

    await waitFor(() => expect(managerState.register).toHaveBeenCalledTimes(2));
  });

  it("uses the shared action mapping for native and in-window triggers", async () => {
    renderLayout();
    await waitFor(() => expect(managerState.register).toHaveBeenCalledTimes(1));
    const onAction = managerState.register.mock.calls[0][2] as (action: string) => void;

    onAction("openDevices");
    expect(await screen.findByText("devices")).toBeTruthy();

    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(await screen.findByText("terminal")).toBeTruthy();
  });
});
