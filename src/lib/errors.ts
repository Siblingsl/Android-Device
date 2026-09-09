import { tStatic } from "../i18n/static";

/**
 * Map raw internal exceptions to user-friendly messages.
 * The most common case: running the frontend outside Tauri, where
 * `window.__TAURI_INTERNALS__` is undefined and invoke() throws a raw
 * "Cannot read properties of undefined (reading 'invoke')".
 */
export function friendlyError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (msg.includes("reading 'invoke'") || msg.includes("__TAURI")) {
    return new Error(tStatic("common.backendUnavailable"));
  }
  return e instanceof Error ? e : new Error(msg);
}
