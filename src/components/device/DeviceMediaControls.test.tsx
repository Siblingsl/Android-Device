// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { DeviceMediaControls } from "./DeviceMediaControls";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
const { save } = await import("@tauri-apps/plugin-dialog");

const renderMedia = (overrides: Partial<React.ComponentProps<typeof DeviceMediaControls>> = {}) => {
  const props: React.ComponentProps<typeof DeviceMediaControls> = {
    onRecordingStart: vi.fn().mockResolvedValue(true),
    onRecordingStop: vi.fn().mockResolvedValue(true),
    onCameraStart: vi.fn().mockResolvedValue(true),
    onCameraStop: vi.fn().mockResolvedValue(true),
    onRotation: vi.fn().mockResolvedValue(true),
    onDeviceAction: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return { ...render(<I18nProvider><DeviceMediaControls {...props} /></I18nProvider>), props };
};

describe("DeviceMediaControls", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(save).mockResolvedValue("C:\\captures\\screen.mp4");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.mocked(save).mockReset();
  });

  it("starts a native recording with the selected output path and safe defaults", async () => {
    const { props } = renderMedia();
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(props.onRecordingStart).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expect.stringMatching(/\.mp4$/) }));
    expect(props.onRecordingStart).toHaveBeenCalledWith(expect.objectContaining({
      outputPath: "C:\\captures\\screen.mp4",
      format: "mp4",
      videoSource: "display",
      audio: false,
      audioOnly: false,
    }));
    expect(screen.getByText("录制中")).toBeTruthy();
  });

  it("keeps camera mirroring independent from the display mirror and exposes rotation/power actions", async () => {
    const { props } = renderMedia();
    fireEvent.click(screen.getByRole("button", { name: "启动摄像头镜像" }));
    await waitFor(() => expect(props.onCameraStart).toHaveBeenCalledWith(expect.objectContaining({
      cameraFacing: "back",
      cameraSize: "1920x1080",
    })));

    fireEvent.click(screen.getByRole("button", { name: "自动" }));
    await waitFor(() => expect(props.onRotation).toHaveBeenCalledWith("auto"));
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    await waitFor(() => expect(props.onDeviceAction).toHaveBeenCalledWith("mute"));
  });
});
