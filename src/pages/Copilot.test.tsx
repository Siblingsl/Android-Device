// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { COPILOT_POLICY_STORAGE_KEY } from "../lib/copilotPolicy";
import { CopilotPage } from "./Copilot";

vi.mock("../services/copilotService", () => ({
  requestCopilotCompletion: vi.fn().mockResolvedValue({ content: "已读取设备状态。", toolCalls: [] }),
}));
vi.mock("../services/copilotToolExecutor", () => ({
  executeCopilotToolCall: vi.fn().mockResolvedValue("工具执行成功"),
}));

const { requestCopilotCompletion } = await import("../services/copilotService");
const { executeCopilotToolCall } = await import("../services/copilotToolExecutor");

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

  it("persists tool permissions and receives an assistant response", async () => {
    render(<TestShell />);

    fireEvent.click(screen.getByRole("checkbox", { name: "安装 APK" }));
    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
    fireEvent.change(screen.getByRole("textbox", { name: "助手请求" }), { target: { value: "查看当前设备状态" } });
    fireEvent.click(screen.getByRole("button", { name: "发送请求" }));

    expect(screen.getByText("查看当前设备状态")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(COPILOT_POLICY_STORAGE_KEY) ?? "{}")).toEqual(
        expect.objectContaining({ allowedToolIds: expect.arrayContaining(["device.installApk"]) }),
    );
    await vi.waitFor(() => expect(screen.getByText("已读取设备状态。")).toBeTruthy());
    expect(requestCopilotCompletion).toHaveBeenCalled();
  });

  it("does not execute a write tool until the user confirms it", async () => {
    vi.mocked(requestCopilotCompletion).mockResolvedValueOnce({
      content: "我准备启动应用，需要确认。",
      toolCalls: [{ id: "call-1", toolId: "device.startApp", args: { packageName: "com.demo" } }],
    });
    vi.mocked(executeCopilotToolCall).mockClear();
    render(<TestShell />);

    fireEvent.click(screen.getByRole("checkbox", { name: "启动应用" }));
    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
    fireEvent.change(screen.getByRole("textbox", { name: "助手请求" }), { target: { value: "启动应用" } });
    fireEvent.click(screen.getByRole("button", { name: "发送请求" }));

    await vi.waitFor(() => expect(screen.getByText("等待人工确认")).toBeTruthy());
    expect(executeCopilotToolCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await vi.waitFor(() => expect(executeCopilotToolCall).toHaveBeenCalled());
  });
});
