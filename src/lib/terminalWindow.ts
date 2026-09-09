import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TerminalSessionService } from "../services/terminalSessionService";

const terminalWindows = new Map<string, WebviewWindow>();
const pendingWindows = new Map<string, Promise<WebviewWindow>>();

function windowLabel(sessionId: string) {
  const safeId = sessionId.trim().replace(/[^a-zA-Z0-9_:/-]/g, "-");
  return `terminal-${safeId || "session"}`;
}

function terminalUrl(sessionId: string) {
  return `index.html#/terminal?session=${encodeURIComponent(sessionId)}`;
}

export async function openTerminalWindow(
  sessionId: string,
  options: { title?: string } = {},
): Promise<WebviewWindow> {
  const label = windowLabel(sessionId);
  const cached = terminalWindows.get(label);
  if (cached) {
    await cached.show();
    await cached.setFocus();
    return cached;
  }

  const pending = pendingWindows.get(label);
  if (pending) return pending;

  const opening = (async () => {
    const existing = await WebviewWindow.getByLabel(label);
    const terminalWindow = existing ?? new WebviewWindow(label, {
      url: terminalUrl(sessionId),
      title: options.title ?? "独立终端",
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 420,
      resizable: true,
      center: true,
      focus: true,
    });

    terminalWindows.set(label, terminalWindow);
    void terminalWindow.once("tauri://destroyed", () => {
      if (terminalWindows.get(label) === terminalWindow) terminalWindows.delete(label);
      void TerminalSessionService.stop(sessionId).catch(() => undefined);
    });
    await terminalWindow.show();
    await terminalWindow.setFocus();
    return terminalWindow;
  })();

  pendingWindows.set(label, opening);
  try {
    return await opening;
  } finally {
    if (pendingWindows.get(label) === opening) pendingWindows.delete(label);
  }
}
