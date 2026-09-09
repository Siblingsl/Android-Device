// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { DeviceService } from "../services/deviceService";
import { UpdateCenterPage } from "./UpdateCenter";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
  },
}));

function TestShell() {
  return <MemoryRouter><I18nProvider><UpdateCenterPage /></I18nProvider></MemoryRouter>;
}

describe("UpdateCenterPage", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(DeviceService.checkForUpdates).mockReset();
    vi.mocked(DeviceService.downloadUpdate).mockReset();
  });

  afterEach(() => cleanup());

  it("checks the configured release source and exposes a real asset download", async () => {
    vi.mocked(DeviceService.checkForUpdates).mockResolvedValue({
      currentVersion: "0.1.0",
      updateAvailable: true,
      latest: {
        tagName: "v0.2.0",
        name: "0.2.0",
        body: "修复与优化",
        htmlUrl: "https://github.com/Siblingsl/Android-Device/releases/tag/v0.2.0",
        publishedAt: "2026-09-09T00:00:00Z",
        assets: [{ name: "Android-Device-0.2.0.exe", size: 1024, downloadUrl: "https://github.com/Siblingsl/Android-Device/releases/download/v0.2.0/Android-Device-0.2.0.exe" }],
      },
    });
    vi.mocked(DeviceService.downloadUpdate).mockResolvedValue("C:\\\\Users\\\\User\\\\Downloads\\\\Android-Device-0.2.0.exe");
    render(<TestShell />);

    expect(screen.getByRole("heading", { name: "更新中心" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("发现新版本 v0.2.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下载 Android-Device-0.2.0.exe" }));
    await vi.waitFor(() => expect(DeviceService.downloadUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: "Android-Device-0.2.0.exe" })));
  });

  it("shows a safe no-release state when the source has no published release", async () => {
    vi.mocked(DeviceService.checkForUpdates).mockResolvedValue({
      currentVersion: "0.1.0",
      updateAvailable: false,
      latest: null,
    });
    render(<TestShell />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("当前没有可用 Release")).toBeTruthy();
  });

  it("keeps a documentation entry available", () => {
    render(<TestShell />);

    expect(screen.getByRole("link", { name: "打开项目文档" }).getAttribute("href")).toBe("https://github.com/Siblingsl/Android-Device");
  });
});
