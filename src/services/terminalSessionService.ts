import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { friendlyError } from "../lib/errors";

export type TerminalKind = "device" | "local";
export type LocalShell = "powershell" | "cmd";

export interface TerminalStartRequest {
  kind: TerminalKind;
  serial: string;
  shell: LocalShell | "";
}

export interface TerminalSessionInfo {
  id: string;
  kind: TerminalKind;
  title: string;
  status: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  kind: "stdout" | "exit";
  data: string;
  status?: string | null;
  exitCode?: number | null;
}

export interface TerminalCommandResult {
  success: boolean;
  error: string;
}

const OUTPUT_EVENT = "terminal://output";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw friendlyError(error);
  }
}

export const TerminalSessionService = {
  start: (request: TerminalStartRequest) =>
    invoke<TerminalSessionInfo>("terminal_session_start", { request }),
  write: (id: string, data: string) =>
    invoke<TerminalCommandResult>("terminal_session_write", { id, data }),
  stop: (id: string) => invoke<TerminalCommandResult>("terminal_session_stop", { id }),
  list: () => invoke<TerminalSessionInfo[]>("terminal_session_list"),
  subscribe: (onOutput: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> =>
    tauriListen<TerminalOutputEvent>(OUTPUT_EVENT, (event) => onOutput(event.payload)),
};
