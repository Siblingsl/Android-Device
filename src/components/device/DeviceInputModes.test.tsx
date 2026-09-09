// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { DeviceInputModes } from "./DeviceInputModes";

const renderInput = (overrides: Partial<React.ComponentProps<typeof DeviceInputModes>> = {}) => {
  const props: React.ComponentProps<typeof DeviceInputModes> = {
    onStart: vi.fn().mockResolvedValue(true),
    onStop: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return { ...render(<I18nProvider><DeviceInputModes {...props} /></I18nProvider>), props };
};

describe("DeviceInputModes", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("starts UHID with keyboard and mouse enabled by default", async () => {
    const { props } = renderInput();
    fireEvent.click(screen.getByRole("button", { name: "启动输入控制" }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith("uhid", {
      keyboard: true,
      mouse: true,
      gamepad: false,
    }));
    expect(screen.getByText("输入控制已运行")).toBeTruthy();
  });

  it("allows explicit OTG gamepad selection and stops the same native process", async () => {
    const { props } = renderInput();
    fireEvent.change(screen.getByRole("combobox", { name: "控制模式" }), { target: { value: "otg" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "手柄" }));
    fireEvent.click(screen.getByRole("button", { name: "启动输入控制" }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith("otg", {
      keyboard: true,
      mouse: true,
      gamepad: true,
    }));
    fireEvent.click(screen.getByRole("button", { name: "停止输入控制" }));
    await waitFor(() => expect(props.onStop).toHaveBeenCalledTimes(1));
  });
});
