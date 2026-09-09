// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { COPILOT_POLICY_STORAGE_KEY } from "../lib/copilotPolicy";
import { CopilotPage } from "./Copilot";

function TestShell() {
  return <MemoryRouter><I18nProvider><CopilotPage /></I18nProvider></MemoryRouter>;
}

describe("CopilotPage", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
  });
  afterEach(() => cleanup());

  it("renders the compact conversation and safe tool policy surface", () => {
    render(<TestShell />);

    expect(screen.getByRole("heading", { name: "AI 助手" })).toBeTruthy();
    expect(screen.getByText("读取设备列表")).toBeTruthy();
    expect(screen.getByText("危险 Shell 命令已默认拦截")).toBeTruthy();
  });

  it("persists tool permissions and adds a user request to the conversation", () => {
    render(<TestShell />);

    fireEvent.click(screen.getByRole("checkbox", { name: "安装 APK" }));
    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
    fireEvent.change(screen.getByRole("textbox", { name: "助手请求" }), { target: { value: "查看当前设备状态" } });
    fireEvent.click(screen.getByRole("button", { name: "发送请求" }));

    expect(screen.getByText("查看当前设备状态")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(COPILOT_POLICY_STORAGE_KEY) ?? "{}")).toEqual(
        expect.objectContaining({ allowedToolIds: expect.arrayContaining(["device.installApk"]) }),
    );
  });
});
