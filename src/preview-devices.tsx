/**
 * Dev-only preview harness: mounts the real Devices page in a plain browser
 * with a mocked Tauri bridge, so the toolbar / grid layouts can be screened
 * without the desktop shell.
 *
 * URL params:
 *   ?view=cards|table   device list view (default table)
 *   ?panel=broadcast|layout|spoof   open one toolbar sub-panel after mount
 *   ?height=<px>        content viewport height (default 930)
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { mockInvoke as contractMockInvoke } from "./preview-devices.mock";
import "./styles/global.css";

type MockDevice = Record<string, unknown>;

const MOCK_DEVICES: MockDevice[] = [
  {
    id: "6d706def",
    name: "6d706def",
    serial: "6d706def",
    adbPort: 5555,
    ip: "—",
    online: false,
    adbStatus: "unauthorized",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "",
    cpu: "",
    ram: "",
    source: "adb",
  },
  {
    id: "redroid-14",
    name: "redroid14_x86_64",
    serial: "127.0.0.1:24500",
    adbPort: 24500,
    ip: "127.0.0.1",
    online: true,
    adbStatus: "device",
    dockerStatus: "running",
    scrcpyStatus: "stopped",
    containerId: "9f8fa852d6a35b401",
    image: "redroid/redroid:13.0.0-latest",
    dataVolume: "rdc-redroid-14-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    source: "docker",
  },
  {
    id: "2210132C",
    name: "2210132C",
    serial: "emulator-5554",
    adbPort: 5555,
    ip: "emulator-5554",
    online: true,
    adbStatus: "device",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "14",
    cpu: "x86_64",
    ram: "8G",
    source: "emulator",
  },
  {
    id: "redroid-3",
    name: "redroid-3",
    serial: "127.0.0.1:5556",
    adbPort: 5556,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "exited",
    scrcpyStatus: "stopped",
    containerId: "0af706be081f606b",
    image: "rdc-gapps:rdc-preset-redroid-redroid-13.0.0-latest-0af706be081f606b-7c704fe-6a8befd8",
    dataVolume: "rdc-redroid-3-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    source: "docker",
  },
  {
    id: "redroid-2",
    name: "redroid-2",
    serial: "127.0.0.1:5555",
    adbPort: 5555,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "exited",
    scrcpyStatus: "stopped",
    containerId: "89fa852d6a35b401",
    image: "rdc-gapps:rdc-preset-redroid-redroid-13.0.0-latest-89fa852d6a35b401-b7c04fe-6a8befd8",
    dataVolume: "rdc-redroid-2-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    source: "docker",
  },
  {
    id: "qemu-node-1",
    name: "node1-r13",
    serial: "127.0.0.1:24501",
    adbPort: 24501,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "6G",
    source: "qemu",
  },
];

const internals = window as unknown as Record<string, unknown>;
const callbackRegistry = new Set<number>();
const callbacks = new Map<number, unknown>();
const transformCallback = (callback: unknown) => {
  const id = window.crypto.getRandomValues(new Uint32Array(1))[0];
  callbackRegistry.add(id);
  callbacks.set(id, callback);
  return id;
};
const unregisterCallback = (id: number) => {
  callbackRegistry.delete(id);
  callbacks.delete(id);
};
const invoke = async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "plugin:app|version") return "0.1.0";
  if (cmd === "plugin:event|listen") {
    const handler = Number(args?.handler);
    callbackRegistry.add(handler);
    return handler;
  }
  if (cmd === "plugin:event|unlisten") {
    unregisterCallback(Number(args?.eventId));
    return null;
  }
  if (cmd === "plugin:event|emit") {
    const event = String(args?.event ?? "");
    for (const id of callbackRegistry) {
      const callback = callbacks.get(id);
      if (typeof callback === "function") callback({ event, id, payload: args?.payload });
    }
    return null;
  }
  return contractMockInvoke(cmd, args);
};
internals.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback,
  unregisterCallback,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
internals.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (_event: string, eventId: number) => unregisterCallback(eventId),
};

const params = new URLSearchParams(window.location.search);
// ?page=detail&id=<device id> renders the device detail page (defaults to the
// first mock device); otherwise the device center list is shown.
window.location.hash =
  params.get("page") === "detail"
    ? `#/devices/${params.get("id") ?? MOCK_DEVICES[0].id}`
    : "#/devices";
try {
  localStorage.setItem("rdc.devices.view", params.get("view") === "cards" ? "cards" : "table");
  sessionStorage.removeItem("rdc.devices.picked");
} catch {
  /* ignore */
}

function openPanel(panel: string) {
  // 批量伪装 needs a selection to enable its toggle; pick the first device row.
  if (panel === "spoof") {
    const checkbox = document.querySelector<HTMLInputElement>(
      ".device-session-check input[type=checkbox], .device-grid input[type=checkbox]",
    );
    if (checkbox && !checkbox.checked) checkbox.click();
  }
  const label = panel === "broadcast" ? "广播输入" : panel === "layout" ? "投屏布局" : "批量伪装";
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const target = buttons.find(
    (button) => (button.textContent || "").replace(/\s/g, "").includes(label) && !button.disabled,
  );
  // Idempotent: repeated calls must not toggle the panel back closed.
  const expanded =
    target && (target.getAttribute("aria-expanded") === "true" || target.getAttribute("aria-pressed") === "true");
  if (target && !expanded) target.click();
  else if (!target) console.warn("preview: toggle not found for", label);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

const panel = params.get("panel");
if (panel) {
  window.setTimeout(() => openPanel(panel), 600);
  window.setTimeout(() => openPanel(panel), 1200);
}
