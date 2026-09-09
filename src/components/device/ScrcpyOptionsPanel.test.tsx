// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ScrcpyOptionsPanel } from "./ScrcpyOptionsPanel";

describe("ScrcpyOptionsPanel", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("updates a visual option without dropping an advanced custom argument", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ScrcpyOptionsPanel
          args="--max-size 1440 --video-bit-rate 16M --video-codec=h264 --display-id 1"
          onChange={onChange}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("常用参数"));
    fireEvent.change(screen.getByRole("combobox", { name: "画面长边" }), { target: { value: "720" } });

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("--max-size 720"));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("--video-codec=h264"));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("--display-id 1"));
    expect(onChange).toHaveBeenLastCalledWith(expect.not.stringContaining("--max-size 1440"));
  });

  it("maps control and audio switches to scrcpy flags", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ScrcpyOptionsPanel args="--max-size 1080 --video-bit-rate 8M --no-audio" onChange={onChange} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("常用参数"));
    fireEvent.click(screen.getByRole("checkbox", { name: "允许控制" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("--no-control"));

    fireEvent.click(screen.getByRole("checkbox", { name: "开启音频" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("--audio-source=output"));
    expect(onChange).toHaveBeenLastCalledWith(expect.not.stringContaining("--no-audio"));
  });
});
