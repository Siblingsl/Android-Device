// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { AUTOMATION_STORAGE_KEY, defaultAutomationScript } from "../lib/automation";
import { AutomationPage } from "./Automation";

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
});
