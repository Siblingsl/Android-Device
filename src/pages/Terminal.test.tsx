// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TerminalPage } from "./Terminal";

vi.mock("../services/terminalSessionService", () => ({
  TerminalSessionService: {
    list: vi.fn(),
    subscribe: vi.fn(),
    write: vi.fn(),
    stop: vi.fn(),
  },
}));

const { TerminalSessionService } = await import("../services/terminalSessionService");

const session = {
  id: "session-1",
  kind: "device" as const,
  title: "ADB Shell · emulator-5554",
  status: "running",
};
const secondSession = {
  id: "session-2",
  kind: "local" as const,
  title: "PowerShell",
  status: "running",
};

function renderTerminal() {
  return render(
    <MemoryRouter initialEntries={["/terminal?session=session-1"]}>
      <Routes>
        <Route path="/terminal" element={<TerminalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TerminalPage", () => {
  let onOutput: ((event: { sessionId: string; kind: "stdout" | "exit"; data: string; status?: string | null }) => void) | undefined;

  beforeEach(() => {
    onOutput = undefined;
    vi.mocked(TerminalSessionService.list).mockResolvedValue([session]);
    vi.mocked(TerminalSessionService.subscribe).mockImplementation(async (callback) => {
      onOutput = callback;
      return vi.fn();
    });
    vi.mocked(TerminalSessionService.write).mockResolvedValue({ success: true, error: "" });
    vi.mocked(TerminalSessionService.stop).mockResolvedValue({ success: true, error: "" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("restores the requested session and renders matching output events", async () => {
    renderTerminal();

    expect(document.querySelector(".terminal-workbench")).toBeTruthy();
    expect(await screen.findByText(session.title, { selector: ".terminal-title" })).toBeTruthy();
    expect(TerminalSessionService.list).toHaveBeenCalledTimes(1);
    expect(TerminalSessionService.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      onOutput?.({ sessionId: session.id, kind: "stdout", data: "hello from adb\r\n" });
      onOutput?.({ sessionId: "other-session", kind: "stdout", data: "ignore me" });
    });

    expect(screen.getByRole("log").textContent).toContain("hello from adb");
    expect(screen.getByRole("log").textContent).not.toContain("ignore me");
  });

  it("writes a command with a carriage return when Enter is pressed", async () => {
    renderTerminal();
    await screen.findByText(session.title, { selector: ".terminal-title" });
    const input = await screen.findByRole("textbox", { name: /终端命令|terminal command/i });

    fireEvent.change(input, { target: { value: "getprop ro.build.version.release" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(TerminalSessionService.write).toHaveBeenCalledWith(
        session.id,
        "getprop ro.build.version.release\r",
      );
    });
  });

  it("switches to another active session from the compact session selector", async () => {
    vi.mocked(TerminalSessionService.list).mockResolvedValue([session, secondSession]);
    renderTerminal();

    expect(await screen.findByText(session.title, { selector: ".terminal-title" })).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: /会话|session/i });

    fireEvent.change(selector, { target: { value: secondSession.id } });

    expect(await screen.findByText(secondSession.title, { selector: ".terminal-title" })).toBeTruthy();
    expect((selector as HTMLSelectElement).value).toBe(secondSession.id);
  });

  it("recalls successfully sent commands with the arrow keys", async () => {
    renderTerminal();
    await screen.findByText(session.title, { selector: ".terminal-title" });
    const input = await screen.findByRole("textbox", { name: /终端命令|terminal command/i });

    fireEvent.change(input, { target: { value: "first command" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(TerminalSessionService.write).toHaveBeenCalledWith(session.id, "first command\r"));

    fireEvent.change(input, { target: { value: "second command" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(TerminalSessionService.write).toHaveBeenCalledWith(session.id, "second command\r"));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("second command");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("first command");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((input as HTMLInputElement).value).toBe("second command");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("refreshes the session status while the terminal is open", async () => {
    vi.useFakeTimers();
    vi.mocked(TerminalSessionService.list)
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([{ ...session, status: "exited" }]);
    renderTerminal();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("运行中")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("已停止 · exited")).toBeTruthy();
    expect(TerminalSessionService.list).toHaveBeenCalledTimes(2);
  });
});
