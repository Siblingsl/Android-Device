// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Keep the store before i18n/component imports: the store calls tStatic while
// initializing, and the dictionaries must be initialized before that cycle.
import { useAppStore } from "../../stores/appStore";
import { WindowControls, WindowDragRegion, WindowResizeHandles } from "./WindowControls";
import { I18nProvider } from "../../i18n";

const { currentWindow, getCurrentWindow } = vi.hoisted(() => {
  const currentWindow = {
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    minimize: vi.fn().mockResolvedValue(undefined),
    onScaleChanged: vi.fn().mockResolvedValue(() => undefined),
    onResized: vi.fn().mockResolvedValue(() => undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    startResizeDragging: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
  };
  return { currentWindow, getCurrentWindow: vi.fn(() => currentWindow) };
});

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

function renderControls() {
  return render(
    <I18nProvider>
      <WindowControls />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("rdc.lang", "zh-CN");
  useAppStore.setState({ settings: undefined });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  vi.clearAllMocks();
  currentWindow.isMaximized.mockResolvedValue(false);
  currentWindow.onScaleChanged.mockResolvedValue(() => undefined);
  currentWindow.onResized.mockResolvedValue(() => undefined);
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("rdc.lang");
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("WindowControls", () => {
  it("controls the current Tauri window", async () => {
    renderControls();

    fireEvent.click(await screen.findByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(currentWindow.minimize).toHaveBeenCalledOnce();
    expect(currentWindow.toggleMaximize).toHaveBeenCalledOnce();
    expect(currentWindow.close).toHaveBeenCalledOnce();
  });

  it("switches the maximize button to restore after the window maximizes", async () => {
    let resizeHandler: (() => void) | undefined;
    currentWindow.onResized.mockImplementation(async (handler: () => void) => {
      resizeHandler = handler;
      return () => undefined;
    });
    renderControls();
    await screen.findByRole("button", { name: "最大化" });

    currentWindow.isMaximized.mockResolvedValue(true);
    resizeHandler?.();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();
    });
  });

  it("starts native dragging and toggles maximize on the drag region", () => {
    render(<WindowDragRegion />);
    const region = screen.getByTestId("window-drag-region");

    fireEvent.mouseDown(region, { button: 0 });
    fireEvent.doubleClick(region);

    expect(currentWindow.startDragging).toHaveBeenCalledOnce();
    expect(currentWindow.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("starts native resizing from each edge and corner", () => {
    render(<WindowResizeHandles />);
    const handles = [
      ["n", "North"],
      ["ne", "NorthEast"],
      ["e", "East"],
      ["se", "SouthEast"],
      ["s", "South"],
      ["sw", "SouthWest"],
      ["w", "West"],
      ["nw", "NorthWest"],
    ] as const;

    for (const [name] of handles) {
      fireEvent.mouseDown(screen.getByTestId(`window-resize-${name}`), { button: 0 });
    }

    expect(currentWindow.startResizeDragging).toHaveBeenCalledTimes(handles.length);
    handles.forEach(([, direction], index) => {
      expect(currentWindow.startResizeDragging).toHaveBeenNthCalledWith(index + 1, direction);
    });
  });

  it("cleans up native resize and scale listeners on unmount", async () => {
    const resizeCleanup = vi.fn();
    const scaleCleanup = vi.fn();
    currentWindow.onResized.mockResolvedValue(resizeCleanup);
    currentWindow.onScaleChanged.mockResolvedValue(scaleCleanup);
    const view = renderControls();
    await screen.findByRole("button", { name: "最大化" });

    view.unmount();

    expect(resizeCleanup).toHaveBeenCalledOnce();
    expect(scaleCleanup).toHaveBeenCalledOnce();
  });
});
