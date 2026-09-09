// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { DeviceShell } from "./DeviceShell";

vi.mock("../../services/deviceService", () => ({
  DeviceService: { shell: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })) },
}));

describe("DeviceShell", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => cleanup());

  it("keeps the one-shot shell and exposes an optional persistent terminal action", () => {
    const onOpenTerminal = vi.fn();
    render(
      <I18nProvider>
        <DeviceShell serial="emulator-5554" onStatus={vi.fn()} onOpenTerminal={onOpenTerminal} />
      </I18nProvider>,
    );

    expect(screen.getByText("ADB Shell")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });
});
