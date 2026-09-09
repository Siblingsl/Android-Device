import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalSessionService } from "./terminalSessionService";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("TerminalSessionService", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("starts a device session with the serial nested in the request", async () => {
    const session = { id: "session-1", kind: "device", title: "ADB Shell · emulator-5554", status: "running" };
    vi.mocked(invoke).mockResolvedValueOnce(session);

    await expect(
      TerminalSessionService.start({ kind: "device", serial: "emulator-5554", shell: "" }),
    ).resolves.toEqual(session);

    expect(invoke).toHaveBeenCalledWith("terminal_session_start", {
      request: { kind: "device", serial: "emulator-5554", shell: "" },
    });
  });

  it("maps write, stop and list without changing the legacy one-shot shell", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ success: true, error: "" })
      .mockResolvedValueOnce({ success: true, error: "" })
      .mockResolvedValueOnce([]);

    await TerminalSessionService.write("session-1", "pwd\r");
    await TerminalSessionService.stop("session-1");
    await TerminalSessionService.list();

    expect(invoke).toHaveBeenNthCalledWith(1, "terminal_session_write", {
      id: "session-1",
      data: "pwd\r",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "terminal_session_stop", { id: "session-1" });
    expect(invoke).toHaveBeenNthCalledWith(3, "terminal_session_list", undefined);
  });

  it("subscribes to the shared output event and forwards payloads", async () => {
    const unlisten = vi.fn();
    const output = { sessionId: "session-1", kind: "stdout", data: "ready\r\n", status: null, exitCode: null };
    let callback: ((event: { payload: typeof output }) => void) | undefined;
    vi.mocked(listen).mockImplementationOnce(async (_event, next) => {
      callback = next as typeof callback;
      return unlisten;
    });
    const onOutput = vi.fn();

    const cleanup = await TerminalSessionService.subscribe(onOutput);
    callback?.({ payload: output });

    expect(listen).toHaveBeenCalledWith("terminal://output", expect.any(Function));
    expect(onOutput).toHaveBeenCalledWith(output);
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
