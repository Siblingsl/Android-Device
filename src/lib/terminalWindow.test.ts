import { beforeEach, describe, expect, it, vi } from "vitest";
import { openTerminalWindow } from "./terminalWindow";

const windowState = vi.hoisted(() => ({
  instances: [] as Array<{
    label: string;
    options: Record<string, unknown>;
    show: ReturnType<typeof vi.fn>;
    setFocus: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  getByLabel: vi.fn(),
}));

vi.mock("../services/terminalSessionService", () => ({
  TerminalSessionService: { stop: vi.fn() },
}));

const { TerminalSessionService } = await import("../services/terminalSessionService");

vi.mock("@tauri-apps/api/webviewWindow", () => {
  class FakeWebviewWindow {
    label: string;
    options: Record<string, unknown>;
    show = vi.fn(async () => {});
    setFocus = vi.fn(async () => {});
    private destroyedHandler: (() => void) | undefined;

    static getByLabel = windowState.getByLabel;

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      windowState.instances.push(this);
    }

    once = vi.fn(async (_event: string, handler: () => void) => {
      this.destroyedHandler = handler;
      return vi.fn();
    });

    destroy = vi.fn(async () => {
      this.destroyedHandler?.();
    });
  }

  return { WebviewWindow: FakeWebviewWindow };
});

describe("openTerminalWindow", () => {
  beforeEach(() => {
    windowState.instances.length = 0;
    windowState.getByLabel.mockReset();
    windowState.getByLabel.mockResolvedValue(null);
    vi.mocked(TerminalSessionService.stop).mockReset();
    vi.mocked(TerminalSessionService.stop).mockResolvedValue({ success: true, error: "" });
  });

  it("creates a dedicated terminal window with the session route", async () => {
    const created = await openTerminalWindow("session-1");

    expect(created.label).toBe("terminal-session-1");
    expect(windowState.instances).toHaveLength(1);
    expect(windowState.instances[0].options).toMatchObject({
      title: "独立终端",
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 420,
    });
    expect(windowState.instances[0].options.url).toContain("#/terminal?session=session-1");
    expect(windowState.instances[0].show).toHaveBeenCalledTimes(1);
    expect(windowState.instances[0].setFocus).toHaveBeenCalledTimes(1);
  });

  it("focuses an already-created terminal window instead of opening another one", async () => {
    const existing = {
      label: "terminal-existing",
      show: vi.fn(async () => {}),
      setFocus: vi.fn(async () => {}),
      once: vi.fn(async () => vi.fn()),
    };
    windowState.getByLabel.mockResolvedValueOnce(existing);

    const resolved = await openTerminalWindow("existing");

    expect(resolved).toBe(existing);
    expect(windowState.instances).toHaveLength(0);
    expect(existing.show).toHaveBeenCalledTimes(1);
    expect(existing.setFocus).toHaveBeenCalledTimes(1);
  });

  it("stops the matching session when its dedicated window is destroyed", async () => {
    await openTerminalWindow("session-close");

    await windowState.instances[0].destroy();

    expect(TerminalSessionService.stop).toHaveBeenCalledWith("session-close");
  });
});
