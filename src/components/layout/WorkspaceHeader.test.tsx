// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../i18n";
import { WorkspaceHeader } from "./WorkspaceHeader";

vi.mock("../../services/terminalSessionService", () => ({
  TerminalSessionService: { start: vi.fn() },
}));
vi.mock("../../lib/terminalWindow", () => ({ openTerminalWindow: vi.fn() }));

const { TerminalSessionService } = await import("../../services/terminalSessionService");
const { openTerminalWindow } = await import("../../lib/terminalWindow");

function TestShell({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <I18nProvider>{children}</I18nProvider>
    </MemoryRouter>
  );
}

describe("WorkspaceHeader", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(TerminalSessionService.start).mockResolvedValue({
      id: "session-local",
      kind: "local",
      title: "PowerShell",
      status: "running",
    });
    vi.mocked(openTerminalWindow).mockResolvedValue({} as never);
  });

  afterEach(() => cleanup());

  it("exposes the existing tools without rendering the old large sidebar", () => {
    render(<WorkspaceHeader />, { wrapper: TestShell });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));

    expect(screen.getByRole("link", { name: "设备中心" }).getAttribute("href")).toBe("/devices");
    expect(screen.getByRole("link", { name: "文件与应用" }).getAttribute("href")).toBe("/devices");
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  });

  it("opens a persistent local terminal in its own window", async () => {
    render(<WorkspaceHeader />, { wrapper: TestShell });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    fireEvent.click(screen.getByRole("button", { name: "终端" }));

    await waitFor(() => {
      expect(TerminalSessionService.start).toHaveBeenCalledWith({ kind: "local", serial: "", shell: "powershell" });
      expect(openTerminalWindow).toHaveBeenCalledWith("session-local", { title: "独立终端" });
    });
  });
});
