// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { DeviceService } from "../services/deviceService";
import { FloatingControlPage } from "./FloatingControl";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => {
    throw new Error("Tauri window API is unavailable in browser preview");
  }),
}));

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn(),
  },
}));

describe("FloatingControlPage", () => {
 beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
   vi.mocked(DeviceService.listDevices).mockResolvedValue([]);
 });

  afterEach(() => cleanup());

  it("still renders a usable control window shell without the Tauri backend", async () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <FloatingControlPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "浮动控制" })).toBeTruthy();
    expect(await screen.findByText("暂无设备")).toBeTruthy();
  });
});
