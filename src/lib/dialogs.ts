import { ask, message } from "@tauri-apps/plugin-dialog";

/**
 * WebView2's script dialogs (window.confirm/alert) are suppressed when the
 * host window is minimized and auto-resolve, which once let a delete run
 * without any visible confirmation. These wrappers use the Tauri dialog
 * plugin instead — native, top-level, and unaffected by window state.
 */
export async function askConfirm(text: string): Promise<boolean> {
  try {
    return await ask(text, {
      title: "Redroid Device Center",
      kind: "warning",
    });
  } catch {
    return window.confirm(text);
  }
}

export async function alertMsg(text: string): Promise<void> {
  try {
    await message(text, {
      title: "Redroid Device Center",
      kind: "error",
    });
  } catch {
    window.alert(text);
  }
}
