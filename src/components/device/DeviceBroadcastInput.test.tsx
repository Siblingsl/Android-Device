// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceBroadcastInput } from "./DeviceBroadcastInput";

describe("DeviceBroadcastInput", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => {
    cleanup();
  });

  it("broadcasts entered text and clears it after success", async () => {
    const onText = vi.fn().mockResolvedValue(true);
    const onKey = vi.fn().mockResolvedValue(true);
    render(<DeviceBroadcastInput onText={onText} onKey={onKey} />);

    fireEvent.click(screen.getByText("广播输入"));
    fireEvent.change(screen.getByRole("textbox", { name: "广播文本" }), {
      target: { value: "hello devices" },
    });
    fireEvent.click(screen.getByRole("button", { name: "广播文本" }));

    expect(onText).toHaveBeenCalledWith("hello devices");
    const input = (await screen.findByRole("textbox", { name: "广播文本" })) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("maps common navigation buttons to Android key codes", async () => {
    const onText = vi.fn().mockResolvedValue(true);
    const onKey = vi.fn().mockResolvedValue(true);
    render(<DeviceBroadcastInput onText={onText} onKey={onKey} />);

    fireEvent.click(screen.getByText("广播输入"));
    fireEvent.click(screen.getByRole("button", { name: "广播 HOME" }));
    await waitFor(() => expect(onKey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "广播 BACK" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "广播 BACK" }));
    await waitFor(() => expect(onKey).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "广播 RECENT" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "广播 RECENT" }));
    await waitFor(() => expect(onKey).toHaveBeenCalledTimes(3));

    expect(onKey).toHaveBeenNthCalledWith(1, 3);
    expect(onKey).toHaveBeenNthCalledWith(2, 4);
    expect(onKey).toHaveBeenNthCalledWith(3, 187);
  });
});
