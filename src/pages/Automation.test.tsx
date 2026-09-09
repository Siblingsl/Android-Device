// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { AUTOMATION_STORAGE_KEY, defaultAutomationScript } from "../lib/automation";
import { AutomationPage } from "./Automation";

vi.mock("../services/automationService", () => ({
  createDeviceAutomationRuntime: vi.fn(() => ({})),
}));
vi.mock("../lib/automationRunner", () => ({
  runAutomationScript: vi.fn().mockResolvedValue({ status: "completed", completedSteps: 2, logs: [] }),
}));

const { runAutomationScript } = await import("../lib/automationRunner");

function TestShell() {
  return (
    <MemoryRouter>
      <I18nProvider>
        <AutomationPage />
      </I18nProvider>
    </MemoryRouter>
  );
}

describe("AutomationPage", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    localStorage.setItem(AUTOMATION_STORAGE_KEY, JSON.stringify([defaultAutomationScript()]));
  });

  afterEach(() => cleanup());

  it("renders the compact script workbench and selected step details", () => {
    render(<TestShell />);

    expect(screen.getByRole("heading", { name: "自动化脚本" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "设备巡检示例" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "等待设备稳定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "等待设备稳定" })).toBeTruthy();
  });

  it("creates a script and persists the edited name", () => {
    render(<TestShell />);

    fireEvent.click(screen.getAllByRole("button", { name: "新建脚本" })[0]);
    const name = screen.getByRole("textbox", { name: "脚本名称" });
    fireEvent.change(name, { target: { value: "批量巡检" } });
    fireEvent.click(screen.getByRole("button", { name: "保存脚本" }));

    expect(screen.getByRole("heading", { name: "批量巡检" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) ?? "[]")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "批量巡检" })]),
    );
  });

  it("runs the selected script for the entered device serial", async () => {
    render(<TestShell />);

    fireEvent.change(screen.getByRole("textbox", { name: "执行设备" }), { target: { value: "serial-1" } });
    fireEvent.click(screen.getByRole("button", { name: "运行脚本" }));

    await vi.waitFor(() => expect(runAutomationScript).toHaveBeenCalledWith(
      expect.objectContaining({ name: "设备巡检示例" }),
      "serial-1",
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });
});
