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
    vi.clearAllMocks();
  });

  it("restores the requested session and renders matching output events", async () => {
    renderTerminal();

    expect(await screen.findByText(session.title)).toBeTruthy();
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
    await screen.findByText(session.title);
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
});
